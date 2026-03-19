import * as fs from 'fs';
import * as path from 'path';

/**
 * A contract declares what environment variables a service requires.
 * The builder validates and maps the composed variable pool against each contract,
 * then generates a .env file at the service's location.
 *
 * Two contract formats are supported:
 *
 * **New format (vars):** Uses `${component.KEY}` references for direct resolution.
 *   { "vars": { "REDIS_URL": "${redis.JOB_QUEUE_URL}" }, "defaults": { ... } }
 *
 * **Legacy format (required/optional/secret):** Uses NAMESPACE-prefixed flat pool.
 *   { "required": { "REDIS_URL": "REDIS_JOB_QUEUE_URL" }, ... }
 */
export interface ServiceDevConfig {
  command: string;       // Shell command to run (e.g., "pnpm dev")
  cwd?: string;          // Working directory (defaults to location)
  label?: string;        // Pane display name (defaults to uppercase name)
}

export interface ContractTarget {
  type: 'docker-compose';    // Future: other target types
  file: string;              // Path to file (e.g., "docker-compose.yml")
  service: string;           // Service name within the file
  config?: Record<string, unknown>;  // Service config (image, ports, volumes, etc.)
  profileOverrides?: Record<string, Record<string, unknown>>;  // Per-profile config overrides (shallow merge per key)
}

export interface ServiceContract {
  name: string;
  location?: string;         // Where to write the .env file (e.g., "apps/api")
  target?: ContractTarget;   // Alternative to location — write into a target file

  // Profile filtering: only include this contract when building these ce profiles.
  // If omitted, the contract is included for all profiles.
  onlyProfiles?: string[];

  // Var set inheritance: merge named var sets into this contract's vars.
  // Resolves *.vars.json files from env/contracts/. Contract's own vars win on conflict.
  includeVars?: string[];

  // New format: ${component.KEY} mappings
  vars?: Record<string, string>;

  // Legacy format: flat pool mappings
  required?: Record<string, string>;
  optional?: Record<string, string>;
  secret?: Record<string, string>;

  defaults?: Record<string, string>;
  dev?: ServiceDevConfig; // How to run this service locally (for ce start)
}

/**
 * Detect whether a contract uses the new `vars` format or legacy `required` format.
 */
export function isNewFormatContract(contract: ServiceContract): boolean {
  return contract.vars !== undefined;
}

export class ContractManager {
  private contractsDir: string;
  private contracts: Map<string, ServiceContract> = new Map();

  constructor(configDir: string, envDir: string = 'env') {
    this.contractsDir = path.join(configDir, envDir, 'contracts');
  }

  async initialize(): Promise<void> {
    await this.loadContracts();
    this.resolveAllIncludeVars();
  }

  /**
   * Check if any loaded contract uses the new vars format.
   */
  hasNewFormatContracts(): boolean {
    for (const contract of this.contracts.values()) {
      if (isNewFormatContract(contract)) return true;
    }
    return false;
  }

