import { Command } from 'commander';
import chalk from 'chalk';
import { EnvironmentBuilder, ContractManager, loadConfig } from '../../src/index.js';

export function registerBuildCommand(program: Command): void {
  program
    .command('env:build')
    .alias('build')
    .description('Build .env files and docker-compose.yml from contracts')
    .option('-p, --profile [name]', 'Profile name (or set CE_PROFILE env var)')
    .option('-o, --output <path>', 'Output path for single-file builds', '.env')
    .action(async (options) => {
      const configDir = process.cwd();
      const config = loadConfig(configDir);
      const profile: string =
        typeof options.profile === 'string' ? options.profile
        : process.env.CE_PROFILE || process.env.CENV_PROFILE || config.defaultProfile;
      const builder = new EnvironmentBuilder(configDir, options.output, profile, config.envDir);

      try {
        // Check if any contracts have targets — if so, build all profiles
        const contractManager = new ContractManager(configDir, config.envDir);
        await contractManager.initialize();
        const hasTargets = [...contractManager.getContracts().values()].some(c => c.target);

        let result;
        if (hasTargets) {
          const allProfiles = builder.discoverAllProfileNames();
          const explicitProfile = typeof options.profile === 'string' ? options.profile : undefined;
          if (explicitProfile) {
            console.log(chalk.blue(`Building .env for profile: ${explicitProfile}`));
            console.log(chalk.gray(`   Compose file includes all profiles: ${allProfiles.join(', ')}`));
          } else {
            console.log(chalk.blue(`Building all profiles: ${allProfiles.join(', ')}`));
          }
          // Build suffix map from ce.json profiles config
          const profileSuffixes = config.profiles
            ? Object.fromEntries(Object.entries(config.profiles).map(([name, cfg]) => [name, cfg.suffix]))
            : undefined;
          result = await builder.buildAllProfiles(explicitProfile, profileSuffixes, config.profiles);
        } else {
          console.log(chalk.blue(`Building from profile: ${profile}`));
          result = await builder.buildFromProfile(profile);
        }

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
      } catch (error) {
        console.error(chalk.red(`❌ Unexpected error: ${error}`));
        process.exit(1);
      }
    });
}
