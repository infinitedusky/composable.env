import * as fs from 'fs';
import * as path from 'path';
import * as ini from 'ini';
import * as yaml from 'yaml';
import {
  Profile,
  Components,
  EnvironmentConfig,
  BuildResult,
  DockerServiceConfig,
} from './types.js';
import { ContractManager } from './contracts.js';

export class EnvironmentBuilder {
  private configDir: string;
  private outputPath: string;
  private contracts: ContractManager;

  constructor(
    configDir: string,
    outputPath: string,
    private envName?: string
  ) {
    this.configDir = configDir;
    this.outputPath = outputPath;
    this.contracts = new ContractManager(configDir);
  }

  async initialize(): Promise<void> {
    await this.contracts.initialize();
  }

  /**
   * Build environment from a named profile.
   *
   * Convention:
   * - default.json lists ALL component names
   * - Profile JSON files are optional (only needed for explicit overrides)
   * - Profiles can extend other profiles via "extends"
   * - For each component: [default] section + profile-named section(s) layer on top
   */
  async buildFromProfile(profileName: string): Promise<BuildResult> {
    try {
      await this.initialize();

      const defaultPath = path.join(this.configDir, 'env', 'profiles', 'default.json');
      if (!fs.existsSync(defaultPath)) {
        return {
          success: false,
          envPath: this.outputPath,
          errors: ['default.json not found — required to list all components'],
        };
      }

      const defaultData = JSON.parse(fs.readFileSync(defaultPath, 'utf8'));
      const allComponents: string[] = defaultData.components || [];

      let profileOverrides: Record<string, string | string[]> = {};
      let profileData: Profile;
      let inheritanceChain: string[] = [profileName];

      if (profileName === 'default') {
        profileData = {
          name: defaultData.name || 'Default',
          description: defaultData.description || 'Default environment',
          components: {},
        };
        inheritanceChain = [];
      } else {
        const profilePath = path.join(
          this.configDir,
          'env',
          'profiles',
          `${profileName}.json`
        );

        if (fs.existsSync(profilePath)) {
          const loaded = this.loadProfileWithInheritance(profileName);
          profileOverrides = loaded.profileOverrides;
          profileData = loaded.profileData;
          inheritanceChain = loaded.inheritanceChain;
        } else {
          profileData = {
            name: profileName,
            description: `Auto-generated from [${profileName}] sections`,
            components: {},
          };
          inheritanceChain = [profileName];
        }
      }

      // Build merged components: [default] + inheritance chain sections per component
      const mergedComponents: Components = {};
      for (const component of allComponents) {
        const sections: string[] = ['default'];

        if (profileOverrides[component]) {
          const override = profileOverrides[component];
          Array.isArray(override) ? sections.push(...override) : sections.push(override);
        } else if (inheritanceChain.length > 0) {
          sections.push(...inheritanceChain);
        }

        for (const chainProfile of inheritanceChain) {
          if (!sections.includes(chainProfile)) sections.push(chainProfile);
        }

        mergedComponents[component] = sections;
      }

      profileData.components = mergedComponents;
      return this.buildServiceEnvironments(profileData, profileName);
    } catch (error) {
      return {
        success: false,
        envPath: this.outputPath,
        errors: [`Failed to load profile: ${error}`],
      };
    }
  }