  private async loadContracts(): Promise<void> {
    if (!fs.existsSync(this.contractsDir)) {
      return;
    }

    const files = fs.readdirSync(this.contractsDir);

    for (const file of files.filter(f => f.endsWith('.contract.json'))) {
      try {
        const filePath = path.join(this.contractsDir, file);
        const serviceName = file.replace(/\.contract\.json$/, '');
        const contract: ServiceContract = JSON.parse(
          fs.readFileSync(filePath, 'utf8')
        );

        // Validate: contract must have at least one output destination
        if (!contract.location && !contract.target) {
          throw new Error(
            `Contract '${serviceName}' must have 'location', 'target', or both.`
          );
        }
        if (contract.target) {
          if (contract.target.type !== 'docker-compose') {
            throw new Error(
              `Contract '${serviceName}' has unsupported target type '${contract.target.type}'. Supported: docker-compose`
            );
          }
          if (!contract.target.file || !contract.target.service) {
            throw new Error(
              `Contract '${serviceName}' target requires both 'file' and 'service' fields.`
            );
          }
        }

        this.contracts.set(serviceName, contract);

        // Log deprecation warning for legacy contracts
        if (!isNewFormatContract(contract) && contract.required) {
          console.warn(
            `⚠️  Contract '${serviceName}' uses legacy format (required/optional/secret). ` +
            `Migrate to 'vars' format with: ce migrate`
          );
        }
      } catch (err: unknown) {
        console.warn(
          `Failed to load contract ${file}:`,
          err instanceof Error ? err.message : String(err)
        );
      }
    }

    for (const file of files.filter(f => f.endsWith('.contract.ts') || f.endsWith('.contract.js'))) {
      try {
        const filePath = path.join(this.contractsDir, file);
        const serviceName = file.replace(/\.contract\.(ts|js)$/, '');

        if (this.contracts.has(serviceName)) continue;

        const module = await import(filePath);
        const pascalCaseName = serviceName
          .split('-')
          .map(part => part.charAt(0).toUpperCase() + part.slice(1))
          .join('');
        const exportName = `${pascalCaseName}Contract`;
        const contract = module[exportName] || module.default;

        if (contract) {
          this.contracts.set(serviceName, contract);
        } else {
          console.warn(
            `Contract file ${file} does not export '${exportName}'. Skipping.`
          );
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('Unknown file extension') && file.endsWith('.ts')) {
          console.warn(
            `Cannot load ${file} — Node.js cannot import .ts files directly.\n` +
            `  Use .contract.json instead, or run with tsx/jiti.`
          );
        } else {
          console.warn(`Failed to load contract ${file}:`, msg);
        }
      }
    }
  }

  // ─── includeVars resolution ──────────────────────────────────────────────

