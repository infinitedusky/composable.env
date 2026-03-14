import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { Command } from 'commander';
import chalk from 'chalk';
import dotenv from 'dotenv';
import { EnvironmentBuilder } from '../../src/index.js';

/**
 * Resolve the profile name from multiple sources.
 *
 * Priority:
 *  1. Explicit --profile <name> (before --)
 *  2. Trailing positional arg matching a known profile (after --, stripped)
 *  3. CE_PROFILE env var
 *  4. "default"
 */
function resolveProfile(
  explicit: string | true | undefined,
  commandArgs: string[],
  cwd: string,
): { profile: string; forwardArgs: string[] } {
  // 1. Explicit --profile <name>
  if (typeof explicit === 'string') {
    return { profile: explicit, forwardArgs: commandArgs };
  }

  // 2. Scan trailing args for a known profile name (last match wins)
  if (commandArgs.length > 0) {
    const builder = new EnvironmentBuilder(cwd, '');
    const knownProfiles = new Set(builder.listProfiles().map(p => p.name));

    const lastArg = commandArgs[commandArgs.length - 1];
    if (knownProfiles.has(lastArg)) {
      return {
        profile: lastArg,
        forwardArgs: commandArgs.slice(0, -1),
      };
    }
  }

  // 3. CE_PROFILE env var (with CENV_PROFILE fallback)
  const envProfile = process.env.CE_PROFILE || process.env.CENV_PROFILE;
  if (envProfile) {
    return { profile: envProfile, forwardArgs: commandArgs };
  }

  // 4. Fall back to "default"
  return { profile: 'default', forwardArgs: commandArgs };
}

/**
 * Find the env file for a profile. Checks .env.{profile} first, falls back to .ce.{profile}.
 */
function findEnvFile(cwd: string, profile: string): string | null {
  const newPath = path.join(cwd, `.env.${profile}`);
  if (fs.existsSync(newPath)) return newPath;

  const legacyPath = path.join(cwd, `.ce.${profile}`);
  if (fs.existsSync(legacyPath)) return legacyPath;

  return null;
}

export function registerRunCommand(program: Command): void {
  program
    .command('run')
    .description('Load a .env profile and run a command (auto-builds if missing)')
    .option('-p, --profile [name]', 'Profile name (or pass as trailing arg / CE_PROFILE)')
    .option('--no-build', 'Fail instead of auto-building when .env file is missing')
    .argument('<command...>', 'Command to execute (use -- before the command)')
    .passThroughOptions()
    .action(async (commandArgs: string[], options: { profile: string | true | undefined; build: boolean }) => {
      const cwd = process.cwd();
      const { profile, forwardArgs } = resolveProfile(options.profile, commandArgs, cwd);

      if (forwardArgs.length === 0) {
        console.error(chalk.red('\u274c No command specified after --'));
        process.exit(1);
      }

      let envFile = findEnvFile(cwd, profile);

      if (!envFile) {
        if (!options.build) {
          console.error(chalk.red(
            `\u274c .env.${profile} not found in ${cwd}\n` +
            `   Run "ce build --profile ${profile}" first.`
          ));
          process.exit(1);
        }

        console.log(chalk.blue(`Building .env.${profile}...`));
        const builder = new EnvironmentBuilder(cwd, '', profile);
        const result = await builder.buildFromProfile(profile);

        if (!result.success) {
          console.error(chalk.red('\u274c Auto-build failed:'));
          result.errors?.forEach(e => console.error(chalk.red(`   ${e}`)));
          process.exit(1);
        }
        console.log(chalk.green('\u2705 Built successfully'));

        // Find the generated file
        envFile = findEnvFile(cwd, profile);
        if (!envFile) {
          // Build generates per-contract files, not a root file — that's expected
          // For ce run, we need all generated files loaded
          envFile = null;
        }
      }

      if (envFile) {
        dotenv.config({ path: envFile, override: true });
      }

      const [cmd, ...args] = forwardArgs;
      const child = spawn(cmd, args, {
        stdio: 'inherit',
        env: process.env,
        shell: true,
      });

      child.on('close', (code) => process.exit(code ?? 1));
      child.on('error', (err) => {
        console.error(chalk.red(`\u274c Failed to start command: ${err.message}`));
        process.exit(1);
      });
    });
}
