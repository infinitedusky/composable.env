import * as fs from 'fs';
import * as path from 'path';
import { Command } from 'commander';
import chalk from 'chalk';
import {
  ManagedJsonRegistry,
  wrapWithMarkers,
  hasMarkerBlock,
  replaceMarkerBlock,
} from '../../src/index.js';

export function registerInitCommand(program: Command): void {
  program
    .command('init')
    .description('Scaffold a new composable.env directory structure')
    .option('--examples', 'Include example files for all parts of the system')
    .action(async (options) => {
      const cwd = process.cwd();
      const registry = new ManagedJsonRegistry(cwd);

      const dirs = [
        'env/components',
        'env/profiles',
        'env/contracts',
        'env/execution',
      ];

      for (const dir of dirs) {
        const fullPath = path.join(cwd, dir);
        if (!fs.existsSync(fullPath)) {
          fs.mkdirSync(fullPath, { recursive: true });
          console.log(chalk.green(`  created ${dir}/`));
        }
      }

      // Scaffold .env.secrets.shared (team secrets, encrypted via vault)
      const secretsSharedPath = path.join(cwd, 'env/.env.secrets.shared');
      if (!fs.existsSync(secretsSharedPath)) {
        fs.writeFileSync(
          secretsSharedPath,
          '# Team secrets — encrypted via vault, safe to commit\n' +
            '# Set secrets with: ce vault set <KEY> <VALUE>\n' +
            '# Values stored as CENV_ENC[...] are encrypted at rest\n'
        );
        console.log(chalk.green('  created env/.env.secrets.shared'));
      }

      // Scaffold .env.secrets.local (personal secret overrides, gitignored)
      const secretsLocalPath = path.join(cwd, 'env/.env.secrets.local');
      if (!fs.existsSync(secretsLocalPath)) {
        fs.writeFileSync(
          secretsLocalPath,
          '# Personal secret overrides — DO NOT commit (gitignored)\n' +
            '# Override team secrets for local development\n'
        );
        console.log(chalk.green('  created env/.env.secrets.local'));
      }

      // Scaffold .env.local (personal non-secret overrides)
      const localPath = path.join(cwd, 'env/.env.local');
      if (!fs.existsSync(localPath)) {
        fs.writeFileSync(
          localPath,
          '# Personal overrides — DO NOT commit this file (gitignored)\n' +
            '# Applied last, overrides everything else\n'
        );
        console.log(chalk.green('  created env/.env.local'));
      }

      // Scaffold .gitignore with markers
      const gitignorePath = path.join(cwd, '.gitignore');
      const gitignoreEntries = [
        'env/.env.secrets.local',
        'env/.env.local',
        'env/execution/*.cjs',
        '# Legacy patterns',
        '.ce.*',
      ].join('\n');
      if (fs.existsSync(gitignorePath)) {
        let content = fs.readFileSync(gitignorePath, 'utf8');
        if (hasMarkerBlock(content)) {
          content = replaceMarkerBlock(content, gitignoreEntries);
        } else {
          content += '\n' + wrapWithMarkers(gitignoreEntries);
        }
        fs.writeFileSync(gitignorePath, content);
        console.log(chalk.green('  updated .gitignore'));
      } else {
        fs.writeFileSync(gitignorePath, wrapWithMarkers(gitignoreEntries));
        console.log(chalk.green('  created .gitignore'));
      }

      // Detect turbo.json and add globalDependencies
      const turboPath = path.join(cwd, 'turbo.json');
      if (fs.existsSync(turboPath)) {
        const turbo = JSON.parse(fs.readFileSync(turboPath, 'utf8'));
        const deps: string[] = turbo.globalDependencies || [];
        const toAdd = ['env/**'];
        let changed = false;

        for (const entry of toAdd) {
          if (!deps.includes(entry)) {
            deps.push(entry);
            changed = true;
          }
        }

        if (changed) {
          turbo.globalDependencies = deps;
          fs.writeFileSync(turboPath, JSON.stringify(turbo, null, 2) + '\n');
          registry.register('turbo.json', 'globalDependencies', toAdd);
          console.log(chalk.green('  updated turbo.json globalDependencies'));
        }
      }

      // Scaffold example files when --examples is passed
      if (options.examples) {
        scaffoldExamples(cwd, secretsSharedPath, secretsLocalPath, localPath);
      }

      console.log('');
      console.log(chalk.blue('Next steps:'));
      console.log('  1. Add component files to env/components/  (auto-discovered)');
      console.log('  2. Add profiles to env/profiles/  (optional overrides)');
      console.log('  3. Add contract files to env/contracts/  (optional)');
      console.log('  4. Set up vault for secrets: ce vault init');
      console.log('  5. Add secrets: ce vault set <KEY> <VALUE>');
      console.log('  6. Add local overrides to env/.env.local  (gitignored)');
      console.log('  7. Run: ce build --profile <name>');
    });
}

