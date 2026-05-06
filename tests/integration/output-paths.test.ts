import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  createTempEnvDir,
  writeComponent,
  writeProfile,
  writeContract,
  readEnvFile,
  cleanupTempDir,
} from '../fixtures/helpers.js';
import { EnvironmentBuilder } from '../../src/builder.js';

describe('contract output paths (integration)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTempEnvDir();
  });

  afterEach(() => {
    cleanupTempDir(tmpDir);
  });

  async function buildProfile(profileName: string) {
    const builder = new EnvironmentBuilder(tmpDir, '', profileName);
    await builder.initialize();
    return builder.buildFromProfile(profileName);
  }

  it('falls back to .env.{profile} when no outputs override is set', async () => {
    fs.mkdirSync(path.join(tmpDir, 'apps/api'), { recursive: true });
    writeComponent(tmpDir, 'database', { default: { HOST: 'localhost' } });
    writeProfile(tmpDir, 'local', { name: 'local', description: 'Local' });
    writeContract(tmpDir, 'api', {
      name: 'api',
      location: 'apps/api',
      vars: { DB_HOST: '${database.HOST}' },
    });

    const result = await buildProfile('local');
    expect(result.success).toBe(true);

    const envPath = path.join(tmpDir, 'apps/api/.env.local');
    expect(fs.existsSync(envPath)).toBe(true);
    expect(readEnvFile(envPath)['DB_HOST']).toBe('localhost');
  });

  it('uses outputs[profile] override for filename', async () => {
    fs.mkdirSync(path.join(tmpDir, 'apps/api'), { recursive: true });
    writeComponent(tmpDir, 'database', { default: { HOST: 'localhost' } });
    writeProfile(tmpDir, 'local', { name: 'local', description: 'Local' });
    writeContract(tmpDir, 'api', {
      name: 'api',
      location: 'apps/api',
      outputs: { local: 't.cyux.xy.env' },
      vars: { DB_HOST: '${database.HOST}' },
    });

    const result = await buildProfile('local');
    expect(result.success).toBe(true);

    // Custom filename used, not .env.local
    expect(fs.existsSync(path.join(tmpDir, 'apps/api/t.cyux.xy.env'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'apps/api/.env.local'))).toBe(false);
  });

  it('outputs only applies to matching profile, falls back otherwise', async () => {
    fs.mkdirSync(path.join(tmpDir, 'apps/api'), { recursive: true });
    writeComponent(tmpDir, 'database', { default: { HOST: 'a' }, production: { HOST: 'b' } });
    writeProfile(tmpDir, 'local', { name: 'local', description: 'Local' });
    writeProfile(tmpDir, 'production', { name: 'production', description: 'Prod' });
    writeContract(tmpDir, 'api', {
      name: 'api',
      location: 'apps/api',
      outputs: { local: 'custom.env' }, // only local overrides
      vars: { DB_HOST: '${database.HOST}' },
    });

    const localResult = await buildProfile('local');
    expect(localResult.success).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'apps/api/custom.env'))).toBe(true);

    const prodResult = await buildProfile('production');
    expect(prodResult.success).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'apps/api/.env.production'))).toBe(true);
  });

  it('absolute location path writes outside the project tree', async () => {
    const externalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-external-'));
    try {
      writeComponent(tmpDir, 'database', { default: { HOST: 'localhost' } });
      writeProfile(tmpDir, 'local', { name: 'local', description: 'Local' });
      writeContract(tmpDir, 'api', {
        name: 'api',
        location: externalDir,
        vars: { DB_HOST: '${database.HOST}' },
      });

      const result = await buildProfile('local');
      expect(result.success).toBe(true);

      const envPath = path.join(externalDir, '.env.local');
      expect(fs.existsSync(envPath)).toBe(true);
      expect(readEnvFile(envPath)['DB_HOST']).toBe('localhost');
    } finally {
      fs.rmSync(externalDir, { recursive: true, force: true });
    }
  });

  it('outputs path can be absolute and overrides location entirely', async () => {
    fs.mkdirSync(path.join(tmpDir, 'apps/api'), { recursive: true });
    const externalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-external-'));
    try {
      writeComponent(tmpDir, 'database', { default: { HOST: 'localhost' } });
      writeProfile(tmpDir, 'local', { name: 'local', description: 'Local' });
      writeContract(tmpDir, 'api', {
        name: 'api',
        location: 'apps/api',
        outputs: { local: path.join(externalDir, 'special.env') },
        vars: { DB_HOST: '${database.HOST}' },
      });

      const result = await buildProfile('local');
      expect(result.success).toBe(true);

      // Output landed at the absolute outputs path, not under location
      expect(fs.existsSync(path.join(externalDir, 'special.env'))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, 'apps/api/.env.local'))).toBe(false);
    } finally {
      fs.rmSync(externalDir, { recursive: true, force: true });
    }
  });

  it('expands ~ in location to the user home directory', async () => {
    // We can't write to the real home dir in tests, but we can verify the
    // resolved path starts with $HOME.
    writeComponent(tmpDir, 'database', { default: { HOST: 'localhost' } });
    writeProfile(tmpDir, 'local', { name: 'local', description: 'Local' });
    // Use a unique directory under home that we can clean up
    const homeSubdir = `.ce-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    writeContract(tmpDir, 'api', {
      name: 'api',
      location: `~/${homeSubdir}`,
      vars: { DB_HOST: '${database.HOST}' },
    });

    const result = await buildProfile('local');
    try {
      expect(result.success).toBe(true);
      const expectedPath = path.join(os.homedir(), homeSubdir, '.env.local');
      expect(fs.existsSync(expectedPath)).toBe(true);
      expect(readEnvFile(expectedPath)['DB_HOST']).toBe('localhost');
    } finally {
      fs.rmSync(path.join(os.homedir(), homeSubdir), { recursive: true, force: true });
    }
  });
});
