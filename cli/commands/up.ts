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
    .option('--no-cache', 'Force rebuild from scratch (no Docker cache)')
    .option('--serve [services...]', 'Run host-side builds then start with serve config. Optionally specify service names, or omit for all.')
    .action(async (
      positional: string | undefined,
      options: {
        profile?: string;
        buildImage: boolean;
        noCache?: boolean;
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

        // Run host-side builds for matching contracts
        // Each build only gets its OWN contract's env vars — not all contracts.
        // This prevents vars like NODE_OPTIONS from one contract polluting another's build.
        for (const [serviceName, contract] of contracts) {
          if (serveServices !== 'all' && !serveServices.has(serviceName)) continue;
          // serve mode only applies to docker-compose targets
          if (contract.target?.type !== 'docker-compose') continue;

          // Derive build command: serve.build > turbo build --filter={command}
          const buildCmd = contract.serve?.build
            || (contract.target.config?.command
              ? `turbo build --filter=${contract.target.config.command as string}`
              : null);
          if (!buildCmd) continue;

          // Load only this contract's env file
          const contractEnv: Record<string, string> = {};
          if (contract.location) {
            const envFile = path.join(cwd, contract.location, `.env.${profile}`);
            if (fs.existsSync(envFile)) {
              const content = fs.readFileSync(envFile, 'utf8');
              for (const line of content.split('\n')) {
                const trimmed = line.trim();
                if (!trimmed || trimmed.startsWith('#')) continue;
                const eqIdx = trimmed.indexOf('=');
                if (eqIdx > 0) {
                  contractEnv[trimmed.substring(0, eqIdx)] = trimmed.substring(eqIdx + 1);
                }
              }
            }
          }

          console.log(chalk.blue(`  Building ${serviceName}: ${buildCmd}`));
          try {
            execSync(buildCmd, {
              cwd,
              stdio: 'inherit',
              env: { ...process.env, ...contractEnv },
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

      // TLS: generate mkcert certs if profile has tls: true
      const profileConfig = config.profiles?.[profile];
      if (profileConfig?.tls && profileConfig?.domain) {
        const domain = profileConfig.domain;
        const certDir = path.join(cwd, '.certs', domain);
        const certFile = path.join(certDir, 'cert.pem');

        if (!fs.existsSync(certFile)) {
          console.log(chalk.blue(`Generating TLS certs for *.${domain}...`));

          // Check mkcert is installed
          try {
            execSync('mkcert -version', { stdio: 'pipe' });
          } catch {
            console.error(chalk.red('mkcert is not installed. Install with: brew install mkcert'));
            console.error(chalk.gray('Then run: mkcert -install'));
            process.exit(1);
          }

          if (!fs.existsSync(certDir)) {
            fs.mkdirSync(certDir, { recursive: true });
          }

          try {
            // Generate wildcard cert + copy rootCA
            execSync(
              `mkcert -cert-file "${path.join(certDir, 'cert.pem')}" -key-file "${path.join(certDir, 'key.pem')}" "*.${domain}" "${domain}"`,
              { cwd, stdio: 'inherit' }
            );

            // Copy rootCA.pem so containers can trust it
            const caRoot = execSync('mkcert -CAROOT', { encoding: 'utf8' }).trim();
            const rootCA = path.join(caRoot, 'rootCA.pem');
            if (fs.existsSync(rootCA)) {
              fs.copyFileSync(rootCA, path.join(certDir, 'rootCA.pem'));
            }

            console.log(chalk.green(`  Certs generated in .certs/${domain}/`));

            // Gitignore .certs/
            const gitignorePath = path.join(cwd, '.gitignore');
            if (fs.existsSync(gitignorePath)) {
              const content = fs.readFileSync(gitignorePath, 'utf8');
              if (!content.includes('.certs/')) {
                fs.writeFileSync(gitignorePath, content + '\n.certs/\n');
              }
            }
          } catch {
            console.error(chalk.red('Failed to generate TLS certs.'));
            process.exit(1);
          }
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
      const noCacheFlag = options.noCache ? ' --no-cache' : '';
      console.log(chalk.blue(`Starting ${profile} services...`));
      try {
        execSync(
          `docker compose -f ${composeFile} --profile ${profile} up -d${buildFlag}${noCacheFlag} --remove-orphans`,
          { cwd, stdio: 'inherit' }
        );
        console.log(chalk.green(`\nServices running with profile: ${profile}`));
      } catch {
        console.error(chalk.red('Failed to start Docker Compose services.'));
        process.exit(1);
      }

      // 4. Prune dangling images and old build cache to reclaim disk space
      try {
        execSync('docker image prune -f', { cwd, stdio: 'pipe' });
        execSync('docker builder prune -f --filter until=24h', { cwd, stdio: 'pipe' });
      } catch {
        // Non-critical — don't fail if prune errors
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