  /**
   * Build environment from an explicit component map.
   * Writes a single .env file to outputPath.
   */
  async buildFromComponents(components: Components, profile?: Profile): Promise<BuildResult> {
    try {
      const envVars: Record<string, string> = {};
      const warnings: string[] = [];

      for (const [component, environments] of Object.entries(components)) {
        if (!environments) continue;

        const componentPath = path.join(
          this.configDir,
          'env',
          'components',
          `${component}.env`
        );

        if (!fs.existsSync(componentPath)) {
          return {
            success: false,
            envPath: this.outputPath,
            errors: [`Component file not found: ${component}.env`],
          };
        }

        const envList = Array.isArray(environments) ? environments : [environments];
        for (const environment of envList) {
          const componentConfig = this.loadComponentConfig(componentPath, environment);
          if (!componentConfig) {
            return {
              success: false,
              envPath: this.outputPath,
              errors: [`Section '${environment}' not found in ${component}.env`],
            };
          }
          Object.assign(envVars, componentConfig);
        }
      }

      this.loadSharedFiles(envVars);
      const resolvedVars = this.resolveVariables(envVars);

      // Write single .env file
      const lines = Object.entries(resolvedVars).map(
        ([k, v]) => `${k}=${this.formatEnvValue(v)}`
      );
      await fs.promises.writeFile(this.outputPath, lines.join('\n') + '\n', 'utf8');

      if (profile && this.contracts.getContracts().size > 0) {
        const validation = this.validateAllContracts(resolvedVars);
        warnings.push(...validation.warnings);
        if (!validation.valid) {
          return {
            success: false,
            envPath: this.outputPath,
            errors: validation.errors,
            warnings: warnings.length > 0 ? warnings : undefined,
          };
        }
      }

      return {
        success: true,
        envPath: this.outputPath,
        profile,
        warnings: warnings.length > 0 ? warnings : undefined,
      };
    } catch (error) {
      return {
        success: false,
        envPath: this.outputPath,
        errors: [`Build failed: ${error}`],
      };
    }
  }

  /**
   * Generate a service's .env file from the resolved variable pool.
   */
  async generateServiceEnvFile(
    serviceName: string,
    systemVars: Record<string, string>,
    outputPath?: string,
    currentEnv?: string
  ): Promise<void> {
    const serviceVars = this.contracts.mapContractVariables(serviceName, systemVars);
    const contract = this.contracts.getContracts().get(serviceName);
    const serviceEnvPath = outputPath || `.env.${serviceName}`;

    const allVars = { ...serviceVars };
    if (currentEnv) allVars['CURRENT_ENV'] = currentEnv;

    const envLines: string[] = [];

    if (allVars['CURRENT_ENV']) {
      envLines.push(`CURRENT_ENV=${this.formatEnvValue(allVars['CURRENT_ENV'])}`);
    }

    if (contract?.required) {
      for (const appVar of Object.keys(contract.required)) {
        if (appVar in allVars && appVar !== 'CURRENT_ENV') {
          envLines.push(`${appVar}=${this.formatEnvValue(allVars[appVar])}`);
        }
      }
    }

    if (contract?.secret) {
      for (const appVar of Object.keys(contract.secret)) {
        if (appVar in allVars && !envLines.some(l => l.startsWith(`${appVar}=`))) {
          envLines.push(`${appVar}=${this.formatEnvValue(allVars[appVar])}`);
        }
      }
    }

    if (contract?.optional) {
      for (const appVar of Object.keys(contract.optional)) {
        if (appVar in allVars && !envLines.some(l => l.startsWith(`${appVar}=`))) {
          envLines.push(`${appVar}=${this.formatEnvValue(allVars[appVar])}`);
        }
      }
    }

    if (contract?.defaults) {
      for (const appVar of Object.keys(contract.defaults)) {
        if (appVar in allVars && !envLines.some(l => l.startsWith(`${appVar}=`))) {
          envLines.push(`${appVar}=${this.formatEnvValue(allVars[appVar])}`);
        }
      }
    }

    await fs.promises.writeFile(serviceEnvPath, envLines.join('\n') + '\n', 'utf8');
  }