  /**
   * Load a var set from env/contracts/{name}.vars.json.
   * Var sets contain { vars: Record<string, string>, includeVars?: string[] }.
   */
  private loadVarSet(name: string): { vars: Record<string, string>; includeVars?: string[] } {
    const filePath = path.join(this.contractsDir, `${name}.vars.json`);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Var set '${name}' not found at ${filePath}`);
    }
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  }

  /**
   * Resolve a var set's includes recursively, returning merged vars.
   * Detects cycles. Includes merge left-to-right, then the set's own vars on top.
   */
  private resolveVarSet(
    name: string,
    visited: Set<string> = new Set()
  ): Record<string, string> {
    if (visited.has(name)) {
      throw new Error(
        `Circular includeVars: ${[...visited].join(' → ')} → ${name}`
      );
    }
    visited.add(name);

    const varSet = this.loadVarSet(name);
    let merged: Record<string, string> = {};

    // Resolve chained includes first
    if (varSet.includeVars) {
      for (const include of varSet.includeVars) {
        const resolved = this.resolveVarSet(include, new Set(visited));
        merged = { ...merged, ...resolved };
      }
    }

    // Own vars win on conflict
    merged = { ...merged, ...varSet.vars };
    return merged;
  }

  /**
   * For every loaded contract with includeVars, resolve and merge the var sets
   * into the contract's vars. Contract's own vars always win.
   */
  private resolveAllIncludeVars(): void {
    for (const [serviceName, contract] of this.contracts) {
      if (!contract.includeVars || contract.includeVars.length === 0) continue;

      let merged: Record<string, string> = {};

      for (const include of contract.includeVars) {
        try {
          const resolved = this.resolveVarSet(include);
          merged = { ...merged, ...resolved };
        } catch (err) {
          console.warn(
            `Failed to resolve includeVars '${include}' for contract '${serviceName}':`,
            err instanceof Error ? err.message : String(err)
          );
        }
      }

      // Contract's own vars win on conflict
      contract.vars = { ...merged, ...(contract.vars || {}) };
    }
  }

  // ─── New format: vars-based validation and mapping ────────────────────────

  /**
   * Validate a new-format contract against the component pool.
   * Component pool is Map<componentName, Record<key, value>>.
   */
  validateVarsContract(
    serviceName: string,
    componentPool: Map<string, Record<string, string>>
  ): { valid: boolean; missing: string[]; warnings: string[] } {
    const contract = this.contracts.get(serviceName);
    if (!contract || !contract.vars) {
      return { valid: true, missing: [], warnings: [] };
    }

    const missing: string[] = [];
    const warnings: string[] = [];

    for (const [appVar, ref] of Object.entries(contract.vars)) {
      const resolved = this.resolveComponentRef(ref, componentPool);
      if (resolved === undefined) {
        // If it's in defaults, it's optional
        if (contract.defaults?.[appVar] !== undefined) {
          warnings.push(`${ref} not resolved, using default for ${appVar}: ${contract.defaults[appVar]}`);
        } else {
          missing.push(`${ref} (needed for ${appVar})`);
        }
      }
    }

    return { valid: missing.length === 0, missing, warnings };
  }

  /**
   * Map a new-format contract's vars to resolved values using the component pool.
   */
  mapVarsContract(
    serviceName: string,
    componentPool: Map<string, Record<string, string>>
  ): Record<string, string> {
    const contract = this.contracts.get(serviceName);
    if (!contract || !contract.vars) return {};

    const serviceVars: Record<string, string> = {};

    for (const [appVar, ref] of Object.entries(contract.vars)) {
      const value = this.resolveComponentRef(ref, componentPool);
      if (value !== undefined) {
        serviceVars[appVar] = value;
      } else if (contract.defaults?.[appVar] !== undefined) {
        serviceVars[appVar] = contract.defaults[appVar];
      }
    }

    // Apply remaining defaults not in vars
    if (contract.defaults) {
      for (const [appVar, defaultValue] of Object.entries(contract.defaults)) {
        if (serviceVars[appVar] === undefined) {
          serviceVars[appVar] = defaultValue;
        }
      }
    }

    return serviceVars;
  }

  /**
   * Resolve a ${component.KEY} reference (or template with multiple refs)
   * against the component pool.
   *
   * Examples:
   *   "${redis.JOB_QUEUE_URL}" → looks up redis component, key JOB_QUEUE_URL
   *   "${secrets.REDIS_URL}" → looks up secrets namespace
   *   "postgresql://${database.USER}:${secrets.DB_PASSWORD}@${database.HOST}:5432/${database.NAME}"
   */
  private resolveComponentRef(
    ref: string,
    componentPool: Map<string, Record<string, string>>
  ): string | undefined {
    if (!/\$\{([^}]+)\}/.test(ref)) {
      // Plain string value (no references) — return as-is
      return ref;
    }

    const resolved = ref.replace(/\$\{([^}]+)\}/g, (match, qualifiedKey: string) => {
      const dotIdx = qualifiedKey.indexOf('.');
      if (dotIdx === -1) {
        // Not a component.KEY reference — leave unresolved
        return match;
      }

      const componentName = qualifiedKey.slice(0, dotIdx);
      const key = qualifiedKey.slice(dotIdx + 1);
      const component = componentPool.get(componentName);
      if (component && key in component) {
        return component[key];
      }

      return match; // Leave unresolved
    });

    // Only return if fully resolved (no remaining ${...})
    return /\$\{([^}]+)\}/.test(resolved) ? undefined : resolved;
  }

  // ─── Legacy format: flat pool validation and mapping ──────────────────────

  /**
   * Validate that all required variables for a service are present in the pool.
   * Legacy format only.
   */
  validateContract(
    serviceName: string,
    systemVars: Record<string, string>
  ): { valid: boolean; missing: string[]; warnings: string[] } {
    const contract = this.contracts.get(serviceName);
    if (!contract) {
      return {
        valid: true,
        missing: [],
        warnings: [`No contract found for service: ${serviceName}`],
      };
    }

    // Route to new validation if contract uses vars format
    if (isNewFormatContract(contract)) {
      // Caller should use validateVarsContract instead — this is a fallback
      return { valid: true, missing: [], warnings: [] };
    }

    const missing: string[] = [];
    const warnings: string[] = [];

    if (contract.required) {
      for (const [appVar, systemVar] of Object.entries(contract.required)) {
        const resolved = this.resolveMapping(systemVar, systemVars);
        if (resolved === undefined) {
          missing.push(`${systemVar} (needed for ${appVar})`);
        }
      }
    }

    if (contract.secret) {
      for (const [appVar, systemVar] of Object.entries(contract.secret)) {
        const resolved = this.resolveMapping(systemVar, systemVars);
        if (resolved === undefined) {
          missing.push(`${systemVar} (needed for secret ${appVar})`);
        }
      }
    }

    if (contract.optional) {
      for (const [appVar, systemVar] of Object.entries(contract.optional)) {
        if (!(systemVar in systemVars) && contract.defaults?.[appVar]) {
          warnings.push(
            `${systemVar} not set, using default for ${appVar}: ${contract.defaults[appVar]}`
          );
        }
      }
    }

    return { valid: missing.length === 0, missing, warnings };
  }

  /**
   * Map the resolved variable pool to a service's own variable names.
   * Supports direct mapping and template strings: "${HOST}:${PORT}"
   * Legacy format only.
   */
  mapContractVariables(
    serviceName: string,
    systemVars: Record<string, string>
  ): Record<string, string> {
    const contract = this.contracts.get(serviceName);
    if (!contract) return {};

    const serviceVars: Record<string, string> = {};

    if (contract.required) {
      for (const [appVar, systemVar] of Object.entries(contract.required)) {
        const value = this.resolveMapping(systemVar, systemVars);
        if (value !== undefined) serviceVars[appVar] = value;
      }
    }

    if (contract.optional) {
      for (const [appVar, systemVar] of Object.entries(contract.optional)) {
        const value = this.resolveMapping(systemVar, systemVars);
        if (value !== undefined) {
          serviceVars[appVar] = value;
        } else if (contract.defaults?.[appVar]) {
          serviceVars[appVar] = contract.defaults[appVar];
        }
      }
    }

    if (contract.secret) {
      for (const [appVar, systemVar] of Object.entries(contract.secret)) {
        const value = this.resolveMapping(systemVar, systemVars);
        if (value !== undefined) serviceVars[appVar] = value;
      }
    }

    if (contract.defaults) {
      for (const [appVar, defaultValue] of Object.entries(contract.defaults)) {
        if (serviceVars[appVar] === undefined) {
          serviceVars[appVar] = defaultValue;
        }
      }
    }

    return serviceVars;
  }

  /**
   * Resolve a single var name, supporting fallback chains: "VAR1 : VAR2 : VAR3"
   */
  private resolveVariable(varName: string, systemVars: Record<string, string>): string | undefined {
    if (varName.includes(':')) {
      const candidates = varName.split(':').map(v => v.trim());
      for (const candidate of candidates) {
        const value = candidate in systemVars ? systemVars[candidate] : process.env[candidate];
        if (value !== undefined && value !== '') return value;
      }
      return undefined;
    }
    return varName in systemVars ? systemVars[varName] : process.env[varName];
  }

  /**
   * Resolve a mapping — direct variable name or template "${HOST}:${PORT}"
   */
  private resolveMapping(mapping: string, systemVars: Record<string, string>): string | undefined {
    if (/\$\{([^}]+)\}/.test(mapping)) {
      const resolved = mapping.replace(/\$\{([^}]+)\}/g, (match, varName) => {
        const value = this.resolveVariable(varName, systemVars);
        return value !== undefined ? value : match;
      });
      return /\$\{([^}]+)\}/.test(resolved) ? undefined : resolved;
    }
    return systemVars[mapping];
  }

  getContracts(): Map<string, ServiceContract> {
    return this.contracts;
  }
}
