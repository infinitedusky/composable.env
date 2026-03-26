import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  createTempEnvDir,
  writeComponent,
  writeProfile,
  writeContract,
  writeCeConfig,
  writeSecrets,
  readEnvFile,
  cleanupTempDir,
} from '../fixtures/helpers.js';
import { EnvironmentBuilder } from '../../src/builder.js';

describe('build profile (integration)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTempEnvDir();
    fs.mkdirSync(path.join(tmpDir, 'apps', 'api'), { recursive: true });
  });

  afterEach(() => {
    cleanupTempDir(tmpDir);
  });

  async function buildProfile(profileName: string): Promise<any> {
    const builder = new EnvironmentBuilder(tmpDir, path.join(tmpDir, 'apps/api/.env.' + profileName), profileName);
    await builder.initialize();
    return builder.buildFromProfile(profileName);
  }

  it('builds .env.local with resolved component values', async () => {
    writeComponent(tmpDir, 'database', {
      default: { HOST: 'localhost', PORT: '5432' },
    });

    writeProfile(tmpDir, 'local', { name: 'local', description: 'Local dev' });

    writeContract(tmpDir, 'api', {
      name: 'api',
      location: path.join(tmpDir, 'apps/api'),
      vars: {
        DB_HOST: '${database.HOST}',
        DB_PORT: '${database.PORT}',
      },
    });

    const result = await buildProfile('local');
    if (!result.success) console.error('BUILD ERRORS:', result.errors);
    expect(result.success).toBe(true);

    const envVars = readEnvFile(path.join(tmpDir, 'apps/api/.env.local'));
    expect(envVars['DB_HOST']).toBe('localhost');
    expect(envVars['DB_PORT']).toBe('5432');
  });

  it('profile sections override default values', async () => {
    writeComponent(tmpDir, 'database', {
      default: { HOST: 'localhost', PORT: '5432' },
      production: { HOST: 'db.prod.internal' },
    });

    writeProfile(tmpDir, 'production', { name: 'production', description: 'Prod' });

    writeContract(tmpDir, 'api', {
      name: 'api',
      location: path.join(tmpDir, 'apps/api'),
      vars: {
        DB_HOST: '${database.HOST}',
        DB_PORT: '${database.PORT}',
      },
    });

    const builder = new EnvironmentBuilder(tmpDir, path.join(tmpDir, 'apps/api/.env.production'), 'production');
    await builder.initialize();
    const result = await builder.buildFromProfile('production');
    expect(result.success).toBe(true);

    const envVars = readEnvFile(path.join(tmpDir, 'apps/api/.env.production'));
    expect(envVars['DB_HOST']).toBe('db.prod.internal');
    expect(envVars['DB_PORT']).toBe('5432');
  });

  it('fails on unknown profile with no sections', async () => {
    writeComponent(tmpDir, 'database', {
      default: { HOST: 'localhost' },
    });

    writeContract(tmpDir, 'api', {
      name: 'api',
      location: path.join(tmpDir, 'apps/api'),
      vars: { DB_HOST: '${database.HOST}' },
    });

    const builder = new EnvironmentBuilder(tmpDir, path.join(tmpDir, 'apps/api/.env.typo'), 'typo');
    await builder.initialize();
    const result = await builder.buildFromProfile('typo');
    expect(result.success).toBe(false);
    expect(result.errors![0]).toContain("Profile 'typo' not found");
  });

  it('resolves cross-component references', async () => {
    writeComponent(tmpDir, 'database', {
      default: { HOST: 'localhost', PORT: '5432', USER: 'postgres' },
    });
    writeComponent(tmpDir, 'app', {
      default: { URL: 'postgresql://${database.USER}@${database.HOST}:${database.PORT}/mydb' },
    });

    writeProfile(tmpDir, 'local', { name: 'local' });

    writeContract(tmpDir, 'api', {
      name: 'api',
      location: path.join(tmpDir, 'apps/api'),
      vars: { DATABASE_URL: '${app.URL}' },
    });

    const result = await buildProfile('local');
    expect(result.success).toBe(true);

    const envVars = readEnvFile(path.join(tmpDir, 'apps/api/.env.local'));
    expect(envVars['DATABASE_URL']).toBe('postgresql://postgres@localhost:5432/mydb');
  });

  it('resolves secrets in components', async () => {
    writeSecrets(tmpDir, {}, { DB_PASS: 'secret123' });

    writeComponent(tmpDir, 'database', {
      default: { PASSWORD: '${secrets.DB_PASS}', HOST: 'localhost' },
    });

    writeProfile(tmpDir, 'local', { name: 'local' });

    writeContract(tmpDir, 'api', {
      name: 'api',
      location: path.join(tmpDir, 'apps/api'),
      vars: {
        DB_PASS: '${database.PASSWORD}',
        DB_HOST: '${database.HOST}',
      },
    });

    const result = await buildProfile('local');
    expect(result.success).toBe(true);

    const envVars = readEnvFile(path.join(tmpDir, 'apps/api/.env.local'));
    expect(envVars['DB_PASS']).toBe('secret123');
    expect(envVars['DB_HOST']).toBe('localhost');
  });

  it('applies defaults for missing vars', async () => {
    writeComponent(tmpDir, 'app', {
      default: { PORT: '3000' },
    });

    writeProfile(tmpDir, 'local', { name: 'local' });

    writeContract(tmpDir, 'api', {
      name: 'api',
      location: path.join(tmpDir, 'apps/api'),
      vars: { PORT: '${app.PORT}' },
      defaults: { LOG_LEVEL: 'info' },
    });

    const result = await buildProfile('local');
    expect(result.success).toBe(true);

    const envVars = readEnvFile(path.join(tmpDir, 'apps/api/.env.local'));
    expect(envVars['PORT']).toBe('3000');
    expect(envVars['LOG_LEVEL']).toBe('info');
  });

  it('onlyProfiles filters contracts', async () => {
    writeComponent(tmpDir, 'app', {
      default: { PORT: '3000' },
    });

    writeProfile(tmpDir, 'local', { name: 'local' });

    writeContract(tmpDir, 'api', {
      name: 'api',
      location: path.join(tmpDir, 'apps/api'),
      onlyProfiles: ['production'],
      vars: { PORT: '${app.PORT}' },
    });

    const result = await buildProfile('local');
    expect(result.success).toBe(true);

    // File should not be written since contract is skipped for local
    expect(fs.existsSync(path.join(tmpDir, 'apps/api/.env.local'))).toBe(false);
  });
});
