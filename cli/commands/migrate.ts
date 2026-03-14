import * as fs from 'fs';
import * as path from 'path';
import * as ini from 'ini';
import { Command } from 'commander';
import chalk from 'chalk';

interface LegacyContract {
  name: string;
  location?: string;
  required?: Record<string, string>;
  optional?: Record<string, string>;
  secret?: Record<string, string>;
  defaults?: Record<string, string>;
  dev?: { command: string; cwd?: string; label?: string };
}

interface ComponentInfo {
  name: string;          // filename without .env
  namespace?: string;    // NAMESPACE directive value
  keys: string[];        // keys in [default] section
}

export function registerMigrateCommand(program: Command): void {
  program
    .command('migrate')
    .description('Migrate legacy contracts and components to the new vars format')
    .option('--dry-run', 'Show what would change without modifying files')
    .action(async (options: { dryRun?: boolean }) => {
      const cwd = process.cwd();
      const dryRun = options.dryRun ?? false;
      const envDir = path.join(cwd, 'env');

      if (!fs.existsSync(envDir)) {
        console.error(chalk.red('\u274c No env/ directory found'));
        process.exit(1);
      }

      if (dryRun) {
        console.log(chalk.blue('Dry run — no files will be modified:\n'));
      }

      const changes: string[] = [];

      // 1. Scan components to build namespace → component reverse map
      const componentsDir = path.join(envDir, 'components');
      const components = scanComponents(componentsDir);
      const namespaceToComponent = buildReverseMap(components);

      // 2. Migrate contracts
      const contractsDir = path.join(envDir, 'contracts');
      if (fs.existsSync(contractsDir)) {
        for (const file of fs.readdirSync(contractsDir).filter(f => f.endsWith('.contract.json'))) {
          const filePath = path.join(contractsDir, file);
          const contract: LegacyContract = JSON.parse(fs.readFileSync(filePath, 'utf8'));

          if (contract.required === undefined && !contract.optional && !contract.secret) {
            // Already new format or empty — skip
            continue;
          }

          if ('vars' in contract) {
            console.log(chalk.gray(`  skip ${file} (already has vars)`));
            continue;
          }

          const migrated = migrateContract(contract, namespaceToComponent);
          const migratedJson = JSON.stringify(migrated, null, 2) + '\n';

          if (!dryRun) {
            fs.writeFileSync(filePath, migratedJson);
          }

          changes.push(`${file} → migrated to vars format`);
          console.log(chalk.green(`  ${dryRun ? 'would migrate' : 'migrated'} ${file}`));
          if (dryRun) {
            console.log(chalk.gray(migratedJson));
          }
        }
      }

      // 3. Migrate components: remove NAMESPACE + rewrite ${VAR} refs to ${secrets.KEY}
      const sharedKeys = loadSharedKeys(envDir);
      for (const comp of components) {
        const filePath = path.join(componentsDir, `${comp.name}.env`);
        let content = fs.readFileSync(filePath, 'utf8');
        let changed = false;

        // Remove NAMESPACE directive
        if (comp.namespace) {
          const newContent = removeNamespaceDirective(content);
          if (newContent !== content) {
            content = newContent;
            changed = true;
            changes.push(`${comp.name}.env → removed NAMESPACE=${comp.namespace}`);
            console.log(chalk.green(`  ${dryRun ? 'would remove' : 'removed'} NAMESPACE from ${comp.name}.env`));
          }
        }

        // Rewrite ${SHARED_KEY} references to ${secrets.KEY} where SHARED_KEY is
        // a key from .env.shared (likely a secret or team value used in non-default sections)
        const rewritten = rewriteSharedRefsToSecrets(content, sharedKeys, comp.namespace);
        if (rewritten !== content) {
          content = rewritten;
          changed = true;
          changes.push(`${comp.name}.env → rewrote shared var refs to \${secrets.KEY}`);
          console.log(chalk.green(`  ${dryRun ? 'would rewrite' : 'rewrote'} shared refs in ${comp.name}.env`));
        }

        if (changed && !dryRun) {
          fs.writeFileSync(filePath, content);
        }
      }

      // 4. Migrate secrets from .env.shared → .env.secrets.shared
      const sharedPath = path.join(envDir, '.env.shared');
      const secretsSharedPath = path.join(envDir, '.env.secrets.shared');
      if (fs.existsSync(sharedPath) && !fs.existsSync(secretsSharedPath)) {
        const lines = fs.readFileSync(sharedPath, 'utf8').split('\n');
        const secretLines: string[] = ['# Team secrets — encrypted via vault, safe to commit'];
        const nonSecretLines: string[] = [];

        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.includes('CENV_ENC[')) {
            secretLines.push(line);
          } else {
            nonSecretLines.push(line);
          }
        }

        if (secretLines.length > 1) {
          if (!dryRun) {
            fs.writeFileSync(secretsSharedPath, secretLines.join('\n') + '\n');
            fs.writeFileSync(sharedPath, nonSecretLines.join('\n'));
          }
          changes.push('.env.shared → split encrypted values into .env.secrets.shared');
          console.log(chalk.green(
            `  ${dryRun ? 'would move' : 'moved'} ${secretLines.length - 1} encrypted value(s) to .env.secrets.shared`
          ));
        }
      }

      // 5. Create .env.secrets.local if it doesn't exist
      const secretsLocalPath = path.join(envDir, '.env.secrets.local');
      if (!fs.existsSync(secretsLocalPath)) {
        if (!dryRun) {
          fs.writeFileSync(
            secretsLocalPath,
            '# Personal secret overrides — DO NOT commit (gitignored)\n'
          );
        }
        changes.push('created env/.env.secrets.local');
        console.log(chalk.green(`  ${dryRun ? 'would create' : 'created'} env/.env.secrets.local`));
      }

      // Summary
      console.log('');
      if (changes.length === 0) {
        console.log(chalk.yellow('Nothing to migrate — already using new format.'));
      } else {
        const verb = dryRun ? 'Would apply' : 'Applied';
        console.log(chalk.green(`${verb} ${changes.length} change(s).`));
        if (dryRun) {
          console.log(chalk.blue('\nRe-run without --dry-run to apply changes.'));
        } else {
          console.log(chalk.blue('\nRun "ce build" to verify the migration produces correct output.'));
        }
      }
    });
}

