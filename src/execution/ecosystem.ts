import * as path from 'path';
import type { ServiceContract } from '../contracts.js';

export interface AppConfig {
  name: string;
  command: string;
  cwd: string;
  envFile: string;
  label: string;
}

/**
 * Extract PM2 app configs from contracts that explicitly opt in via:
 *   - target.type: "pm2" (preferred), or
 *   - top-level `dev` field (legacy, still supported)
 *
 * Contracts with only `location` (env file output) are NOT auto-added.
 * Pure env contracts (datadog, observability extensions, etc.) shouldn't
 * spawn a process just because they declare an env file destination.
 */
export function extractApps(
  contracts: Map<string, ServiceContract>,
  projectRoot: string,
  profile: string
): AppConfig[] {
  const apps: AppConfig[] = [];

  for (const [, contract] of contracts) {
    // Resolve the runtime spec from either target.type:"pm2" or legacy `dev` field.
    let command: string | undefined;
    let cwd: string | undefined;
    let label: string | undefined;

    if (contract.target?.type === 'pm2') {
      command = contract.target.command;
      cwd = contract.target.cwd;
      label = contract.target.label;
    } else if (contract.dev) {
      command = contract.dev.command;
      cwd = contract.dev.cwd;
      label = contract.dev.label;
    }

    // No explicit runtime declaration → not a PM2-managed contract.
    // (Env-only contracts like datadog land here and are correctly skipped.)
    if (!command) continue;

    // Need a location for both env file path and default cwd.
    if (!contract.location) continue;

    const resolvedCwd = cwd || contract.location;
    const resolvedLabel = label || contract.name;
    const absoluteCwd = resolvedCwd.startsWith('/') ? resolvedCwd : path.join(projectRoot, resolvedCwd);

    const envFile = path.join(projectRoot, contract.location, `.env.${profile}`);

    apps.push({
      name: contract.name,
      command,
      cwd: absoluteCwd,
      envFile,
      label: resolvedLabel,
    });
  }

  return apps;
}

/**
 * Generate a PM2 ecosystem config object from app configs.
 *
 * Uses `script: 'bash'` with `args: '-c "command"'` so arbitrary
 * shell commands like "pnpm dev" work without needing a wrapper script.
 *
 * The generated ecosystem.config.cjs reads each app's .env file
 * at startup and injects vars via PM2's `env` field, avoiding
 * any dependency on PM2 Plus for env_file support.
 */
export function generateEcosystem(apps: AppConfig[]): object {
  return {
    apps: apps.map(app => ({
      name: app.name,
      script: 'bash',
      args: `-c "${app.command.replace(/"/g, '\\"')}"`,
      cwd: app.cwd,
      env_file: app.envFile,
      watch: false,
      autorestart: true,
      max_restarts: 3,
    })),
  };
}

/**
 * Serialize ecosystem config to a self-contained CommonJS module.
 *
 * The generated file reads .env files at load time and injects
 * parsed vars into each app's `env` field, so PM2 free edition
 * gets full env support without PM2 Plus.
 */
export function serializeEcosystem(config: { apps: Array<Record<string, unknown>> }): string {
  const lines = [
    `const fs = require('fs');`,
    `const path = require('path');`,
    ``,
    `function loadEnvFile(filePath) {`,
    `  const env = {};`,
    `  if (!fs.existsSync(filePath)) return env;`,
    `  for (const line of fs.readFileSync(filePath, 'utf8').split('\\n')) {`,
    `    const trimmed = line.trim();`,
    `    if (!trimmed || trimmed.startsWith('#')) continue;`,
    `    const eqIdx = trimmed.indexOf('=');`,
    `    if (eqIdx > 0) env[trimmed.slice(0, eqIdx)] = trimmed.slice(eqIdx + 1);`,
    `  }`,
    `  return env;`,
    `}`,
    ``,
    `module.exports = ${JSON.stringify(config, null, 2).replace(
      /"env_file": "([^"]+)"/g,
      `"env": loadEnvFile("$1")`
    )};`,
    ``,
  ];
  return lines.join('\n');
}