  listProfiles(): { name: string; description: string }[] {
    try {
      const profilesDir = path.join(this.configDir, 'env', 'profiles');
      return fs
        .readdirSync(profilesDir)
        .filter(f => f.endsWith('.json'))
        .map(file => {
          try {
            const profile = JSON.parse(
              fs.readFileSync(path.join(profilesDir, file), 'utf8')
            ) as Profile;
            return { name: file.replace('.json', ''), description: profile.description };
          } catch {
            return { name: file.replace('.json', ''), description: 'Invalid profile file' };
          }
        });
    } catch {
      return [];
    }
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  private async buildServiceEnvironments(
    profile: Profile,
    profileName?: string
  ): Promise<BuildResult> {
    const errors: string[] = [];
    const warnings: string[] = [];
    const generatedFiles: string[] = [];

    try {
      const componentPool = await this.loadComponentPool(profile.components);

      // Load .env.shared (team values) then .env.local (personal overrides)
      this.loadSharedFiles(componentPool);

      const resolvedPool = this.resolveVariables(componentPool);

      const availableContracts = this.contracts.getContracts();

      // Validate all contracts before writing any files (atomic)
      for (const [serviceName] of availableContracts) {
        const validation = this.contracts.validateContract(serviceName, resolvedPool);

        if (!validation.valid) {
          errors.push(
            `Service '${serviceName}' missing required variables: ${validation.missing.join(', ')}`
          );
        }

        if (validation.warnings.length > 0) {
          warnings.push(...validation.warnings.map(w => `[${serviceName}] ${w}`));
        }

        if (validation.valid) {
          const contract = availableContracts.get(serviceName)!;
          const total =
            Object.keys(contract.required).length +
            Object.keys(contract.secret || {}).length;
          const optional = Object.keys(contract.optional || {}).length;
          if (total > 0) {
            warnings.push(`[${serviceName}] ✅ ${total} required variables validated (${optional} optional)`);
          }
        }
      }

      if (errors.length > 0) {
        return {
          success: false,
          envPath: this.outputPath,
          errors,
          warnings: warnings.length > 0 ? warnings : undefined,
        };
      }

      // All valid — write .env files
      for (const [serviceName, contract] of availableContracts) {
        if (!contract.location) {
          throw new Error(`Contract '${serviceName}' is missing required 'location' field`);
        }

        if (!this.envName) {
          throw new Error(
            'Environment name required. Pass it as the third constructor argument (e.g., "production").'
          );
        }

        const outputPath = `${contract.location}/.env.${this.envName}`;
        const outputDir = path.dirname(outputPath);
        if (!fs.existsSync(outputDir)) {
          await fs.promises.mkdir(outputDir, { recursive: true });
        }

        await this.generateServiceEnvFile(serviceName, resolvedPool, outputPath, profileName);
        generatedFiles.push(outputPath);
      }

      if (profile.docker) {
        const dockerPath = await this.generateDockerCompose(profile, resolvedPool);
        if (dockerPath) generatedFiles.push(dockerPath);
      }

      return {
        success: true,
        envPath: generatedFiles.join(', '),
        profile,
        warnings: warnings.length > 0 ? warnings : undefined,
      };
    } catch (error) {
      return {
        success: false,
        envPath: this.outputPath,
        errors: [`Failed to build environments: ${error}`],
      };
    }
  }

  /**
   * Load .env.shared (team) and .env.local (personal) from env/ root.
   * .env.local always takes precedence.
   */
  private loadSharedFiles(pool: Record<string, string>): void {
    const envDir = path.join(this.configDir, 'env');

    const sharedPath = path.join(envDir, '.env.shared');
    if (fs.existsSync(sharedPath)) {
      Object.assign(pool, this.loadEnvFile(sharedPath));
    }

    const localPath = path.join(envDir, '.env.local');
    if (fs.existsSync(localPath)) {
      Object.assign(pool, this.loadEnvFile(localPath));
    }
  }

  private async loadComponentPool(components: Components): Promise<Record<string, string>> {
    const pool: Record<string, string> = {};

    for (const [component, environments] of Object.entries(components)) {
      if (!environments) continue;

      const envList = Array.isArray(environments) ? environments : [environments];
      const componentPath = path.join(
        this.configDir,
        'env',
        'components',
        `${component}.env`
      );

      if (!fs.existsSync(componentPath)) {
        throw new Error(`Component file not found: ${component}.env`);
      }

      for (const environment of envList) {
        const config = this.loadComponentConfig(componentPath, environment);
        if (!config) {
          if (environment === 'default') {
            throw new Error(`[default] section not found in ${component}.env — required`);
          }
          continue; // Optional profile-named sections are silently skipped
        }
        Object.assign(pool, config);
      }
    }

    return pool;
  }

  private loadProfileWithInheritance(
    profileName: string,
    visited: Set<string> = new Set()
  ): {
    profileData: Profile;
    profileOverrides: Record<string, string | string[]>;
    inheritanceChain: string[];
  } {
    if (visited.has(profileName)) {
      throw new Error(
        `Circular profile inheritance: ${Array.from(visited).join(' -> ')} -> ${profileName}`
      );
    }
    visited.add(profileName);

    const profilePath = path.join(
      this.configDir,
      'env',
      'profiles',
      `${profileName}.json`
    );

    if (!fs.existsSync(profilePath)) {
      throw new Error(`Profile not found: ${profileName}.json`);
    }

    const raw = JSON.parse(fs.readFileSync(profilePath, 'utf8'));

    if (raw.extends) {
      const parent = this.loadProfileWithInheritance(raw.extends, new Set(visited));
      const mergedComponents = { ...parent.profileOverrides, ...raw.components };

      return {
        profileData: {
          ...parent.profileData,
          ...raw,
          components: mergedComponents,
        } as Profile,
        profileOverrides: mergedComponents,
        inheritanceChain: [...parent.inheritanceChain, profileName],
      };
    }

    return {
      profileData: raw as Profile,
      profileOverrides: raw.components || {},
      inheritanceChain: [profileName],
    };
  }

  private loadComponentConfig(
    filePath: string,
    environment: string
  ): Record<string, string> | null {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const config = ini.parse(content) as EnvironmentConfig;
      const quotedValues = this.extractQuotedValues(content, environment);

      const envConfig = config[environment];
      if (!envConfig) return null;

      const namespace = (config as unknown as Record<string, string>)['NAMESPACE'];

      const result: Record<string, string> = {};
      for (const [key, value] of Object.entries(envConfig)) {
        const finalKey = namespace ? `${namespace}_${key}` : key;
        result[finalKey] = quotedValues[key] || value;
      }

      return result;
    } catch (error) {
      throw new Error(`Failed to parse ${filePath}: ${error}`);
    }
  }