function scanComponents(dir: string): ComponentInfo[] {
  if (!fs.existsSync(dir)) return [];

  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.env'))
    .map(file => {
      const filePath = path.join(dir, file);
      const content = fs.readFileSync(filePath, 'utf8');
      const parsed = ini.parse(content);
      const name = file.replace('.env', '');
      const namespace = (parsed as Record<string, unknown>)['NAMESPACE'] as string | undefined;
      const defaultSection = parsed['default'] as Record<string, unknown> | undefined;
      const keys = defaultSection ? Object.keys(defaultSection) : [];
      return { name, namespace: namespace || undefined, keys };
    });
}

function buildReverseMap(components: ComponentInfo[]): Map<string, { component: string; key: string }> {
  const map = new Map<string, { component: string; key: string }>();

  for (const comp of components) {
    for (const key of comp.keys) {
      // Map NAMESPACE_KEY → component.KEY
      if (comp.namespace) {
        map.set(`${comp.namespace}_${key}`, { component: comp.name, key });
      }
      // Also map flat KEY → component.KEY (for non-namespaced or ambiguous)
      if (!map.has(key)) {
        map.set(key, { component: comp.name, key });
      }
    }
  }

  return map;
}

function migrateContract(
  contract: LegacyContract,
  reverseMap: Map<string, { component: string; key: string }>
): Record<string, unknown> {
  const vars: Record<string, string> = {};
  const defaults: Record<string, string> = { ...(contract.defaults || {}) };

  // Migrate required mappings
  if (contract.required) {
    for (const [appVar, mapping] of Object.entries(contract.required)) {
      vars[appVar] = convertMapping(mapping, reverseMap);
    }
  }

  // Migrate optional mappings — also add to defaults if not already there
  if (contract.optional) {
    for (const [appVar, mapping] of Object.entries(contract.optional)) {
      vars[appVar] = convertMapping(mapping, reverseMap);
    }
  }

  // Migrate secret mappings
  if (contract.secret) {
    for (const [appVar, mapping] of Object.entries(contract.secret)) {
      vars[appVar] = convertMapping(mapping, reverseMap);
    }
  }

  const result: Record<string, unknown> = {
    name: contract.name,
  };

  if (contract.location) result.location = contract.location;
  result.vars = vars;
  if (Object.keys(defaults).length > 0) result.defaults = defaults;
  if (contract.dev) result.dev = contract.dev;

  return result;
}

