import { Command } from 'commander';
import chalk from 'chalk';
import { EnvironmentBuilder, loadConfig } from '../../src/index.js';

export function registerListCommand(program: Command): void {
  program
    .command('profile:list')
    .alias('p:list')
    .description('List available profiles')
    .action(() => {
      const cwd = process.cwd();
      const config = loadConfig(cwd);
      const builder = new EnvironmentBuilder(cwd, '', undefined, config.envDir);

      const profiles = builder.listProfiles();
      if (profiles.length === 0) {
        console.log(chalk.yellow(`No profiles found in ${config.envDir}/profiles/`));
        return;
      }

      console.log(chalk.blue('Available profiles:'));
      profiles.forEach(({ name, description }) => {
        console.log(`  ${chalk.green(name)}`);
        console.log(chalk.gray(`    ${description}`));
      });
    });
}
