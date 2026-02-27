#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import { EnvironmentBuilder } from '../src/index.js';

const program = new Command();

program
  .name('cenv')
  .description('composable.env — build .env files from components, profiles, and contracts')
  .version('0.1.0');

program
  .command('build')
  .description('Build .env files from a profile')
  .requiredOption('-p, --profile <name>', 'Profile name (e.g., production, staging)')
  .option('-o, --output <path>', 'Output path for single-file builds', '.env')
  .action(async (options) => {
    const configDir = process.cwd();
    const builder = new EnvironmentBuilder(configDir, options.output, options.profile);

    try {
      console.log(chalk.blue(`Building from profile: ${options.profile}`));
      const result = await builder.buildFromProfile(options.profile);

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

program
  .command('init')
  .description('Scaffold a new composable.env directory structure')
  .action(async () => {
    const fs = await import('fs');
    const path = await import('path');
    const cwd = process.cwd();

    const dirs = [
      'env/components',
      'env/profiles',
      'env/contracts',
    ];

    for (const dir of dirs) {
      const fullPath = path.join(cwd, dir);
      if (!fs.existsSync(fullPath)) {
        fs.mkdirSync(fullPath, { recursive: true });
        console.log(chalk.green(`  created ${dir}/`));
      }
    }

    // Scaffold default.json
    const defaultPath = path.join(cwd, 'env/profiles/default.json');
    if (!fs.existsSync(defaultPath)) {
      fs.writeFileSync(
        defaultPath,
        JSON.stringify(
          {
            name: 'Default',
            description: 'All available components',
            components: [],
          },
          null,
          2
        ) + '\n'
      );
      console.log(chalk.green('  created env/profiles/default.json'));
    }

    // Scaffold .gitignore entries
    const gitignorePath = path.join(cwd, '.gitignore');
    const entries = 'env/.env.local\n';
    if (fs.existsSync(gitignorePath)) {
      const existing = fs.readFileSync(gitignorePath, 'utf8');
      if (!existing.includes('env/.env.local')) {
        fs.appendFileSync(gitignorePath, '\n# composable.env\n' + entries);
        console.log(chalk.green('  updated .gitignore'));
      }
    } else {
      fs.writeFileSync(gitignorePath, '# composable.env\n' + entries);
      console.log(chalk.green('  created .gitignore'));
    }

    console.log('');
    console.log(chalk.blue('Next steps:'));
    console.log('  1. Add component files to env/components/');
    console.log('  2. Define profiles in env/profiles/');
    console.log('  3. Add contract files to env/contracts/  (optional)');
    console.log('  4. Add shared values to env/.env.shared  (commit this)');
    console.log('  5. Add local overrides to env/.env.local  (gitignored)');
    console.log('  6. Run: cenv build --profile <name>');
  });

program.parse();