/**
 * Convert a legacy mapping to ${component.KEY} syntax.
 *
 * Examples:
 *   "REDIS_URL" → "${redis.URL}" (via reverse map)
 *   "postgresql://${DATABASE_USER}:..." → "postgresql://${database.USER}:..."
 *   "LOG_LEVEL" → "${LOG_LEVEL}" (if not in reverse map, leave as flat ref)
 */
function convertMapping(
  mapping: string,
  reverseMap: Map<string, { component: string; key: string }>
): string {
  // Template string with ${...} references
  if (/\$\{([^}]+)\}/.test(mapping)) {
    return mapping.replace(/\$\{([^}]+)\}/g, (match, varName: string) => {
      const ref = reverseMap.get(varName);
      if (ref) return `\${${ref.component}.${ref.key}}`;
      // Check if it looks like a secret (SECRET_ prefix or not in any component)
      return match;
    });
  }

  // Direct mapping: "REDIS_URL" → "${redis.URL}"
  const ref = reverseMap.get(mapping);
  if (ref) {
    return `\${${ref.component}.${ref.key}}`;
  }

  // Not found in reverse map — could be a variable from .env.shared/.env.local
  // Leave as a flat reference
  return `\${${mapping}}`;
}

function removeNamespaceDirective(content: string): string {
  const lines = content.split('\n');
  const filtered = lines.filter(line => {
    const trimmed = line.trim();
    return !trimmed.startsWith('NAMESPACE=');
  });

  // Clean up any extra blank lines at the top
  while (filtered.length > 0 && filtered[0].trim() === '') {
    filtered.shift();
  }

  return filtered.join('\n');
}

/**
 * Load all keys from .env.shared (both encrypted and plain) to know which
 * ${VAR} references in components should become ${secrets.KEY}.
 */
function loadSharedKeys(envDir: string): Set<string> {
  const keys = new Set<string>();
  const sharedPath = path.join(envDir, '.env.shared');

  if (fs.existsSync(sharedPath)) {
    for (const line of fs.readFileSync(sharedPath, 'utf8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx > 0) {
        keys.add(trimmed.slice(0, eqIdx));
      }
    }
  }

  return keys;
}

/**
 * Rewrite ${NAMESPACE_KEY} or ${SHARED_KEY} references in component files
 * to ${secrets.PLAIN_KEY} where the original key came from .env.shared.
 *
 * For example, if a component has NAMESPACE=DATABASE and .env.shared has
 * DATABASE_PROD_HOST=..., then a reference like ${DATABASE_PROD_HOST} in the
 * component file becomes ${secrets.DATABASE_PROD_HOST}.
 *
 * Also handles plain keys without namespace prefix.
 */
function rewriteSharedRefsToSecrets(
  content: string,
  sharedKeys: Set<string>,
  namespace?: string
): string {
  if (sharedKeys.size === 0) return content;

  return content.replace(/\$\{([^}]+)\}/g, (match, varName: string) => {
    // Already a secrets ref or component ref
    if (varName.includes('.')) return match;

    // Check if this var name exists in .env.shared
    if (sharedKeys.has(varName)) {
      // Strip namespace prefix if present to get a cleaner secret name
      let secretName = varName;
      if (namespace && varName.startsWith(`${namespace}_`)) {
        secretName = varName.slice(namespace.length + 1);
      }
      return `\${secrets.${secretName}}`;
    }

    return match;
  });
}
