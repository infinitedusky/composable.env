import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { Command } from 'commander';
import chalk from 'chalk';
import { loadConfig } from '../../src/index.js';
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
    .command('up')
    .description('Build env and start Docker Compose services for a profile')
    .argument('[profile]', 'Profile name')
    .option('-p, --profile <name>', 'Profile name (alternative to positional arg)')
    .option('--no-build-env', 'Skip ce build step')
    .option('--no-build-image', 'Skip Docker image build (no --build flag)')
    .action(async (
      positional: string | undefined,
      options: {
        profile?: string;
        buildEnv: boolean;
        buildImage: boolean;
      }
    ) => {
      const cwd = process.cwd();
      const config = loadConfig(cwd);
      const profile = resolveProfile(options.profile, positional, cwd, config);

      // 1. Build env files + compose file
      if (options.buildEnv) {
        console.log(chalk.blue(`Building environment for profile: ${profile}...`));
        try {
          execSync(`npx ce build --profile ${profile}`, { cwd, stdio: 'inherit' });
        } catch {
          console.error(chalk.red('Failed to build environment.'));
          process.exit(1);
        }
      }

      // 2. Find compose file
      const composeFile = findComposeFile(cwd);
      if (!composeFile) {
        console.error(chalk.red('No docker-compose.yml found. Run ce build first.'));
        process.exit(1);
      }

      // 3. Down existing services for this profile
      console.log(chalk.blue(`Stopping existing ${profile} services...`));
      try {
        execSync(
          `docker compose -f ${composeFile} --profile ${profile} down`,
          { cwd, stdio: 'inherit' }
        );
      } catch {
        // May not be running — fine
      }

      // 4. Up with profile
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
    .command('down')
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
    .command('logs')
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
    .command('ps')
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
