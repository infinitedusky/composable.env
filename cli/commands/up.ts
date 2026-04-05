import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { Command } from 'commander';
import chalk from 'chalk';
import { loadConfig, ContractManager } from '../../src/index.js';
import type { CeConfig } from '../../src/index.js';
import { EnvironmentBuilder } from '../../src/index.js';

function resolveProfile(
  explicit: string | undefined,
  positional: string | undefined,
  cwd: string,
  config: CeConfig
): string {
  if (explicit) return explicit;

  if (positional) {
    const builder = new EnvironmentBuilder(cwd, '', undefined, config.envDir);
    const known = new Set(builder.listProfiles().map(p => p.name));
    if (known.has(positional)) return positional;
  }

  return process.env.CE_PROFILE || process.env.CENV_PROFILE || config.defaultProfile;
}

function findComposeFile(cwd: string): string | null {
  for (const name of ['docker-compose.yml', 'docker-compose.yaml']) {
    if (fs.existsSync(path.join(cwd, name))) {
      return name;
    }
  }
  return null;
}

export function registerUpCommand(program: Command): void {
  program
    .command('dc:up')
    .alias('up')
    .description('Build env and start Docker Compose services for a profile')
    .argument('[profile]', 'Profile name')
    .option('-p, --profile <name>', 'Profile name (alternative to positional arg)')
    .option('--no-build-image', 'Skip Docker image build (no --build flag)')
    .option('--serve [services...]', 'Run host-side builds then start with serve config. Optionally specify service names, or omit for all.')
    .action(async (
      positional: string | undefined,
      options: {
        profile?: string;
        buildImage: boolean;
        serve?: boolean | string[];
      }
    ) => {
      const cwd = process.cwd();
      const config = loadConfig(cwd);
      const profile = resolveProfile(options.profile, positional, cwd, config);

      // Serve mode: run host-side builds for contracts with serve.build
      const serveServices: Set<string> | 'all' | false =
        options.serve === true ? 'all' :
        Array.isArray(options.serve) ? new Set(options.serve) :
        false;

      if (serveServices) {
        console.log(chalk.blue(
          serveServices === 'all'
            ? 'Serve mode: building all services...'
            : `Serve mode: building ${[...serveServices].join(', ')}...`
        ));
        const contractManager = new ContractManager(cwd, config.envDir);
        await contractManager.initialize();
        const contracts = contractManager.getContracts();

        // Collect env vars from all .env.{profile} files
        const envFromProfile: Record<string, string> = {};
        for (const [, contract] of contracts) {
          if (!contract.location) continue;
          const contractEnvFile = path.join(cwd, contract.location, `.env.${profile}`);
          if (fs.existsSync(contractEnvFile)) {
            const content = fs.readFileSync(contractEnvFile, 'utf8');
            for (const line of content.split('\n')) {
              const trimmed = line.trim();
              if (!trimmed || trimmed.startsWith('#')) continue;
              const eqIdx = trimmed.indexOf('=');
              if (eqIdx > 0) {
                envFromProfile[trimmed.substring(0, eqIdx)] = trimmed.substring(eqIdx + 1);
              }
            }
          }
        }

        // Run host-side builds for matching contracts
        for (const [serviceName, contract] of contracts) {
          if (!contract.serve?.build) continue;
          if (serveServices !== 'all' && !serveServices.has(serviceName)) continue;
          console.log(chalk.blue(`  Building ${serviceName}: ${contract.serve.build}`));
          try {
            execSync(contract.serve.build, {
              cwd,
              stdio: 'inherit',
              env: { ...process.env, ...envFromProfile },
            });
          } catch {
            console.error(chalk.red(`  Failed to build ${serviceName}`));
            process.exit(1);
          }
        }

        // Rebuild env with serve config overrides applied (only for served services)
        const serveArg = serveServices === 'all'
          ? '--serve'
          : `--serve ${[...serveServices].join(' ')}`;
        console.log(chalk.blue('Rebuilding compose with serve config...'));
        try {
          execSync(`npx ce env:build ${profile} ${serveArg}`, { cwd, stdio: 'inherit' });
        } catch {
          console.error(chalk.red('Failed to rebuild environment.'));
          process.exit(1);
        }
      }

      // 1. Find compose file
      const composeFile = findComposeFile(cwd);
      if (!composeFile) {
        console.error(chalk.red('No docker-compose.yml found. Run ce env:build first.'));
        process.exit(1);
      }

      // 2. Down existing services for this profile
      console.log(chalk.blue(`Stopping existing ${profile} services...`));
      try {
        execSync(
          `docker compose -f ${composeFile} --profile ${profile} down`,
          { cwd, stdio: 'inherit' }
        );
      } catch {
        // May not be running — fine
      }

      // 3. Up with profile
      const buildFlag = options.buildImage ? ' --build' : '';
      console.log(chalk.blue(`Starting ${profile} services...`));
      try {
        execSync(
          `docker compose -f ${composeFile} --profile ${profile} up -d${buildFlag}`,
          { cwd, stdio: 'inherit' }
        );
        console.log(chalk.green(`\nServices running with profile: ${profile}`));
      } catch {
        console.error(chalk.red('Failed to start Docker Compose services.'));
        process.exit(1);
      }
    });

  program
    .command('dc:down')
    .alias('down')
    .description('Stop Docker Compose services for a profile')
    .argument('[profile]', 'Profile name')
    .option('-p, --profile <name>', 'Profile name')
    .option('-v, --volumes', 'Also remove volumes')
    .action(async (
      positional: string | undefined,
      options: {
        profile?: string;
        volumes?: boolean;
      }
    ) => {
      const cwd = process.cwd();
      const config = loadConfig(cwd);
      const profile = resolveProfile(options.profile, positional, cwd, config);

      const composeFile = findComposeFile(cwd);
      if (!composeFile) {
        console.error(chalk.red('No docker-compose.yml found.'));
        process.exit(1);
      }

      const volumeFlag = options.volumes ? ' -v' : '';
      console.log(chalk.blue(`Stopping ${profile} services...`));
      try {
        execSync(
          `docker compose -f ${composeFile} --profile ${profile} down${volumeFlag}`,
          { cwd, stdio: 'inherit' }
        );
        console.log(chalk.green(`Services stopped${options.volumes ? ' (volumes removed)' : ''}.`));
      } catch {
        console.error(chalk.red('Failed to stop services.'));
        process.exit(1);
      }
    });

  program
    .command('dc:logs')
    .alias('logs')
    .description('Tail Docker Compose logs for a profile')
    .argument('[profile]', 'Profile name')
    .option('-p, --profile <name>', 'Profile name')
    .option('-f, --follow', 'Follow log output', true)
    .option('--service <name>', 'Show logs for a specific service only')
    .action(async (
      positional: string | undefined,
      options: {
        profile?: string;
        follow?: boolean;
        service?: string;
      }
    ) => {
      const cwd = process.cwd();
      const config = loadConfig(cwd);
      const profile = resolveProfile(options.profile, positional, cwd, config);

      const composeFile = findComposeFile(cwd);
      if (!composeFile) {
        console.error(chalk.red('No docker-compose.yml found.'));
        process.exit(1);
      }

      const followFlag = options.follow ? ' -f' : '';
      const serviceArg = options.service ? ` ${options.service}` : '';
      try {
        execSync(
          `docker compose -f ${composeFile} --profile ${profile} logs${followFlag}${serviceArg}`,
          { cwd, stdio: 'inherit' }
        );
      } catch {
        // User ctrl+c'd — fine
      }
    });

  program
    .command('dc:ps')
    .alias('ps')
    .description('Show status of Docker Compose services')
    .argument('[profile]', 'Profile name')
    .option('-p, --profile <name>', 'Profile name')
    .action(async (
      positional: string | undefined,
      options: { profile?: string }
    ) => {
      const cwd = process.cwd();
      const config = loadConfig(cwd);
      const profile = resolveProfile(options.profile, positional, cwd, config);

      const composeFile = findComposeFile(cwd);
      if (!composeFile) {
        console.error(chalk.red('No docker-compose.yml found.'));
        process.exit(1);
      }

      try {
        execSync(
          `docker compose -f ${composeFile} --profile ${profile} ps`,
          { cwd, stdio: 'inherit' }
        );
      } catch {
        console.error(chalk.red('Failed to get service status.'));
        process.exit(1);
      }
    });
}
