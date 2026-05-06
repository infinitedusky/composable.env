import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as ini from 'ini';
import * as yaml from 'yaml';
import {
  Profile,
  Components,
  EnvironmentConfig,
  BuildResult,
  DockerServiceConfig,
  CeProfileConfig,
} from './types.js';
import { ContractManager, isNewFormatContract } from './contracts.js';
import {
  writeMultiProfileComposeFile,
  type ComposeServiceEntry,
  type ComposeMultiProfileEntry,
} from './targets/docker-compose.js';
import { writeNginxConfigs } from './targets/nginx.js';
import { loadConfig } from './config.js';

/**
 * Expand a leading ~ to the user's home directory. Other paths pass through.
 */
function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

/**
 * Resolve a contract output path.
 *   - Absolute paths and ~-prefixed paths are honored as-is.
 *   - Relative paths are joined with `base`.
 *
 * Used for both `location` (resolved against project root) and `outputs[profile]`
 * (resolved against `location`).
 */
function resolveContractPath(p: string, base: string): string {
  const expanded = expandHome(p);
  if (path.isAbsolute(expanded)) return expanded;
  return path.join(base, expanded);
}

export class EnvironmentBuilder {
  private configDir: string;
  private outputPath: string;
  private contracts: ContractManager;
  private envDir: string;

  constructor(
    configDir: string,
    outputPath: string,
    private envName?: string,
    envDir: string = 'env'
  ) {
    this.configDir = configDir;
    this.outputPath = outputPath;
    this.envDir = envDir;
    this.contracts = new ContractManager(configDir, envDir);
  }

  async initialize(): Promise<void> {
    await this.contracts.initialize();
  }

