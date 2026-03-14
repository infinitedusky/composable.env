import { Command } from 'commander';
import chalk from 'chalk';
import { EnvironmentBuilder } from '../../src/index.js';

export function registerListCommand(program: Command): void {
  program
    .command('list')
    .description('List available profiles')
    .action(() => {
      const builder = new EnvironmentBuilder(process.cwd(), '');

      const profiles = builder.listProfiles();
      if (profiles.length === 0) {
        console.log(chalk.yellow('No profiles found in env/profiles/'));
        return;
      }

      console.log(chalk.blue('Available profiles:'));
      profiles.forEach(({ name, description }) => {
        console.log(`  ${chalk.green(name)}`);
        console.log(chalk.gray(`    ${description}`));
      });
    });
}
