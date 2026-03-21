#!/usr/bin/env node

import { createRequire } from 'module';
import { Command } from 'commander';
import { registerBuildCommand } from './commands/build.js';
import { registerListCommand } from './commands/list.js';
import { registerInitCommand } from './commands/init.js';
import { registerRunCommand } from './commands/run.js';
import { registerScriptCommand } from './commands/script.js';
import { registerUninstallCommand } from './commands/uninstall.js';
import { registerVaultCommand } from './commands/vault.js';
import { registerStartCommand } from './commands/start.js';
import { registerMigrateCommand } from './commands/migrate.js';
import { registerAddSkillCommand } from './commands/add-skill.js';
import { registerPersistentCommand } from './commands/persistent.js';
import { registerUpCommand } from './commands/up.js';

const require = createRequire(import.meta.url);
const { version } = require('../../package.json') as { version: string };

const program = new Command();

program
  .name('ce')
  .description('composable.env — build .env files from components, profiles, and contracts')
  .version(version)
  .enablePositionalOptions();

registerBuildCommand(program);
registerListCommand(program);
registerInitCommand(program);
registerRunCommand(program);
registerScriptCommand(program);
registerUninstallCommand(program);
registerVaultCommand(program);
registerStartCommand(program);
registerMigrateCommand(program);
registerAddSkillCommand(program);
registerPersistentCommand(program);
registerUpCommand(program);

program.parse();
