import * as fs from 'fs';
import * as path from 'path';
import { Command } from 'commander';
import chalk from 'chalk';
import { ManagedJsonRegistry, hasMarkerBlock, removeMarkerBlock } from '../../src/index.js';

export function registerUninstallCommand(program: Command): void {
  program
    .command('uninstall')
    .description('Remove all composable.env managed content and generated files')
    .option('--all', 'Also remove the env/ configuration directory')
    .option('--dry-run', 'Show what would be removed without actually removing')
    .action((options: { all?: boolean; dryRun?: boolean }) => {
      const cwd = process.cwd();
      const removed: string[] = [];
      const dryRun = options.dryRun ?? false;

      if (dryRun) {
        console.log(chalk.blue('Dry run — no files will be modified:\n'));
      }

      // 1. Remove marker blocks from .gitignore
      const gitignorePath = path.join(cwd, '.gitignore');
      if (fs.existsSync(gitignorePath)) {
        const content = fs.readFileSync(gitignorePath, 'utf8');
        if (hasMarkerBlock(content)) {
          if (!dryRun) {
            fs.writeFileSync(gitignorePath, removeMarkerBlock(content));
          }
          removed.push('.gitignore (removed ce markers)');
        }
      }

      // 2. Remove marker blocks from .github/CODEOWNERS
      const codeownersPath = path.join(cwd, '.github', 'CODEOWNERS');
      if (fs.existsSync(codeownersPath)) {
        const coContent = fs.readFileSync(codeownersPath, 'utf8');
        if (hasMarkerBlock(coContent)) {
          if (!dryRun) {
            const cleaned = removeMarkerBlock(coContent);
            if (cleaned.trim() === '') {
              fs.unlinkSync(codeownersPath);
              // Remove .github/ if now empty
              const githubDir = path.join(cwd, '.github');
              try {
                if (fs.readdirSync(githubDir).length === 0) {
                  fs.rmdirSync(githubDir);
                }
              } catch { /* ignore */ }
            } else {
              fs.writeFileSync(codeownersPath, cleaned);
            }
          }
          removed.push('.github/CODEOWNERS (removed ce markers)');
        }
      }

      // 3. Remove tracked JSON keys via registry
      const registry = new ManagedJsonRegistry(cwd);
      const entries = registry.load();

      for (const entry of entries) {
        const filePath = path.join(cwd, entry.file);
        if (!fs.existsSync(filePath)) continue;

        const json = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        let changed = false;

        for (const [jsonPath, keys] of Object.entries(entry.keys)) {
          const target = json[jsonPath];
          if (target && typeof target === 'object') {
            for (const key of keys) {
              if (key in target) {
                if (!dryRun) delete target[key];
                changed = true;
              }
            }
          }
        }

        if (changed) {
          if (!dryRun) {
            fs.writeFileSync(filePath, JSON.stringify(json, null, 2) + '\n');
          }
          removed.push(`${entry.file} (removed managed keys)`);
        }
      }

      // 4. Find and delete all generated env files (.ce.*, .cenv.*, and .env.* with generated header)
      const ceFiles = findGeneratedFiles(cwd);
      for (const file of ceFiles) {
        const rel = path.relative(cwd, file);
        if (!dryRun) fs.unlinkSync(file);
        removed.push(rel);
      }

      // 4b. Remove generated ecosystem configs from env/execution/
      const execDir = path.join(cwd, 'env', 'execution');
      if (fs.existsSync(execDir)) {
        for (const file of fs.readdirSync(execDir)) {
          if (file.endsWith('.cjs')) {
            const fullPath = path.join(execDir, file);
            if (!dryRun) fs.unlinkSync(fullPath);
            removed.push(`env/execution/${file}`);
          }
        }
      }

      // 5. Optionally remove env/ directory
      if (options.all) {
        const envDir = path.join(cwd, 'env');
        if (fs.existsSync(envDir)) {
          if (!dryRun) fs.rmSync(envDir, { recursive: true });
          removed.push('env/ (configuration directory)');
        }
      }

      // 6. Remove composable.env from package.json dependencies
      const pkgPath = path.join(cwd, 'package.json');
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        let pkgChanged = false;

        if (pkg.devDependencies?.['composable.env']) {
          if (!dryRun) delete pkg.devDependencies['composable.env'];
          pkgChanged = true;
        }
        if (pkg.dependencies?.['composable.env']) {
          if (!dryRun) delete pkg.dependencies['composable.env'];
          pkgChanged = true;
        }

        if (pkgChanged) {
          if (!dryRun) {
            fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
          }
          removed.push('package.json (removed composable.env dependency)');
        }
      }

      // 7. Remove ce.json / cenv.json (scripts config)
      for (const configName of ['ce.json', 'cenv.json']) {
        const configPath = path.join(cwd, configName);
        if (fs.existsSync(configPath)) {
          if (!dryRun) fs.unlinkSync(configPath);
          removed.push(configName);
        }
      }

      // 8. Remove .ce-managed.json / .cenv-managed.json
      for (const managedName of ['.ce-managed.json', '.cenv-managed.json']) {
        const managedPath = path.join(cwd, managedName);
        if (fs.existsSync(managedPath)) {
          if (!dryRun) fs.unlinkSync(managedPath);
          removed.push(managedName);
        }
      }

      // Summary
      if (removed.length === 0) {
        console.log(chalk.yellow('Nothing to remove — no composable.env artifacts found.'));
      } else {
        const verb = dryRun ? 'Would remove' : 'Removed';
        console.log(chalk.green(`${verb} ${removed.length} item(s):`));
        for (const item of removed) {
          console.log(`  ${chalk.gray('-')} ${item}`);
        }
      }
    });
}

const GENERATED_HEADER = '# Generated by composable.env';

function findGeneratedFiles(dir: string): string[] {
  const results: string[] = [];

  function walk(current: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;

      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.name.startsWith('.ce.') || entry.name.startsWith('.cenv.')) {
        // Legacy generated files — always remove
        results.push(fullPath);
      } else if (entry.name.startsWith('.env.') && !entry.name.includes('secrets') && !entry.name.endsWith('.local') && !entry.name.endsWith('.shared')) {
        // New .env.{profile} files — only remove if they have the generated header
        try {
          const firstLine = fs.readFileSync(fullPath, 'utf8').split('\n')[0];
          if (firstLine.startsWith(GENERATED_HEADER)) {
            results.push(fullPath);
          }
        } catch { /* skip unreadable files */ }
      }
    }
  }

  walk(dir);
  return results;
}
