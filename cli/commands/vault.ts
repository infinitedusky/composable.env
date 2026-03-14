import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { Command } from 'commander';
import chalk from 'chalk';
import { hasMarkerBlock, replaceMarkerBlock, wrapWithMarkers } from '../../src/index.js';

import type { Vault as VaultType } from '../../src/vault.js';

async function loadVault(): Promise<typeof import('../../src/vault.js')> {
  try {
    return await import('../../src/vault.js');
  } catch (e: unknown) {
    const err = e as { code?: string };
    if (err.code === 'ERR_MODULE_NOT_FOUND' || err.code === 'MODULE_NOT_FOUND') {
      console.error(chalk.red('Vault requires additional dependencies:'));
      console.error(chalk.gray('  npm install age-encryption sops-age @noble/curves @scure/base'));
      process.exit(1);
    }
    throw e;
  }
}

async function createVault(cwd: string): Promise<InstanceType<typeof VaultType>> {
  const { Vault } = await loadVault();
  return new Vault(cwd);
}

export function registerVaultCommand(program: Command): void {
  const vault = program
    .command('vault')
    .description('Manage encrypted secrets in .env.secrets.shared');

  // ─── vault init ─────────────────────────────────────────────────────────────

  vault
    .command('init')
    .description('Initialize vault — create .recipients and set up identity')
    .option('--github <username>', 'GitHub username for CODEOWNERS protection')
    .action(async (options: { github?: string }) => {
      const cwd = process.cwd();
      const v = await createVault(cwd);

      if (v.hasVault()) {
        console.log(chalk.yellow('Vault already initialized (.recipients exists).'));
        const recipients = v.listRecipients();
        console.log(`  ${recipients.length} recipient(s) configured.`);
        return;
      }

      const result = await v.init();

      if (result.created) {
        console.log(chalk.green('Created env/.recipients'));
      }

      if (result.identity) {
        console.log(chalk.green(`Using identity: ${result.identity}`));
      }

      if (result.publicKey) {
        const keyPreview = result.publicKey.length > 60
          ? result.publicKey.slice(0, 60) + '...'
          : result.publicKey;
        console.log(chalk.green(`Added public key: ${keyPreview}`));
      }

      // Set up CODEOWNERS protection for .recipients
      const githubUser = options.github ?? inferGitHubUsername();
      if (githubUser) {
        patchCodeowners(cwd, githubUser);
      } else {
        console.log(chalk.gray('  Skipped CODEOWNERS (no GitHub username — use --github <username>)'));
      }

      console.log('');
      console.log(chalk.blue('Next steps:'));
      console.log('  1. Add team members: ce vault add --github <username>');
      console.log('  2. Set a secret:     ce vault set <KEY> <VALUE>');
      console.log('  3. Commit env/.recipients and env/.env.shared');
    });

  // ─── vault set ──────────────────────────────────────────────────────────────

  vault
    .command('set <key> <value>')
    .description('Encrypt a value and store it in .env.shared')
    .action(async (key: string, value: string) => {
      const cwd = process.cwd();
      const v = await createVault(cwd);

      if (!v.hasVault()) {
        console.error(chalk.red('Vault not initialized. Run `ce vault init` first.'));
        process.exit(1);
      }

      await v.setSecret(key, value);
      console.log(chalk.green(`Set ${key} (encrypted to ${v.listRecipients().length} recipient(s))`));
    });

  // ─── vault get ──────────────────────────────────────────────────────────────

  vault
    .command('get <key>')
    .description('Decrypt and print a single secret from .env.shared')
    .action(async (key: string) => {
      const cwd = process.cwd();
      const v = await createVault(cwd);

      if (!v.hasVault()) {
        console.error(chalk.red('Vault not initialized. Run `ce vault init` first.'));
        process.exit(1);
      }

      const value = await v.getSecret(key);
      if (value === null) {
        console.error(chalk.red(`Key '${key}' not found in .env.shared`));
        process.exit(1);
      }

      console.log(value);
    });

  // ─── vault ls ───────────────────────────────────────────────────────────────

  vault
    .command('ls')
    .description('List all encrypted keys in .env.shared (no decryption)')
    .action(async () => {
      const cwd = process.cwd();
      const v = await createVault(cwd);

      const secrets = v.listSecrets();
      if (secrets.length === 0) {
        console.log(chalk.yellow('No encrypted secrets found in .env.shared'));
        return;
      }

      console.log(chalk.blue(`${secrets.length} encrypted secret(s):`));
      for (const key of secrets) {
        console.log(`  ${chalk.gray('-')} ${key}`);
      }
    });

  // ─── vault add ──────────────────────────────────────────────────────────────

  vault
    .command('add')
    .description('Add a recipient (re-encrypts all secrets)')
    .option('--github <username>', 'Fetch SSH keys from GitHub')
    .option('--key <publicKey>', 'Add a raw age or SSH public key')
    .option('--comment <comment>', 'Optional comment for the key')
    .action(async (options: { github?: string; key?: string; comment?: string }) => {
      const cwd = process.cwd();
      const v = await createVault(cwd);

      if (!v.hasVault()) {
        console.error(chalk.red('Vault not initialized. Run `ce vault init` first.'));
        process.exit(1);
      }

      if (options.github) {
        console.log(chalk.blue(`Fetching SSH keys for GitHub user: ${options.github}...`));
        const added = await v.addGitHubRecipient(options.github);

        if (added.length === 0) {
          console.log(chalk.yellow(`All keys for ${options.github} already added.`));
        } else {
          console.log(chalk.green(`Added ${added.length} key(s) for ${options.github}`));
          const secrets = v.listSecrets();
          if (secrets.length > 0) {
            console.log(chalk.blue(`Re-encrypted ${secrets.length} secret(s)`));
          }
        }
      } else if (options.key) {
        await v.addRecipient(options.key, options.comment);
        console.log(chalk.green('Recipient added.'));
        const secrets = v.listSecrets();
        if (secrets.length > 0) {
          console.log(chalk.blue(`Re-encrypted ${secrets.length} secret(s)`));
        }
      } else {
        console.error(chalk.red('Specify --github <username> or --key <publicKey>'));
        process.exit(1);
      }
    });

  // ─── vault remove ───────────────────────────────────────────────────────────

  vault
    .command('remove <identifier>')
    .description('Remove a recipient by key fragment or comment (re-encrypts all secrets)')
    .action(async (identifier: string) => {
      const cwd = process.cwd();
      const v = await createVault(cwd);

      if (!v.hasVault()) {
        console.error(chalk.red('Vault not initialized. Run `ce vault init` first.'));
        process.exit(1);
      }

      const removed = await v.removeRecipient(identifier);
      if (removed) {
        console.log(chalk.green(`Removed recipient matching '${identifier}'`));
        const secrets = v.listSecrets();
        if (secrets.length > 0) {
          console.log(chalk.blue(`Re-encrypted ${secrets.length} secret(s) without their key`));
        }
      } else {
        console.log(chalk.yellow(`No recipient found matching '${identifier}'`));
      }
    });

  // ─── vault recipients ───────────────────────────────────────────────────────

  vault
    .command('recipients')
    .description('List all recipients who can decrypt secrets')
    .action(async () => {
      const cwd = process.cwd();
      const v = await createVault(cwd);

      if (!v.hasVault()) {
        console.error(chalk.red('Vault not initialized. Run `ce vault init` first.'));
        process.exit(1);
      }

      const recipients = v.listRecipients();
      if (recipients.length === 0) {
        console.log(chalk.yellow('No recipients configured.'));
        return;
      }

      console.log(chalk.blue(`${recipients.length} recipient(s):`));
      for (const r of recipients) {
        const keyPreview = r.key.length > 50 ? r.key.slice(0, 50) + '...' : r.key;
        const comment = r.comment ? chalk.gray(` (${r.comment})`) : '';
        console.log(`  ${chalk.gray('-')} ${keyPreview}${comment}`);
      }
    });
}

// ─── CODEOWNERS helpers ──────────────────────────────────────────────────────

function inferGitHubUsername(): string | null {
  try {
    return execSync('gh api user -q .login', {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim() || null;
  } catch {
    return null;
  }
}

function patchCodeowners(cwd: string, username: string): void {
  const githubDir = path.join(cwd, '.github');
  const codeownersPath = path.join(githubDir, 'CODEOWNERS');

  if (!fs.existsSync(githubDir)) {
    fs.mkdirSync(githubDir, { recursive: true });
  }

  const entry = `env/.recipients @${username}`;

  if (fs.existsSync(codeownersPath)) {
    const existing = fs.readFileSync(codeownersPath, 'utf8');
    if (hasMarkerBlock(existing)) {
      fs.writeFileSync(codeownersPath, replaceMarkerBlock(existing, entry));
    } else {
      fs.appendFileSync(codeownersPath, '\n' + wrapWithMarkers(entry));
    }
  } else {
    fs.writeFileSync(codeownersPath, wrapWithMarkers(entry));
  }

  console.log(chalk.green(`Patched .github/CODEOWNERS (owner: @${username})`));
}
