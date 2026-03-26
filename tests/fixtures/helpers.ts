import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as ini from 'ini';
import { EnvironmentBuilder } from '../../src/builder.js';

/**
 * Create a temp directory with the standard env/ subdirectories.
 */
export function createTempEnvDir(envDir = 'env'): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-test-'));
  const dirs = ['components', 'profiles', 'contracts', 'execution'];
  for (const dir of dirs) {
    fs.mkdirSync(path.join(tmpDir, envDir, dir), { recursive: true });
  }
  return tmpDir;
}

/**
 * Write a component .env file with INI sections.
 */
export function writeComponent(
  dir: string,
  name: string,
  sections: Record<string, Record<string, string>>,
  envDir = 'env'
): void {
  const lines: string[] = [];
  for (const [section, vars] of Object.entries(sections)) {
    lines.push(`[${section}]`);
    for (const [key, value] of Object.entries(vars)) {
      lines.push(`${key}=${value}`);
    }
    lines.push('');
  }
  fs.writeFileSync(
    path.join(dir, envDir, 'components', `${name}.env`),
    lines.join('\n')
  );
}

/**
 * Write a profile JSON file.
 */
export function writeProfile(
  dir: string,
  name: string,
  data: Record<string, unknown>,
  envDir = 'env'
): void {
  fs.writeFileSync(
    path.join(dir, envDir, 'profiles', `${name}.json`),
    JSON.stringify(data, null, 2) + '\n'
  );
}

/**
 * Write a contract JSON file.
 */
export function writeContract(
  dir: string,
  name: string,
  contract: Record<string, unknown>,
  envDir = 'env'
): void {
  fs.writeFileSync(
    path.join(dir, envDir, 'contracts', `${name}.contract.json`),
    JSON.stringify(contract, null, 2) + '\n'
  );
}

/**
 * Write a var set JSON file.
 */
export function writeVarSet(
  dir: string,
  name: string,
  data: Record<string, unknown>,
  envDir = 'env'
): void {
  fs.writeFileSync(
    path.join(dir, envDir, 'contracts', `${name}.vars.json`),
    JSON.stringify(data, null, 2) + '\n'
  );
}

/**
 * Write a ce.json config file.
 */
export function writeCeConfig(
  dir: string,
  config: Record<string, unknown>
): void {
  fs.writeFileSync(
    path.join(dir, 'ce.json'),
    JSON.stringify(config, null, 2) + '\n'
  );
}

/**
 * Write secrets files.
 */
export function writeSecrets(
  dir: string,
  shared: Record<string, string> = {},
  local: Record<string, string> = {},
  envDir = 'env'
): void {
  const sharedLines = Object.entries(shared).map(([k, v]) => `${k}=${v}`).join('\n');
  const localLines = Object.entries(local).map(([k, v]) => `${k}=${v}`).join('\n');
  fs.writeFileSync(path.join(dir, envDir, '.env.secrets.shared'), sharedLines + '\n');
  fs.writeFileSync(path.join(dir, envDir, '.env.secrets.local'), localLines + '\n');
}

/**
 * Clean up a temp directory.
 */
export function cleanupTempDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Read a generated .env file and parse it into key-value pairs.
 */
export function readEnvFile(filePath: string): Record<string, string> {
  const content = fs.readFileSync(filePath, 'utf8');
  const vars: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    vars[trimmed.slice(0, eqIdx)] = trimmed.slice(eqIdx + 1);
  }
  return vars;
}

/**
 * Testable subclass of EnvironmentBuilder that exposes private methods.
 */
export class TestableBuilder extends EnvironmentBuilder {
  public exposedResolveCrossComponentRefs(pool: Map<string, Record<string, string>>): void {
    return (this as any).resolveCrossComponentRefs(pool);
  }

  public exposedResolveVariables(vars: Record<string, string>): Record<string, string> {
    return (this as any).resolveVariables(vars);
  }

  public exposedGenerateServiceVars(
    contracts: Map<string, any>,
    profileName: string,
    profileConfig: any
  ): Record<string, string> {
    return (this as any).generateServiceVars(contracts, profileName, profileConfig);
  }

  public exposedFlattenComponentPool(pool: Map<string, Record<string, string>>): Record<string, string> {
    return (this as any).flattenComponentPool(pool);
  }

  public exposedRebuildComponentPool(
    original: Map<string, Record<string, string>>,
    resolvedFlat: Record<string, string>
  ): Map<string, Record<string, string>> {
    return (this as any).rebuildComponentPool(original, resolvedFlat);
  }
}
