import { Command } from 'commander';
import chalk from 'chalk';
import { EnvironmentBuilder } from '../../src/index.js';

export function registerBuildCommand(program: Command): void {
  program
    .command('build')
    .description('Build .env files from a profile')
    .option('-p, --profile [name]', 'Profile name (or set CE_PROFILE env var, defaults to "default")')
    .option('-o, --output <path>', 'Output path for single-file builds', '.env')
    .action(async (options) => {
      const configDir = process.cwd();
      const profile: string =
        typeof options.profile === 'string' ? options.profile
        : process.env.CE_PROFILE || process.env.CENV_PROFILE || 'default';
      const builder = new EnvironmentBuilder(configDir, options.output, profile);

      try {
        console.log(chalk.blue(`Building from profile: ${profile}`));
        const result = await builder.buildFromProfile(profile);

        if (result.success) {
          console.log(chalk.green(`\u2705 Environment built successfully`));
          if (result.warnings?.length) {
            result.warnings.forEach(w => console.log(chalk.yellow(`   ${w}`)));
          }
          console.log(chalk.gray(`   Files: ${result.envPath}`));
        } else {
          console.error(chalk.red('\u274c Build failed:'));
          result.errors?.forEach(e => console.error(chalk.red(`   ${e}`)));
          if (result.warnings?.length) {
            result.warnings.forEach(w => console.log(chalk.yellow(`   ${w}`)));
          }
          process.exit(1);
        }
      } catch (error) {
        console.error(chalk.red(`\u274c Unexpected error: ${error}`));
        process.exit(1);
      }
    });
}
