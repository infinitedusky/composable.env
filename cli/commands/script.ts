import * as fs from 'fs';
import * as path from 'path';
import { Command } from 'commander';
import chalk from 'chalk';
import { EnvironmentBuilder, ContractManager, ManagedJsonRegistry, loadConfig, saveConfig } from '../../src/index.js';
import type { CeScriptsConfig } from '../../src/index.js';

export function registerScriptCommand(program: Command): void {
  program
    .command('script')
    .description('Inject profile-aware scripts into package.json')
    .argument('<name>', 'Script name (e.g., "dev", "build")')
    .requiredOption('-c, --command <cmd>', 'Command to wrap (e.g., "turbo dev")')
    .action((name: string, options: { command: string }) => {
      const cwd = process.cwd();
      const config = loadConfig(cwd);
      const builder = new EnvironmentBuilder(cwd, '', undefined, config.envDir);
      const profiles = builder.listProfiles();

      if (profiles.length === 0) {
        console.error(chalk.red(`\u274c No profiles found in ${config.envDir}/profiles/`));
        process.exit(1);
      }

      const scripts: Record<string, string> = {};

      // Default profile gets the base name
      scripts[name] = `ce run --profile ${config.defaultProfile} -- ${options.command}`;

      // Every other profile gets name:profile
      for (const profile of profiles) {
        if (profile.name === config.defaultProfile) continue;
        scripts[`${name}:${profile.name}`] =
          `ce run --profile ${profile.name} -- ${options.command}`;
      }

      writeScripts(cwd, scripts);
    });

  program
    .command('scripts')
    .description('Generate per-app dev/build/start scripts from contracts')
    .requiredOption('-c, --command <cmd>', 'Base command (e.g., "turbo")')
    .option('--actions <actions>', 'Comma-separated actions to generate', 'dev,build,start')
    .action(async (options: { command: string; actions: string }) => {
      const cwd = process.cwd();
      const actions = options.actions.split(',').map(a => a.trim());

      // Save scripts config to ce.json
      const scriptsConfig: CeScriptsConfig = {
        command: options.command,
        actions,
      };
      saveConfig(cwd, { scripts: scriptsConfig });
      console.log(chalk.green('  saved scripts config to ce.json'));

      const scripts = await generateAppScripts(cwd, scriptsConfig);
      if (!scripts) return;
      writeScripts(cwd, scripts);
    });

  program
    .command('scripts:sync')
    .description('Regenerate package.json scripts from ce.json')
    .action(async () => {
      const cwd = process.cwd();
      const config = loadConfig(cwd);

      if (!config.scripts) {
        console.error(chalk.red('\u274c No scripts config in ce.json'));
        console.error(chalk.gray('   Run "ce scripts -c <command>" first to generate it.'));
        process.exit(1);
      }

      const scripts = await generateAppScripts(cwd, config.scripts);
      if (!scripts) return;
      writeScripts(cwd, scripts);
    });

  program
    .command('scripts:register')
    .description('Register existing package.json scripts as ce-managed keys')
    .argument('<names...>', 'Script names to register (e.g., "build:all" "build:docs")')
    .action((names: string[]) => {
      const cwd = process.cwd();
      const pkgPath = path.join(cwd, 'package.json');

      if (!fs.existsSync(pkgPath)) {
        console.error(chalk.red('\u274c package.json not found'));
        process.exit(1);
      }

      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { scripts?: Record<string, string> };
      const pkgScripts = pkg.scripts || {};

      const uniqueNames = [...new Set(names)];
      const missing = uniqueNames.filter(name => !(name in pkgScripts));
      if (missing.length > 0) {
        console.error(chalk.red('\u274c Cannot register missing scripts from package.json:'));
        for (const name of missing) {
          console.error(`  ${chalk.gray('-')} ${name}`);
        }
        process.exit(1);
      }

      const registry = new ManagedJsonRegistry(cwd);
      registry.register('package.json', 'scripts', uniqueNames);

      console.log(chalk.green(`\u2705 Registered ${uniqueNames.length} script(s) as ce-managed:`));
      for (const name of uniqueNames) {
        console.log(`  ${chalk.blue(name)}`);
      }
    });
}

async function generateAppScripts(
  cwd: string,
  scriptsConfig: CeScriptsConfig
): Promise<Record<string, string> | null> {
  const config = loadConfig(cwd);
  const builder = new EnvironmentBuilder(cwd, '', undefined, config.envDir);
  const profiles = builder.listProfiles();

  if (profiles.length === 0) {
    console.error(chalk.red(`\u274c No profiles found in ${config.envDir}/profiles/`));
    process.exit(1);
  }

  const contractManager = new ContractManager(cwd, config.envDir);
  await contractManager.initialize();
  const contracts = contractManager.getContracts();

  if (contracts.size === 0) {
    console.error(chalk.red(`\u274c No contracts found in ${config.envDir}/contracts/`));
    console.error(chalk.gray('   Contracts provide service names for per-app scripts.'));
    process.exit(1);
  }

  const scripts: Record<string, string> = {};

  // env:build — build all .ce files for a profile (profile as positional arg)
  scripts['env:build'] = 'ce build --profile';

  for (const [serviceName] of contracts) {
    for (const action of scriptsConfig.actions) {
      scripts[`${action}:${serviceName}`] =
        `ce run --profile -- ${scriptsConfig.command} ${action} --filter=${serviceName}`;
    }
  }

  // Base commands without app filter
  for (const action of scriptsConfig.actions) {
    scripts[action] = `ce run -- ${scriptsConfig.command} ${action}`;
  }

  // env:start — launch PM2 dev environment (if any contract has a dev field)
  const hasDevContracts = [...contracts.values()].some(c => c.dev);
  if (hasDevContracts) {
    scripts['env:start'] = 'ce start';
  }

  return scripts;
}

function writeScripts(cwd: string, scripts: Record<string, string>): void {
  const pkgPath = path.join(cwd, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    console.error(chalk.red('\u274c package.json not found'));
    process.exit(1);
  }

  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

  // Remove previously managed scripts before writing new ones
  const registry = new ManagedJsonRegistry(cwd);
  const existing = registry.getEntries('package.json');
  if (existing?.keys['scripts']) {
    for (const key of existing.keys['scripts']) {
      delete pkg.scripts?.[key];
    }
  }

  pkg.scripts = { ...pkg.scripts, ...scripts };
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

  // Track managed keys (replaces previous tracking)
  registry.register('package.json', 'scripts', Object.keys(scripts));

  console.log(chalk.green(`\u2705 Injected ${Object.keys(scripts).length} scripts into package.json:`));
  for (const [scriptName, scriptCmd] of Object.entries(scripts)) {
    console.log(`  ${chalk.blue(scriptName)} ${chalk.gray('\u2192')} ${chalk.gray(scriptCmd)}`);
  }
}
