import * as fs from 'fs';
import * as path from 'path';

/**
 * A contract declares what environment variables a service requires.
 * The builder validates and maps the composed variable pool against each contract,
 * then generates a .env file at the service's location.
 */
export interface ServiceContract {
  name: string;
  location?: string; // Where to write the .env file (e.g., "apps/api")
  required: Record<string, string>; // app_var: system_var or template mapping
  optional?: Record<string, string>;
  secret?: Record<string, string>; // Sensitive vars (included in same .env file)
  defaults?: Record<string, string>;
}

export class ContractManager {
  private contractsDir: string;
  private contracts: Map<string, ServiceContract> = new Map();

  constructor(configDir: string) {
    this.contractsDir = path.join(configDir, 'env', 'contracts');
  }

  async initialize(): Promise<void> {
    await this.loadContracts();
  }

  private async loadContracts(): Promise<void> {
    if (!fs.existsSync(this.contractsDir)) {
      // No contracts directory — contracts are optional
      return;
    }

    const files = fs
      .readdirSync(this.contractsDir)
      .filter(f => f.endsWith('.contract.ts') || f.endsWith('.contract.js'));

    for (const file of files) {
      try {
        const filePath = path.join(this.contractsDir, file);
        const serviceName = file.replace(/\.contract\.(ts|js)$/, '');

        const module = await import(filePath);
        // Expects export named: PascalCaseContract (e.g., ApiContract, DatabaseContract)
        const pascalCaseName = serviceName
          .split('-')
          .map(part => part.charAt(0).toUpperCase() + part.slice(1))
          .join('');
        const exportName = `${pascalCaseName}Contract`;
        const contract = module[exportName];

        if (contract) {
          this.contracts.set(serviceName, contract);
        } else {
          console.warn(
            `Contract file ${file} does not export '${exportName}'. Skipping.`
          );
        }
      } catch (err: unknown) {
        console.warn(
          `Failed to load contract ${file}:`,
          err instanceof Error ? err.message : String(err)
        );
      }
    }
  }

  /**
   * Validate that all required variables for a service are present in the pool.
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

    const missing: string[] = [];
    const warnings: string[] = [];

    for (const [appVar, systemVar] of Object.entries(contract.required)) {
      const resolved = this.resolveMapping(systemVar, systemVars);
      if (resolved === undefined) {
        missing.push(`${systemVar} (needed for ${appVar})`);
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
   */
  mapContractVariables(
    serviceName: string,
    systemVars: Record<string, string>
  ): Record<string, string> {
    const contract = this.contracts.get(serviceName);
    if (!contract) return {};

    const serviceVars: Record<string, string> = {};

    for (const [appVar, systemVar] of Object.entries(contract.required)) {
      const value = this.resolveMapping(systemVar, systemVars);
      if (value !== undefined) serviceVars[appVar] = value;
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
      // Only return if fully resolved
      return /\$\{([^}]+)\}/.test(resolved) ? undefined : resolved;
    }
    return systemVars[mapping];
  }

  getContracts(): Map<string, ServiceContract> {
    return this.contracts;
  }
}
