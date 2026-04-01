import { Command } from 'commander';
import chalk from 'chalk';
import { EnvironmentBuilder, loadConfig } from '../../src/index.js';

export function registerBuildCommand(program: Command): void {
  // ce env:build <profile> — build a single profile (required)
  program
    .command('env:build')
    .alias('build')
    .description('Build .env files for a single profile')
    .argument('<profile>', 'Profile name to build (e.g., local, production, default)')
    .action(async (profile: string) => {
      const configDir = process.cwd();
      const config = loadConfig(configDir);
      const builder = new EnvironmentBuilder(configDir, '.env', profile, config.envDir);

      try {
        console.log(chalk.blue(`Building from profile: ${profile}`));
        const result = await builder.buildFromProfile(profile);

        printResult(result);
      } catch (error) {
        console.error(chalk.red(`❌ Unexpected error: ${error}`));
        process.exit(1);
      }
    });

  // ce env:build:all — build all profiles
  program
    .command('env:build:all')
    .alias('build:all')
    .description('Build .env files for all profiles')
    .action(async () => {
      const configDir = process.cwd();
      const config = loadConfig(configDir);
      const builder = new EnvironmentBuilder(configDir, '.env', undefined, config.envDir);

      try {
        const allProfiles = builder.discoverAllProfileNames();
        if (allProfiles.length === 0) {
          console.error(chalk.red('❌ No profiles found. Create profile JSON files in env/profiles/.'));
          process.exit(1);
        }

        console.log(chalk.blue(`Building all profiles: ${allProfiles.join(', ')}`));
        const profileSuffixes = config.profiles
          ? Object.fromEntries(Object.entries(config.profiles).map(([name, cfg]) => [name, cfg.suffix]))
          : undefined;
        const result = await builder.buildAllProfiles(undefined, profileSuffixes, config.profiles);

        printResult(result);
      } catch (error) {
        console.error(chalk.red(`❌ Unexpected error: ${error}`));
        process.exit(1);
      }
    });
}

function printResult(result: { success: boolean; envPath: string; errors?: string[]; warnings?: string[] }): void {
  if (result.success) {
    console.log(chalk.green(`✅ Environment built successfully`));
    if (result.warnings?.length) {
      result.warnings.forEach(w => console.log(chalk.yellow(`   ${w}`)));
    }
    console.log(chalk.gray(`   Files: ${result.envPath}`));
  } else {
    console.error(chalk.red('❌ Build failed:'));
    result.errors?.forEach(e => console.error(chalk.red(`   ${e}`)));
    if (result.warnings?.length) {
      result.warnings.forEach(w => console.log(chalk.yellow(`   ${w}`)));
    }
    process.exit(1);
  }
}