function scaffoldExamples(
  cwd: string,
  secretsSharedPath: string,
  secretsLocalPath: string,
  localPath: string
): void {
  console.log('');
  console.log(chalk.blue('Scaffolding examples...'));

  // New format: components without NAMESPACE, using ${secrets.KEY} references
  const exampleComponents: Record<string, string> = {
    'database.env':
      '; database.env — everything about the database, in one place\n\n' +
      '[default]\n' +
      'HOST=localhost\nPORT=5432\nNAME=myapp_dev\n' +
      'USER=${secrets.DB_USER}\nPASSWORD=${secrets.DB_PASSWORD}\n' +
      'URL=postgresql://${secrets.DB_USER}:${secrets.DB_PASSWORD}@localhost:5432/myapp_dev\n\n' +
      '[staging]\n' +
      'HOST=${secrets.DB_HOST}\nNAME=myapp_staging\n' +
      'URL=postgresql://${secrets.DB_USER}:${secrets.DB_PASSWORD}@${secrets.DB_HOST}:5432/myapp_staging\n\n' +
      '[production]\n' +
      'HOST=${secrets.DB_HOST}\nNAME=myapp\n' +
      'URL=postgresql://${secrets.DB_USER}:${secrets.DB_PASSWORD}@${secrets.DB_HOST}:5432/myapp\n',
    'redis.env':
      '; redis.env — Redis connection and config\n\n' +
      '[default]\n' +
      'HOST=localhost\nPORT=6379\nURL=redis://localhost:6379\nDB=0\n\n' +
      '[staging]\n' +
      'HOST=${secrets.REDIS_HOST}\nURL=redis://${secrets.REDIS_HOST}:6379\n\n' +
      '[production]\n' +
      'HOST=${secrets.REDIS_HOST}\nURL=redis://${secrets.REDIS_HOST}:6379\nDB=0\n',
  };

  const exampleProfiles: Record<string, object> = {
    'production.json': {
      name: 'Production',
      description: 'Production environment with remote services',
    },
    'staging.json': {
      name: 'Staging',
      description: 'Staging environment — extends production',
      extends: 'production',
    },
  };

  // New format contract with vars
  const exampleContract = {
    name: 'api',
    location: 'apps/api',
    vars: {
      DATABASE_URL: '${database.URL}',
      REDIS_URL: '${redis.URL}',
    },
    defaults: {
      LOG_LEVEL: 'info',
    },
    dev: {
      command: 'pnpm dev',
      label: 'API Server',
    },
  };

  // Scaffold .recipients example
  const recipientsPath = path.join(cwd, 'env/.recipients');
  if (!fs.existsSync(recipientsPath)) {
    fs.writeFileSync(
      recipientsPath,
      '# composable.env vault recipients\n' +
        '# Each line: public key [optional comment]\n' +
        '#\n' +
        '# Add team members with: ce vault add --github <username>\n' +
        '# Add keys directly with: ce vault add --key "age1..." --comment "name"\n' +
        '#\n' +
        '# Supported key types:\n' +
        '#   age1...           (native age public key)\n' +
        '#   ssh-ed25519 AAAA... (SSH ed25519 public key)\n' +
        '#\n'
    );
    console.log(chalk.green('  created env/.recipients'));
  }

  const exampleSecretsShared =
    '# Team secrets — encrypted via vault, safe to commit\n' +
    '# Set secrets with: ce vault set <KEY> <VALUE>\n\n' +
    '# Database credentials\n' +
    '# DB_USER=CENV_ENC[...]\n' +
    '# DB_PASSWORD=CENV_ENC[...]\n' +
    '# DB_HOST=CENV_ENC[...]\n\n' +
    '# Redis\n' +
    '# REDIS_HOST=CENV_ENC[...]\n';

  const exampleSecretsLocal =
    '# Personal secret overrides — DO NOT commit (gitignored)\n' +
    '# Override team secrets for local development\n\n' +
    'DB_USER=postgres\n' +
    'DB_PASSWORD=postgres\n' +
    'DB_HOST=localhost\n' +
    'REDIS_HOST=localhost\n';

  const exampleLocal =
    '# Personal overrides — DO NOT commit this file (gitignored)\n\n' +
    '# Verbose logging during development\n' +
    'LOG_LEVEL=debug\n';

  // Write components
  for (const [filename, content] of Object.entries(exampleComponents)) {
    const filePath = path.join(cwd, 'env/components', filename);
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, content);
      console.log(chalk.green(`  created env/components/${filename}`));
    }
  }

  // Write profiles
  for (const [filename, data] of Object.entries(exampleProfiles)) {
    const filePath = path.join(cwd, 'env/profiles', filename);
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
      console.log(chalk.green(`  created env/profiles/${filename}`));
    }
  }

  // Write contract
  const contractPath = path.join(cwd, 'env/contracts/api.contract.json');
  if (!fs.existsSync(contractPath)) {
    fs.writeFileSync(contractPath, JSON.stringify(exampleContract, null, 2) + '\n');
    console.log(chalk.green('  created env/contracts/api.contract.json'));
  }

  // Write secrets files
  fs.writeFileSync(secretsSharedPath, exampleSecretsShared);
  console.log(chalk.green('  updated env/.env.secrets.shared with example values'));
  fs.writeFileSync(secretsLocalPath, exampleSecretsLocal);
  console.log(chalk.green('  updated env/.env.secrets.local with example overrides'));
  fs.writeFileSync(localPath, exampleLocal);
  console.log(chalk.green('  updated env/.env.local with example overrides'));
}