  private extractQuotedValues(content: string, environment: string): Record<string, string> {
    const quoted: Record<string, string> = {};
    const lines = content.split('\n');
    let inTarget = false;

    for (const line of lines) {
      const trimmed = line.trim();

      if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
        inTarget = trimmed.slice(1, -1) === environment;
        continue;
      }

      if (!inTarget || !trimmed || trimmed.startsWith('#')) continue;

      const match = trimmed.match(/^([^=]+)="([^"]*)"$/);
      if (match) {
        const [, key, value] = match;
        quoted[key.trim()] = `"${value}"`;
      }
    }

    return quoted;
  }

  private loadEnvFile(filePath: string): Record<string, string> {
    try {
      const vars: Record<string, string> = {};
      for (const line of fs.readFileSync(filePath, 'utf8').split('\n')) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#')) {
          const [key, ...valueParts] = trimmed.split('=');
          if (key && valueParts.length > 0) {
            vars[key.trim()] = valueParts.join('=').trim();
          }
        }
      }
      return vars;
    } catch (error) {
      throw new Error(`Failed to load ${filePath}: ${error}`);
    }
  }

  private resolveVariables(vars: Record<string, string>): Record<string, string> {
    const resolved = { ...vars };
    const maxPasses = 10;
    let pass = 0;
    let hasUnresolved = true;

    while (hasUnresolved && pass < maxPasses) {
      hasUnresolved = false;
      pass++;

      for (const [key, value] of Object.entries(resolved)) {
        const str = typeof value === 'string' ? value : String(value);
        if (/\$\{([^}]+)\}/.test(str)) {
          const newValue = str.replace(/\$\{([^}]+)\}/g, (match, varName) => {
            const replacement = resolved[varName] || process.env[varName];
            if (replacement !== undefined) return replacement;
            hasUnresolved = true;
            return match;
          });
          if (newValue !== str) {
            resolved[key] = newValue;
            hasUnresolved = true;
          }
        }
      }
    }

    if (pass >= maxPasses) {
      console.warn(`⚠️ Variable resolution hit ${maxPasses} passes — possible circular reference.`);
    }

    for (const [key, value] of Object.entries(resolved)) {
      if (typeof value === 'string' && /\$\{([^}]+)\}/.test(value)) {
        const unresolved = value.match(/\$\{([^}]+)\}/g) || [];
        console.warn(`⚠️ Unresolved variables in ${key}: ${unresolved.join(', ')}`);
      }
    }

    return resolved;
  }

  private validateAllContracts(systemVars: Record<string, string>): {
    valid: boolean;
    errors: string[];
    warnings: string[];
  } {
    const errors: string[] = [];
    const warnings: string[] = [];

    for (const [serviceName] of this.contracts.getContracts()) {
      const validation = this.contracts.validateContract(serviceName, systemVars);
      if (!validation.valid) {
        errors.push(
          `Service '${serviceName}' missing required variables: ${validation.missing.join(', ')}`
        );
      }
      warnings.push(...validation.warnings.map(w => `[${serviceName}] ${w}`));
    }

    return { valid: errors.length === 0, errors, warnings };
  }

  private formatEnvValue(value: string): string {
    let str = typeof value === 'string' ? value : String(value);

    // Strip existing outer quotes
    if (
      (str.startsWith('"') && str.endsWith('"')) ||
      (str.startsWith("'") && str.endsWith("'"))
    ) {
      str = str.slice(1, -1);
    }

    // Quote JSON values with single quotes
    if (str.trim().startsWith('[') || str.trim().startsWith('{')) {
      return `'${str.replace(/'/g, "'\\''")}'`;
    }

    // Don't quote variable substitutions or URLs
    if (/^\$\{[^}]+\}$/.test(str) || /^[a-z]+:\/\//.test(str)) {
      return str;
    }

    // Quote values with spaces or special characters
    if (/[\s;&|<>(){}[\]$`"'\\]/.test(str)) {
      return `'${str}'`;
    }

    return str;
  }

  private async generateDockerCompose(
    profile: Profile,
    resolvedVars: Record<string, string>
  ): Promise<string | null> {
    if (!profile.docker) return null;

    const dockerCompose = {
      version: '3.8',
      services: {} as Record<string, DockerServiceConfig>,
      networks: profile.docker.networks || {},
      volumes: profile.docker.volumes || {},
    };

    for (const [serviceName, serviceConfig] of Object.entries(profile.docker.services)) {
      if (this.shouldIncludeService(serviceConfig, profile, resolvedVars)) {
        dockerCompose.services[serviceName] = this.processServiceConfig(
          serviceConfig,
          resolvedVars
        );
      }
    }

    const outputPath = './docker-compose.yaml';
    await fs.promises.writeFile(outputPath, yaml.stringify(dockerCompose), 'utf8');
    return outputPath;
  }

  private shouldIncludeService(
    serviceConfig: DockerServiceConfig,
    profile: Profile,
    resolvedVars: Record<string, string>
  ): boolean {
    if (!serviceConfig.condition) return true;
    return this.evaluateCondition(serviceConfig.condition, profile, resolvedVars);
  }

  private processServiceConfig(
    serviceConfig: DockerServiceConfig,
    resolvedVars: Record<string, string>
  ): DockerServiceConfig {
    const processed = { ...serviceConfig };
    delete processed.condition;

    if (processed.environment) {
      processed.env_file = processed.environment;
      delete processed.environment;
    }

    if (processed.build || processed.image) {
      processed.platform = 'linux/amd64';
    }

    return this.substituteVariables(processed, resolvedVars) as DockerServiceConfig;
  }

  private evaluateCondition(
    condition: string,
    profile: Profile,
    _resolvedVars: Record<string, string>
  ): boolean {
    try {
      const includesMatch = condition.match(/components\.(\w+)\s+includes\s+['"]([^'"]+)['"]/);
      if (includesMatch) {
        const [, componentName, expectedValue] = includesMatch;
        const val = profile.components[componentName];
        return Array.isArray(val) ? val.includes(expectedValue) : val === expectedValue;
      }

      const equalsMatch = condition.match(/components\.(\w+)\s*===\s*['"]([^'"]+)['"]/);
      if (equalsMatch) {
        const [, componentName, expectedValue] = equalsMatch;
        const val = profile.components[componentName];
        return Array.isArray(val) ? val.includes(expectedValue) : val === expectedValue;
      }

      console.warn(`Unrecognized condition: ${condition}`);
      return true;
    } catch {
      return true;
    }
  }

  private substituteVariables(obj: unknown, vars: Record<string, string>): unknown {
    if (typeof obj === 'string') {
      return obj.replace(/\$\{([^}]+)\}/g, (match, varName) => {
        return vars[varName] || process.env[varName] || match;
      });
    }
    if (Array.isArray(obj)) return obj.map(item => this.substituteVariables(item, vars));
    if (obj && typeof obj === 'object') {
      const result: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(obj)) {
        result[key] = this.substituteVariables(value, vars);
      }
      return result;
    }
    return obj;
  }
}
