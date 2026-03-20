import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { Command } from 'commander';
import chalk from 'chalk';
import { loadConfig } from '../../src/index.js';

export function registerPersistentCommand(program: Command): void {
  const persistent = program
    .command('persistent')
    .description('Manage persistent Docker services (databases, caches, dev tools)');

  persistent
    .command('up')
    .description('Start persistent services (builds first if needed)')
    .option('--profile <name>', 'Docker Compose profile to activate')
    .action(async (options) => {
      const cwd = process.cwd();
      const config = loadConfig(cwd);
      const persistentFile = findPersistentFile(cwd);

      if (!persistentFile) {
        console.log(chalk.yellow(
          'No persistent compose file found. Mark contracts with "persistent": true and run ce build.'
        ));
        return;
      }

      console.log(chalk.blue(`Starting persistent services from ${persistentFile}...`));

      const profileFlag = options.profile ? `--profile ${options.profile}` : '';
      try {
        execSync(
          `docker compose -f ${persistentFile} ${profileFlag} up -d`,
          { cwd, stdio: 'inherit' }
        );
        console.log(chalk.green('Persistent services running.'));
      } catch {
        console.error(chalk.red('Failed to start persistent services.'));
        process.exit(1);
      }
    });

  persistent
    .command('down')
    .description('Stop persistent services (preserves volumes)')
    .action(async () => {
      const cwd = process.cwd();
      const persistentFile = findPersistentFile(cwd);

      if (!persistentFile) {
        console.log(chalk.yellow('No persistent compose file found.'));
        return;
      }

      console.log(chalk.blue(`Stopping persistent services from ${persistentFile}...`));

      try {
        execSync(
          `docker compose -f ${persistentFile} down`,
          { cwd, stdio: 'inherit' }
        );
        console.log(chalk.green('Persistent services stopped. Volumes preserved.'));
      } catch {
        console.error(chalk.red('Failed to stop persistent services.'));
        process.exit(1);
      }
    });

  persistent
    .command('destroy')
    .description('Stop persistent services and remove volumes')
    .action(async () => {
      const cwd = process.cwd();
      const persistentFile = findPersistentFile(cwd);

      if (!persistentFile) {
        console.log(chalk.yellow('No persistent compose file found.'));
        return;
      }

      console.log(chalk.red(`Destroying persistent services and volumes from ${persistentFile}...`));

      try {
        execSync(
          `docker compose -f ${persistentFile} down -v`,
          { cwd, stdio: 'inherit' }
        );
        console.log(chalk.green('Persistent services destroyed. Volumes removed.'));
      } catch {
        console.error(chalk.red('Failed to destroy persistent services.'));
        process.exit(1);
      }
    });

  persistent
    .command('status')
    .description('Show status of persistent services')
    .action(async () => {
      const cwd = process.cwd();
      const persistentFile = findPersistentFile(cwd);

      if (!persistentFile) {
        console.log(chalk.yellow('No persistent compose file found.'));
        return;
      }

      try {
        execSync(
          `docker compose -f ${persistentFile} ps`,
          { cwd, stdio: 'inherit' }
        );
      } catch {
        console.error(chalk.red('Failed to get persistent service status.'));
        process.exit(1);
      }
    });
}

function findPersistentFile(cwd: string): string | null {
  for (const name of ['docker-compose.persistent.yml', 'docker-compose.persistent.yaml']) {
    if (fs.existsSync(path.join(cwd, name))) {
      return name;
    }
  }
  return null;
}
