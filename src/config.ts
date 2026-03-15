import * as fs from 'fs';
import * as path from 'path';
import { CeConfigSchema, type CeConfig } from './types.js';

const CE_CONFIG_FILENAME = 'ce.json';

const DEFAULT_CONFIG: CeConfig = {
  envDir: 'env',
  defaultProfile: 'default',
};

/**
 * Load ce.json from the project root.
 *
 * - If ce.json doesn't exist, returns defaults (fully backwards compatible).
 * - If ce.json exists but is invalid, throws with a clear error.
 * - Rejects absolute paths for envDir.
 */
export function loadConfig(projectRoot: string): CeConfig {
  const configPath = path.join(projectRoot, CE_CONFIG_FILENAME);

  if (!fs.existsSync(configPath)) {
    return { ...DEFAULT_CONFIG };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (err) {
    throw new Error(
      `Invalid ce.json: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  const result = CeConfigSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map(i => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid ce.json:\n${issues}`);
  }

  const config = result.data;

  if (path.isAbsolute(config.envDir)) {
    throw new Error('ce.json: envDir must be a relative path');
  }

  return config;
}

/**
 * Save (merge) fields into ce.json at the project root.
 * Creates the file if it doesn't exist. Preserves existing fields.
 */
export function saveConfig(projectRoot: string, updates: Partial<CeConfig>): void {
  const configPath = path.join(projectRoot, CE_CONFIG_FILENAME);

  let existing: Record<string, unknown> = {};
  if (fs.existsSync(configPath)) {
    try {
      existing = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch {
      // Overwrite invalid file
    }
  }

  const merged = { ...existing, ...updates };
  fs.writeFileSync(configPath, JSON.stringify(merged, null, 2) + '\n');
}
