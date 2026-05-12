import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  createTempEnvDir,
  writeComponent,
  writeProfile,
  writeContract,
  writeCeConfig,
  cleanupTempDir,
} from '../fixtures/helpers.js';
import { EnvironmentBuilder } from '../../src/builder.js';

describe('build.args.APP_NAME auto-injection (integration)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTempEnvDir();
  });

  afterEach(() => {
    cleanupTempDir(tmpDir);
  });

  async function buildAll(profileSuffixes?: Record<string, string>) {
    const config = JSON.parse(fs.readFileSync(path.join(tmpDir, 'ce.json'), 'utf8'));
    const builder = new EnvironmentBuilder(tmpDir, '', undefined);
    await builder.initialize();
    return builder.buildAllProfiles(undefined, profileSuffixes, config.profiles);
  }

  it('lifts target.config.command into build.args.APP_NAME', async () => {
    const composeFile = path.join(tmpDir, 'docker-compose.yml');
    writeCeConfig(tmpDir, {
      envDir: 'env',
      defaultProfile: 'local',
      profiles: { local: { suffix: '-local' } },
    });
    writeProfile(tmpDir, 'local', { name: 'local', description: 'Local' });
    writeComponent(tmpDir, 'poker', { default: {} });
    writeContract(tmpDir, 'poker', {
      name: 'poker',
      target: {
        type: 'docker-compose',
        file: composeFile,
        service: 'poker',
        config: {
          build: { context: '.', dockerfile: 'docker/Dockerfile.nextdev' },
          command: '@numero/poker',
        },
      },
      vars: {},
    });

    const result = await buildAll({ local: '-local' });
    expect(result.success).toBe(true);

    const compose = fs.readFileSync(composeFile, 'utf8');
    // YAML emits the @-prefixed string in double quotes; assert on substring
    expect(compose).toMatch(/APP_NAME:\s+["']@numero\/poker["']/);
  });

  it('does NOT override an explicit APP_NAME build arg', async () => {
    const composeFile = path.join(tmpDir, 'docker-compose.yml');
    writeCeConfig(tmpDir, {
      envDir: 'env',
      defaultProfile: 'local',
      profiles: { local: { suffix: '-local' } },
    });
    writeProfile(tmpDir, 'local', { name: 'local', description: 'Local' });
    writeComponent(tmpDir, 'poker', { default: {} });
    writeContract(tmpDir, 'poker', {
      name: 'poker',
      target: {
        type: 'docker-compose',
        file: composeFile,
        service: 'poker',
        config: {
          build: {
            context: '.',
            dockerfile: 'docker/Dockerfile.nextdev',
            args: { APP_NAME: '@custom/override' },
          },
          command: '@numero/poker',
        },
      },
      vars: {},
    });

    const result = await buildAll({ local: '-local' });
    expect(result.success).toBe(true);

    const compose = fs.readFileSync(composeFile, 'utf8');
    expect(compose).toContain('@custom/override');
    expect(compose).not.toContain('@numero/poker\n');
  });

  it('skips injection when contract has no command', async () => {
    const composeFile = path.join(tmpDir, 'docker-compose.yml');
    writeCeConfig(tmpDir, {
      envDir: 'env',
      defaultProfile: 'local',
      profiles: { local: { suffix: '-local' } },
    });
    writeProfile(tmpDir, 'local', { name: 'local', description: 'Local' });
    writeComponent(tmpDir, 'poker', { default: {} });
    writeContract(tmpDir, 'poker', {
      name: 'poker',
      target: {
        type: 'docker-compose',
        file: composeFile,
        service: 'poker',
        config: {
          build: { context: '.', dockerfile: 'docker/Dockerfile.nextdev' },
          // No command field
        },
      },
      vars: {},
    });

    const result = await buildAll({ local: '-local' });
    expect(result.success).toBe(true);

    const compose = fs.readFileSync(composeFile, 'utf8');
    expect(compose).not.toContain('APP_NAME');
  });

  it('skips injection when contract uses image (not build)', async () => {
    const composeFile = path.join(tmpDir, 'docker-compose.yml');
    writeCeConfig(tmpDir, {
      envDir: 'env',
      defaultProfile: 'local',
      profiles: { local: { suffix: '-local' } },
    });
    writeProfile(tmpDir, 'local', { name: 'local', description: 'Local' });
    writeComponent(tmpDir, 'redis', { default: {} });
    writeContract(tmpDir, 'redis', {
      name: 'redis',
      target: {
        type: 'docker-compose',
        file: composeFile,
        service: 'redis',
        config: {
          image: 'redis:7-alpine',
          command: 'redis-server',
        },
      },
      vars: {},
    });

    const result = await buildAll({ local: '-local' });
    expect(result.success).toBe(true);

    const compose = fs.readFileSync(composeFile, 'utf8');
    expect(compose).not.toContain('APP_NAME');
  });
});
