import * as fs from 'fs';
import * as path from 'path';
import { createRequire } from 'module';
import { Command } from 'commander';
import chalk from 'chalk';

/**
 * Find the package root by walking up from this file to find package.json.
 */
function findPackageRoot(): string {
  let dir = path.dirname(new URL(import.meta.url).pathname);
  while (dir !== '/') {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error('Could not find composable.env package root');
}

export function registerAddSkillCommand(program: Command): void {
  program
    .command('add-skill')
    .description('Install the composable.env Claude Code skill into your project')
    .option('--dry-run', 'Show what would be installed without writing files')
    .action(async (options: { dryRun?: boolean }) => {
      const cwd = process.cwd();
      const targetDir = path.join(cwd, '.claude', 'skills', 'composable-env');
      const targetPath = path.join(targetDir, 'SKILL.md');

      // Find the bundled skill file
      const pkgRoot = findPackageRoot();
      const skillSource = path.join(pkgRoot, 'skills', 'SKILL.md');

      if (!fs.existsSync(skillSource)) {
        console.error(chalk.red('\u274c Skill file not found in composable.env package'));
        process.exit(1);
      }

      if (options.dryRun) {
        console.log(chalk.blue('Would install:'));
        console.log(chalk.gray(`   ${path.relative(cwd, targetPath)}`));
        return;
      }

      // Create .claude/skills/composable-env/ if it doesn't exist
      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
      }

      // Copy skill file
      fs.copyFileSync(skillSource, targetPath);
      console.log(chalk.green(`\u2705 Installed skill: ${path.relative(cwd, targetPath)}`));
      console.log(chalk.gray('   Use /ce in Claude Code to get composable.env assistance'));
    });
}
