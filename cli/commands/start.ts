import * as fs from 'fs';
import * as path from 'path';
import { execSync, spawn } from 'child_process';
import { Command } from 'commander';
import chalk from 'chalk';
import { EnvironmentBuilder, ContractManager, loadConfig } from '../../src/index.js';
import type { CeConfig } from '../../src/index.js';
import { ExecutionManager } from '../../src/execution/index.js';

/**
 * Resolve profile from args — same pattern as ce run.
 */
function resolveProfile(
  explicit: string | true | undefined,
  positional: string | undefined,
  cwd: string,
  config: CeConfig
): string {
  if (typeof explicit === 'string') return explicit;

  if (positional) {
    const builder = new EnvironmentBuilder(cwd, '', undefined, config.envDir);
    const known = new Set(builder.listProfiles().map(p => p.name));
    if (known.has(positional)) return positional;
  }

  return process.env.CE_PROFILE || process.env.CENV_PROFILE || config.defaultProfile;
}

export function registerStartCommand(program: Command): void {
  program
    .command('start')
    .description('Build env, generate PM2 ecosystem, and launch dev environment')
    .argument('[profile]', 'Profile name')
    .option('-p, --profile [name]', 'Profile name (alternative to positional arg)')
    .option('--dry-run', 'Generate ecosystem file but do not launch PM2')
    .option('--no-build', 'Skip auto-build step')
    .action(async (
      positional: string | undefined,
      options: {
        profile: string | true | undefined;
        dryRun?: boolean;
        build: boolean;
      }
    ) => {
      const cwd = process.cwd();
      const config = loadConfig(cwd);
      const profile = resolveProfile(options.profile, positional, cwd, config);

      // 1. Build env files
      if (options.build) {
        console.log(chalk.blue(`Building .env.${profile}...`));
        const builder = new EnvironmentBuilder(cwd, '', profile, config.envDir);
        const result = await builder.buildFromProfile(profile);

        if (!result.success) {
          console.error(chalk.red('\u274c Build failed:'));
          result.errors?.forEach(e => console.error(chalk.red(`   ${e}`)));
          process.exit(1);
        }
        console.log(chalk.green('\u2705 Environment built'));
      }

      // 2. Load contracts
      const contractManager = new ContractManager(cwd, config.envDir);
      await contractManager.initialize();
      const contracts = contractManager.getContracts();

      const devContracts = [...contracts.values()].filter(c => c.dev);
      if (devContracts.length === 0) {
        console.error(chalk.red('\u274c No contracts have a "dev" field'));
        console.error(chalk.gray('   Add a "dev" block to your contracts to define how services run.'));
        console.error(chalk.gray('   Example: "dev": { "command": "pnpm dev", "label": "API" }'));
        process.exit(1);
      }

      // 3. Generate PM2 ecosystem config
      const exec = new ExecutionManager(cwd, config.envDir);
      const ecosystemPath = await exec.buildEcosystem(profile, contracts);

      console.log(chalk.green(`\u2705 Ecosystem: ${path.relative(cwd, ecosystemPath)}`));
      console.log(chalk.gray(`   ${devContracts.length} service${devContracts.length > 1 ? 's' : ''}: ${devContracts.map(c => c.dev!.label || c.name).join(', ')}`));

      if (options.dryRun) {
        console.log(chalk.blue('\n--- Generated ecosystem config ---'));
        console.log(fs.readFileSync(ecosystemPath, 'utf8'));
        return;
      }

      // 4. Check PM2 is available
      try {
        execSync('which pm2', { stdio: 'pipe' });
      } catch {
        console.error(chalk.red('\u274c PM2 not found'));
        console.error(chalk.gray('   Install globally: npm install -g pm2'));
        process.exit(1);
      }

      // 5. Stop any existing processes in this namespace
      const ns = exec.namespace(profile);
      try {
        execSync(`pm2 delete ${ns} 2>/dev/null`, { stdio: 'pipe' });
      } catch {
        // No existing processes — fine
      }

      // 6. Start PM2 with ecosystem config
      console.log(chalk.blue(`\nStarting services (namespace: ${ns})...`));
      try {
        execSync(`pm2 start ${ecosystemPath} --namespace ${ns}`, {
          stdio: 'inherit',
          cwd,
        });
      } catch {
        console.error(chalk.red('\u274c Failed to start PM2 processes'));
        process.exit(1);
      }

      // 7. Launch PM2 monit (interactive TUI dashboard)
      console.log(chalk.blue('\nLaunching PM2 dashboard (q to quit)...\n'));
      const child = spawn('pm2', ['monit'], {
        stdio: 'inherit',
      });

      child.on('close', (code) => process.exit(code ?? 0));
      child.on('error', (err) => {
        console.error(chalk.red(`\u274c Failed to launch PM2 monit: ${err.message}`));
        process.exit(1);
      });
    });
}