  /**
   * Build environment from a named profile.
   *
   * Components are auto-discovered from env/components/*.env.
   * Profile JSON files are optional — they provide section overrides per component.
   * For each component: [default] section + [profileName] section(s) layer on top.
   */
  async buildFromProfile(profileName: string, serveMode?: Set<string> | 'all'): Promise<BuildResult> {
    try {
      await this.initialize();

      const allComponents = this.discoverComponents();
      if (allComponents.length === 0) {
        return {
          success: false,
          envPath: this.outputPath,
          errors: [`No component files found in ${this.envDir}/components/`],
        };
      }

      let profileOverrides: Record<string, string | string[]> = {};
      let profileData: Profile;
      let inheritanceChain: string[] = [profileName];

      if (profileName === 'default') {
        profileData = {
          name: 'Default',
          description: 'Default environment',
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
          // No profile JSON — verify at least one component has a [profileName] section
          if (!this.profileSectionExists(profileName, allComponents)) {
            return {
              success: false,
              envPath: this.outputPath,
              errors: [
                `Profile '${profileName}' not found. No ${this.envDir}/profiles/${profileName}.json ` +
                `and no [${profileName}] section in any component file.`,
              ],
            };
          }
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
      // Load profile config from ce.json for suffix/domain support
      const ceConfig = loadConfig(this.configDir);
      const profileSuffixes = ceConfig.profiles
        ? Object.fromEntries(Object.entries(ceConfig.profiles).map(([name, cfg]) => [name, cfg.suffix]))
        : undefined;

      return this.buildServiceEnvironments(profileData, profileName, profileSuffixes, ceConfig.profiles, serveMode ?? undefined);
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

      await this.loadSharedFiles(envVars);
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
   * Handles both new-format (vars) and legacy (required/optional/secret) contracts.
   */
  async generateServiceEnvFile(
    serviceName: string,
    systemVars: Record<string, string>,
    outputPath?: string,
    currentEnv?: string,
    componentPool?: Map<string, Record<string, string>>
  ): Promise<void> {
    const contract = this.contracts.getContracts().get(serviceName);
    const serviceEnvPath = outputPath || `.ce.${serviceName}`;

    let serviceVars: Record<string, string>;

    if (contract && isNewFormatContract(contract) && componentPool) {
      serviceVars = this.contracts.mapVarsContract(serviceName, componentPool);
    } else {
      serviceVars = this.contracts.mapContractVariables(serviceName, systemVars);
    }

    const allVars = { ...serviceVars };
    if (currentEnv) allVars['CURRENT_ENV'] = currentEnv;

    const envLines: string[] = [
      '# Generated by composable.env — DO NOT EDIT',
      `# Profile: ${currentEnv || 'unknown'} | Built: ${new Date().toISOString()}`,
      '',
    ];

    if (allVars['CURRENT_ENV']) {
      envLines.push(`CURRENT_ENV=${this.formatEnvValue(allVars['CURRENT_ENV'])}`);
    }

    if (contract && isNewFormatContract(contract)) {
      // New format: output vars in order, then defaults
      if (contract.vars) {
        for (const appVar of Object.keys(contract.vars)) {
          if (appVar in allVars && appVar !== 'CURRENT_ENV') {
            envLines.push(`${appVar}=${this.formatEnvValue(allVars[appVar])}`);
          }
        }
      }
      if (contract.defaults) {
        for (const appVar of Object.keys(contract.defaults)) {
          if (appVar in allVars && !envLines.some(l => l.startsWith(`${appVar}=`))) {
            envLines.push(`${appVar}=${this.formatEnvValue(allVars[appVar])}`);
          }
        }
      }
    } else if (contract) {
      // Legacy format
      if (contract.required) {
        for (const appVar of Object.keys(contract.required)) {
          if (appVar in allVars && appVar !== 'CURRENT_ENV') {
            envLines.push(`${appVar}=${this.formatEnvValue(allVars[appVar])}`);
          }
        }
      }
      if (contract.secret) {
        for (const appVar of Object.keys(contract.secret)) {
          if (appVar in allVars && !envLines.some(l => l.startsWith(`${appVar}=`))) {
            envLines.push(`${appVar}=${this.formatEnvValue(allVars[appVar])}`);
          }
        }
      }
      if (contract.optional) {
        for (const appVar of Object.keys(contract.optional)) {
          if (appVar in allVars && !envLines.some(l => l.startsWith(`${appVar}=`))) {
            envLines.push(`${appVar}=${this.formatEnvValue(allVars[appVar])}`);
          }
        }
      }
      if (contract.defaults) {
        for (const appVar of Object.keys(contract.defaults)) {
          if (appVar in allVars && !envLines.some(l => l.startsWith(`${appVar}=`))) {
            envLines.push(`${appVar}=${this.formatEnvValue(allVars[appVar])}`);
          }
        }
      }
    }

    await fs.promises.writeFile(serviceEnvPath, envLines.join('\n') + '\n', 'utf8');
  }

  /**
   * Lenient variant of generateServiceEnvFile for defaults-only builds.
   * Skips vars that can't be resolved instead of leaving gaps.
   * Used when contract.default is set but no default profile exists.
   */
  async generateServiceEnvFileLenient(
    serviceName: string,
    systemVars: Record<string, string>,
    outputPath: string,
    currentEnv: string,
    componentPool?: Map<string, Record<string, string>>
  ): Promise<void> {
    const contract = this.contracts.getContracts().get(serviceName);
    if (!contract) return;

    let serviceVars: Record<string, string>;

    if (isNewFormatContract(contract) && componentPool) {
      serviceVars = this.contracts.mapVarsContract(serviceName, componentPool);
    } else {
      serviceVars = this.contracts.mapContractVariables(serviceName, systemVars);
    }

    // Filter out any vars that still contain unresolved ${...} references
    const resolvedVars: Record<string, string> = {};
    for (const [key, value] of Object.entries(serviceVars)) {
      if (!/\$\{[^}]+\}/.test(value)) {
        resolvedVars[key] = value;
      }
    }

    const envLines: string[] = [
      '# Generated by composable.env — DO NOT EDIT',
      `# Profile: ${currentEnv} (defaults only) | Built: ${new Date().toISOString()}`,
      '',
    ];

    for (const [key, value] of Object.entries(resolvedVars)) {
      envLines.push(`${key}=${this.formatEnvValue(value)}`);
    }

    await fs.promises.writeFile(outputPath, envLines.join('\n') + '\n', 'utf8');
  }

  listProfiles(): { name: string; description: string }[] {
    try {
      const profilesDir = path.join(this.configDir, this.envDir, 'profiles');
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

  /**
   * Discover all profile names from JSON files in env/profiles/.
   * Only explicitly defined profiles — not inferred from component section names.
   */
  discoverAllProfileNames(): string[] {
    return this.listProfiles().map(p => p.name).sort();
  }

  /**
   * Build profiles and generate multi-profile compose output.
   *
   * @param envProfile — if set, only write .env.{profile} for this one profile.
   *                     If omitted, write .env files for ALL profiles.
   *                     The compose file always includes all profiles regardless.
   */
  async buildAllProfiles(
    envProfile?: string,
    profileSuffixes?: Record<string, string>,
    profileConfigs?: Record<string, CeProfileConfig>
  ): Promise<BuildResult> {
    await this.initialize();

    const profileNames = this.discoverAllProfileNames();
    if (profileNames.length === 0) {
      return {
        success: false,
        envPath: this.outputPath,
        errors: ['No profiles found. Create profile JSON files in env/profiles/.'],
      };
    }

    const errors: string[] = [];
    const warnings: string[] = [];
    const generatedFiles: string[] = [];

    // Build each profile using the same code path as buildFromProfile
    const profilesToProcess = envProfile ? [envProfile] : profileNames;

    for (const profileName of profilesToProcess) {
      const result = await this.buildFromProfile(profileName);
      if (!result.success) {
        errors.push(...(result.errors || [`Failed to build profile '${profileName}'`]));
      } else {
        if (result.envPath) generatedFiles.push(result.envPath);
        if (result.warnings) warnings.push(...result.warnings);
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

    warnings.push(`Built ${profilesToProcess.length} profiles: ${profilesToProcess.join(', ')}`);

    return {
      success: true,
      envPath: generatedFiles.join(', '),
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  }

  /**
   * Generate service.* pseudo-variables for all target contracts.
   * For each service: host, address, suffix, domain, protocol.
   * Keys are dotted: "game-server.host", "game-server.address", etc.
   */
  private generateServiceVars(
    contracts: Map<string, import('./contracts.js').ServiceContract>,
    profileName: string,
    profileConfig: CeProfileConfig
  ): Record<string, string> {
    const vars: Record<string, string> = {};
    const defaultSuffix = profileConfig.suffix;
    const defaultDomain = profileConfig.domain || '';
    const defaultProtocol = profileConfig.tls ? 'https' : 'http';

    // Default entries — profile-level suffix and domain without a specific service
    vars['default.suffix'] = defaultSuffix;
    vars['default.domain'] = defaultDomain;
    vars['default.protocol'] = defaultProtocol;

    for (const [, contract] of contracts) {
      if (!contract.target) continue;
      const svcName = contract.target.service;

      // Per-service overrides from ce.json
      const svcOverride = profileConfig.override?.[svcName];
      const suffix = svcOverride?.suffix ?? defaultSuffix;
      const domain = svcOverride?.domain ?? defaultDomain;

      const host = `${svcName}${suffix}`;
      const address = domain ? `${host}.${domain}` : host;

      vars[`${svcName}.host`] = host;
      vars[`${svcName}.address`] = address;
      vars[`${svcName}.suffix`] = suffix;
      vars[`${svcName}.domain`] = domain;
      vars[`${svcName}.protocol`] = defaultProtocol;
    }

    return vars;
  }

  /**
   * Resolve profile data and inheritance chain for a given profile name.
  // ─── Private helpers ────────────────────────────────────────────────────────

  /**
   * Auto-discover all component files from env/components/*.env.
   */
  private discoverComponents(): string[] {
    const componentsDir = path.join(this.configDir, this.envDir, 'components');
    if (!fs.existsSync(componentsDir)) return [];
    return fs.readdirSync(componentsDir)
      .filter(f => f.endsWith('.env'))
      .map(f => f.replace('.env', ''))
      .sort();
  }

  private async buildServiceEnvironments(
    profile: Profile,
    profileName?: string,
    profileSuffixes?: Record<string, string>,
    profileConfigs?: Record<string, CeProfileConfig>,
    serveMode?: Set<string> | 'all'
  ): Promise<BuildResult> {
    const errors: string[] = [];
    const warnings: string[] = [];
    const generatedFiles: string[] = [];

    try {
      const allContracts = this.contracts.getContracts();
      const currentProfile = profileName || 'default';

      // When building "default" without a real default profile, only contracts
      // with the `default` field set should be included — others have nothing to build.
      const isDefaultWithoutProfile = currentProfile === 'default' &&
        !fs.existsSync(path.join(this.configDir, this.envDir, 'profiles', 'default.json'));

      // Filter contracts by onlyProfiles — skip contracts that don't apply to this profile
      const availableContracts = new Map(
        [...allContracts].filter(([, contract]) => {
          if (isDefaultWithoutProfile && !contract.default) return false;
          if (contract.ignoreDefault && currentProfile === 'default') return false;
          if (!contract.onlyProfiles || contract.onlyProfiles.length === 0) return true;
          return contract.onlyProfiles.includes(currentProfile);
        })
      );

      const skippedCount = allContracts.size - availableContracts.size;
      if (skippedCount > 0) {
        warnings.push(`Skipped ${skippedCount} contract(s) not matching profile '${currentProfile}'`);
      }

      const useNewFormat = this.contracts.hasNewFormatContracts();

      let componentPool: Map<string, Record<string, string>> | undefined;
      let flatPool: Record<string, string>;

      if (useNewFormat) {
        // New format: component-scoped pool + secrets layer
        componentPool = await this.loadScopedComponentPool(profile.components, profileName || 'default', isDefaultWithoutProfile);

        // Inject service.* pseudo-component with auto-generated vars
        const config = loadConfig(this.configDir);
        const pName = profileName || 'default';
        const profileConfig = config.profiles?.[pName];
        if (profileConfig) {
          const serviceVars = this.generateServiceVars(
            availableContracts, pName, profileConfig
          );
          if (Object.keys(serviceVars).length > 0) {
            componentPool.set('service', serviceVars);
            this.resolveCrossComponentRefs(componentPool);
          }
        }

        flatPool = this.flattenComponentPool(componentPool);
      } else {
        // Legacy format: flat NAMESPACE-prefixed pool
        flatPool = await this.loadFlatComponentPool(profile.components);
        await this.loadSharedFiles(flatPool);
      }

      const resolvedPool = this.resolveVariables(flatPool, isDefaultWithoutProfile);

      // Rebuild componentPool from resolved values for validation
      const resolvedComponentPool = componentPool
        ? this.rebuildComponentPool(componentPool, resolvedPool)
        : undefined;

      // Validate all contracts before writing any files (atomic)
      for (const [serviceName, contract] of availableContracts) {
        // Skip strict validation for contracts using lenient default output
        if (currentProfile === 'default' && (contract.default || contract.ignoreDefault)) continue;

        if (isNewFormatContract(contract) && resolvedComponentPool) {
          const validation = this.contracts.validateVarsContract(serviceName, resolvedComponentPool);
          if (!validation.valid) {
            errors.push(
              `Service '${serviceName}' missing required variables: ${validation.missing.join(', ')}`
            );
          }
          if (validation.warnings.length > 0) {
            warnings.push(...validation.warnings.map(w => `[${serviceName}] ${w}`));
          }
          if (validation.valid && contract.vars) {
            const total = Object.keys(contract.vars).length;
            const optional = Object.keys(contract.defaults || {}).length;
            if (total > 0) {
              warnings.push(`[${serviceName}] ✅ ${total} vars validated (${optional} defaults)`);
            }
          }
        } else {
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
            const total =
              Object.keys(contract.required || {}).length +
              Object.keys(contract.secret || {}).length;
            const optional = Object.keys(contract.optional || {}).length;
            if (total > 0) {
              warnings.push(`[${serviceName}] ✅ ${total} required variables validated (${optional} optional)`);
            }
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

      // All valid — write outputs
      // Collect docker-compose entries grouped by target file
      const composeGroups = new Map<string, ComposeServiceEntry[]>();

      for (const [serviceName, contract] of availableContracts) {
        // A contract can have location, target, or both

        if (contract.location) {
          // Resolve the location root (handles absolute paths and ~ expansion)
          const locationRoot = resolveContractPath(contract.location, this.configDir);

          // Handle default profile redirects and ignores
          if (currentProfile === 'default') {
            if (contract.ignoreDefault) continue;
            if (contract.default) {
              // contract.default is treated as a filename relative to location
              const outputPath = resolveContractPath(contract.default, locationRoot);
              const outputDir = path.dirname(outputPath);
              if (!fs.existsSync(outputDir)) {
                await fs.promises.mkdir(outputDir, { recursive: true });
              }
              await this.generateServiceEnvFileLenient(
                serviceName, resolvedPool, outputPath, currentProfile, componentPool
              );
              generatedFiles.push(outputPath);
              continue;
            }
          }

          // Per-profile output filename override, with fallback to .env.{profile}
          const outputOverride = contract.outputs?.[currentProfile];
          const outputPath = outputOverride
            ? resolveContractPath(outputOverride, locationRoot)
            : path.join(locationRoot, `.env.${currentProfile}`);
          const outputDir = path.dirname(outputPath);
          if (!fs.existsSync(outputDir)) {
            await fs.promises.mkdir(outputDir, { recursive: true });
          }

          await this.generateServiceEnvFile(
            serviceName, resolvedPool, outputPath, profileName, componentPool
          );
          generatedFiles.push(outputPath);
        }

        if (contract.target) {
          // Docker-compose target — collect entries grouped by file
          // Persistent contracts go to a separate compose file
          const baseFilePath = contract.target.file;
          const filePath = contract.persistent
            ? baseFilePath.replace(/\.yml$/, '.persistent.yml').replace(/\.yaml$/, '.persistent.yaml')
            : baseFilePath;
          if (!composeGroups.has(filePath)) {
            composeGroups.set(filePath, []);
          }

          let serviceVars: Record<string, string>;
          if (useNewFormat && componentPool) {
            serviceVars = this.contracts.mapVarsContract(serviceName, componentPool);
          } else {
            serviceVars = this.contracts.mapContractVariables(serviceName, resolvedPool);
          }

          // Apply defaults
          if (contract.defaults) {
            for (const [key, value] of Object.entries(contract.defaults)) {
              if (serviceVars[key] === undefined) {
                serviceVars[key] = value;
              }
            }
          }

          // In serve mode, merge serve.config on top of target.config for matching services
          let effectiveConfig = contract.target.config;
          const isServed = serveMode &&
            (serveMode === 'all' || serveMode.has(serviceName));

          if (isServed) {
            const serveConfig = contract.serve?.config;
            if (serveConfig && effectiveConfig) {
              effectiveConfig = { ...effectiveConfig, ...serveConfig };
            } else if (serveConfig) {
              effectiveConfig = serveConfig;
            }
            // Force NODE_ENV=production so the entrypoint runs start, not dev
            serviceVars['NODE_ENV'] = 'production';
          }

          // TLS: Caddy-based TLS termination when profile has tls: true
          // Caddy listens on the public PORT, app shifts to PORT+10000
          const ceConfig = loadConfig(this.configDir);
          const currentProfileConfig = ceConfig.profiles?.[currentProfile];
          if (currentProfileConfig?.tls && currentProfileConfig?.domain) {
            const domain = currentProfileConfig.domain;
            const certDir = `.certs/${domain}`;

            // Add cert volume mount
            if (effectiveConfig) {
              const volumes = (effectiveConfig.volumes as string[]) || [];
              const certMount = `./${certDir}:/app/.certs:ro`;
              if (!volumes.includes(certMount)) {
                effectiveConfig = { ...effectiveConfig, volumes: [...volumes, certMount] };
              }
            }

            // Inject NODE_EXTRA_CA_CERTS so containers trust the local CA
            serviceVars['NODE_EXTRA_CA_CERTS'] = '/app/.certs/rootCA.pem';

            // Signal to entrypoint that Caddy TLS is enabled
            serviceVars['CE_TLS_CERT'] = '/app/.certs/cert.pem';
            serviceVars['CE_TLS_KEY'] = '/app/.certs/key.pem';

            // Signal TLS is active for all services — entrypoint starts Caddy
            serviceVars['CE_TLS_PORT'] = serviceVars['PORT'] || 'true';
          }

          composeGroups.get(filePath)!.push({
            contractName: serviceName,
            serviceName: contract.target.service,
            vars: serviceVars,
            config: effectiveConfig
              ? this.resolveConfigValues(effectiveConfig, resolvedPool)
              : undefined,
          });
        }
      }

      // Write docker-compose files (one write per file, all services batched)
      const profileNames = profileSuffixes ? Object.keys(profileSuffixes) : [currentProfile];

      // Derive compose project name from .orb.local domain
      let composeName: string | undefined;
      if (profileConfigs) {
        for (const config of Object.values(profileConfigs)) {
          if (config.domain?.endsWith('.orb.local')) {
            composeName = config.domain.split('.')[0];
            break;
          }
        }
      }

      for (const [filePath, entries] of composeGroups) {
        // Convert single-profile entries to multi-profile format
        const multiEntries: ComposeMultiProfileEntry[] = entries.map(e => {
          const contract = availableContracts.get(e.contractName);
          return {
            ...e,
            profileName: currentProfile,
            profileOverrides: contract?.target?.profileOverrides
              ? this.resolveConfigValues(contract.target.profileOverrides, resolvedPool)
              : undefined,
          };
        });
        const result = await writeMultiProfileComposeFile(
          filePath, multiEntries, profileNames, profileSuffixes, composeName
        );
        warnings.push(...result.warnings);
        generatedFiles.push(filePath);
      }

      // Generate nginx configs for profiles with domains and contracts with subdomains
      if (profileConfigs) {
        const profileDomains: Record<string, string> = {};
        for (const [name, config] of Object.entries(profileConfigs)) {
          if (config.domain) profileDomains[name] = config.domain;
        }
        if (Object.keys(profileDomains).length > 0) {
          const nginxResults = writeNginxConfigs(
            this.configDir,
            availableContracts,
            profileNames,
            profileSuffixes || {},
            profileDomains,
          );
          for (const result of nginxResults) {
            generatedFiles.push(result.filePath);
            if (result.warnings.length > 0) {
              warnings.push(`Nginx routes (${path.basename(result.filePath)}):`);
              warnings.push(...result.warnings);
            }
          }
        }
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
   * Check if any component file contains a [profileName] INI section.
   */
  private profileSectionExists(profileName: string, components: string[]): boolean {
    for (const component of components) {
      const componentPath = path.join(
        this.configDir,
        this.envDir,
        'components',
        `${component}.env`
      );
      try {
        const content = fs.readFileSync(componentPath, 'utf8');
        const config = ini.parse(content) as EnvironmentConfig;
        if (config[profileName]) return true;
      } catch {
        continue;
      }
    }
    return false;
  }

  // ─── Secrets layer ────────────────────────────────────────────────────────

  /**
   * Load .env.secrets.shared (team secrets, encrypted) and .env.secrets.local (personal overrides).
   */
  private async loadSecretsPool(): Promise<Record<string, string>> {
    const envDir = path.join(this.configDir, 'env');
    const secrets: Record<string, string> = {};

    // 1. Team secrets (encrypted, committed)
    const sharedSecretsPath = path.join(envDir, '.env.secrets.shared');
    if (fs.existsSync(sharedSecretsPath)) {
      Object.assign(secrets, this.loadEnvFile(sharedSecretsPath));
    }

    // Fallback: load secrets from .env.shared if no .env.secrets.shared exists
    if (!fs.existsSync(sharedSecretsPath)) {
      const legacySharedPath = path.join(envDir, '.env.shared');
      if (fs.existsSync(legacySharedPath)) {
        const legacyVars = this.loadEnvFile(legacySharedPath);
        // Only pull in CENV_ENC values from legacy .env.shared
        for (const [key, value] of Object.entries(legacyVars)) {
          if (String(value).startsWith('CENV_ENC[')) {
            secrets[key] = value;
          }
        }
      }
    }

    // Decrypt any CENV_ENC[] values
    const hasCenvEnc = Object.values(secrets).some(v => String(v).startsWith('CENV_ENC['));
    if (hasCenvEnc) {
      const { Vault } = await import('./vault.js');
      const vault = new Vault(this.configDir, this.envDir);
      await vault.decryptPool(secrets);
    }

    // 2. Personal secret overrides (gitignored)
    const localSecretsPath = path.join(envDir, '.env.secrets.local');
    if (fs.existsSync(localSecretsPath)) {
      Object.assign(secrets, this.loadEnvFile(localSecretsPath));
    }

    return secrets;
  }

  /**
   * Load .env.shared (team) from env/ root and decrypt vault entries.
   * Used for legacy format.
   */
  private async loadSharedFiles(pool: Record<string, string>): Promise<void> {
    const envDir = path.join(this.configDir, 'env');

    const sharedPath = path.join(envDir, '.env.shared');
    if (fs.existsSync(sharedPath)) {
      Object.assign(pool, this.loadEnvFile(sharedPath));
    }

    const hasCenvEnc = Object.values(pool).some(v => String(v).startsWith('CENV_ENC['));
    if (hasCenvEnc) {
      const { Vault } = await import('./vault.js');
      const vault = new Vault(this.configDir, this.envDir);
      await vault.decryptPool(pool);
    }
  }

  // ─── Component loading ────────────────────────────────────────────────────

  /**
   * New format: Load components as Map<componentName, Record<key, value>>.
   * No NAMESPACE prefixing — component filename IS the namespace.
   * Also loads secrets as the reserved "secrets" component.
   */
  private async loadScopedComponentPool(
    components: Components,
    _profileName: string,
    quiet: boolean = false
  ): Promise<Map<string, Record<string, string>>> {
    const pool = new Map<string, Record<string, string>>();

    // Load secrets as reserved "secrets" namespace
    const secrets = await this.loadSecretsPool();
    pool.set('secrets', secrets);

    for (const [component, environments] of Object.entries(components)) {
      if (component === 'secrets') {
        throw new Error(
          `Component name 'secrets' is reserved for the secrets namespace. ` +
          `Rename '${component}.env' to something else.`
        );
      }

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

      const componentVars: Record<string, string> = {};
      for (const environment of envList) {
        const config = this.loadComponentConfigRaw(componentPath, environment);
        if (!config) {
          if (environment === 'default') {
            throw new Error(`[default] section not found in ${component}.env — required`);
          }
          continue;
        }
        Object.assign(componentVars, config);
      }

      pool.set(component, componentVars);
    }

    // Pass 1: resolve ${secrets.KEY} in all components
    this.resolveSecretsInComponents(pool);

    // Pass 2: resolve cross-component ${component.KEY} references
    this.resolveCrossComponentRefs(pool, quiet);

    return pool;
  }

  /**
   * Resolve ${secrets.KEY} references within all components.
   */
  private resolveSecretsInComponents(pool: Map<string, Record<string, string>>): void {
    const secrets = pool.get('secrets') || {};

    for (const [componentName, vars] of pool) {
      if (componentName === 'secrets') continue;

      for (const [key, value] of Object.entries(vars)) {
        if (typeof value !== 'string') continue;
        const resolved = value.replace(/\$\{secrets\.([^}]+)\}/g, (match, secretKey: string) => {
          return secrets[secretKey] !== undefined ? secrets[secretKey] : match;
        });
        if (resolved !== value) {
          vars[key] = resolved;
        }
      }
    }
  }

  /**
   * Resolve cross-component references like ${database.HOST} in component values.
   */
  private resolveCrossComponentRefs(pool: Map<string, Record<string, string>>, quiet: boolean = false): void {
    const maxPasses = 10;
    let pass = 0;
    let hasUnresolved = true;

    while (hasUnresolved && pass < maxPasses) {
      hasUnresolved = false;
      pass++;

      for (const [componentName, vars] of pool) {
        if (componentName === 'secrets') continue;

        for (const [key, value] of Object.entries(vars)) {
          if (typeof value !== 'string' || !/\$\{([^}]+\.[^}]+)\}/.test(value)) continue;

          const resolved = value.replace(/\$\{([^}.]+)\.([^}]+)\}/g, (match, refComponent: string, refKey: string) => {
            if (refComponent === 'secrets') return match; // Already handled
            const refVars = pool.get(refComponent);
            if (refVars && refKey in refVars) {
              return refVars[refKey];
            }
            return match;
          });

          if (resolved !== value) {
            vars[key] = resolved;
            if (/\$\{([^}]+\.[^}]+)\}/.test(resolved)) {
              hasUnresolved = true;
            }
          } else if (/\$\{([^}]+\.[^}]+)\}/.test(value)) {
            hasUnresolved = true;
          }
        }
      }
    }

    if (pass >= maxPasses) {
      // Only warn if there are actually still unresolved refs
      let stillUnresolved = false;
      for (const [componentName, vars] of pool) {
        if (componentName === 'secrets') continue;
        for (const value of Object.values(vars)) {
          if (typeof value === 'string' && /\$\{([^}]+\.[^}]+)\}/.test(value)) {
            // Skip ${secrets.*} — those are resolved in a different pass
            if (!/\$\{secrets\.[^}]+\}/.test(value)) {
              stillUnresolved = true;
              break;
            }
          }
        }
        if (stillUnresolved) break;
      }
      if (stillUnresolved && !quiet) {
        console.warn(`⚠️ Cross-component resolution hit ${maxPasses} passes — possible circular reference.`);
      }
    }
  }

  /**
   * Flatten a scoped component pool into a flat key→value map.
   */
  private flattenComponentPool(pool: Map<string, Record<string, string>>): Record<string, string> {
    const flat: Record<string, string> = {};
    for (const [componentName, vars] of pool) {
      for (const [key, value] of Object.entries(vars)) {
        // Add both namespaced (component.KEY) and bare (KEY) for resolution.
        // Namespaced keys allow ${service.redis.host} to resolve in components
        // via the flat pool's resolveVariables pass.
        flat[`${componentName}.${key}`] = value;
        flat[key] = value;
      }
    }
    return flat;
  }

  /**
   * Rebuild the scoped componentPool from the resolved flat pool.
   * This ensures validation sees fully resolved values (e.g., ${service.*} expanded).
   */
  private rebuildComponentPool(
    original: Map<string, Record<string, string>>,
    resolvedFlat: Record<string, string>
  ): Map<string, Record<string, string>> {
    const rebuilt = new Map<string, Record<string, string>>();
    for (const [componentName, vars] of original) {
      const resolvedVars: Record<string, string> = {};
      for (const key of Object.keys(vars)) {
        const flatKey = `${componentName}.${key}`;
        resolvedVars[key] = resolvedFlat[flatKey] ?? vars[key];
      }
      rebuilt.set(componentName, resolvedVars);
    }
    return rebuilt;
  }

  /**
   * Legacy: load components into flat NAMESPACE-prefixed pool.
   */
  private async loadFlatComponentPool(components: Components): Promise<Record<string, string>> {
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
          continue;
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

  /**
   * Legacy: Load a component config section with NAMESPACE prefixing.
   */
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
        result[finalKey] = quotedValues[key] || String(value);
      }

      return result;
    } catch (error) {
      throw new Error(`Failed to parse ${filePath}: ${error}`);
    }
  }

  /**
   * New format: Load a component config section WITHOUT NAMESPACE prefixing.
   * Keys are stored as-is from the INI section. NAMESPACE directive is ignored.
   */
  private loadComponentConfigRaw(
    filePath: string,
    environment: string
  ): Record<string, string> | null {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const config = ini.parse(content) as EnvironmentConfig;
      const quotedValues = this.extractQuotedValues(content, environment);

      const envConfig = config[environment];
      if (!envConfig) return null;

      const result: Record<string, string> = {};
      for (const [key, value] of Object.entries(envConfig)) {
        result[key] = quotedValues[key] || String(value);
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

  private resolveVariables(vars: Record<string, string>, quiet: boolean = false): Record<string, string> {
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

    if (!quiet) {
      if (pass >= maxPasses) {
        console.warn(`⚠️ Variable resolution hit ${maxPasses} passes — possible circular reference.`);
      }

      for (const [key, value] of Object.entries(resolved)) {
        if (typeof value === 'string' && /\$\{([^}]+)\}/.test(value)) {
          const unresolved = value.match(/\$\{([^}]+)\}/g) || [];
          console.warn(`⚠️ Unresolved variables in ${key}: ${unresolved.join(', ')}`);
        }
      }
    }

    return resolved;
  }

  /**
   * Deep-resolve ${...} references in an arbitrary object (config, profileOverrides, etc.)
   * using the resolved variable pool.
   */
  private resolveConfigValues<T>(obj: T, pool: Record<string, string>): T {
    if (typeof obj === 'string') {
      return obj.replace(/\$\{([^}]+)\}/g, (match, varName) => {
        return pool[varName] ?? match;
      }) as unknown as T;
    }
    if (Array.isArray(obj)) {
      return obj.map(item => this.resolveConfigValues(item, pool)) as unknown as T;
    }
    if (obj && typeof obj === 'object') {
      const result: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(obj)) {
        result[key] = this.resolveConfigValues(value, pool);
      }
      return result as T;
    }
    return obj;
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

    if (
      (str.startsWith('"') && str.endsWith('"')) ||
      (str.startsWith("'") && str.endsWith("'"))
    ) {
      str = str.slice(1, -1);
    }

    if (str.trim().startsWith('[') || str.trim().startsWith('{')) {
      return `'${str.replace(/'/g, "'\\''")}'`;
    }

    if (/^\$\{[^}]+\}$/.test(str) || /^[a-z]+:\/\//.test(str)) {
      return str;
    }

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
