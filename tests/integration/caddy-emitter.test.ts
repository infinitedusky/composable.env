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

describe('Caddy emitter (integration)', () => {
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

  it('emits Caddyfile when profile.proxy = "caddy"', async () => {
    writeCeConfig(tmpDir, {
      envDir: 'env',
      defaultProfile: 'local',
      profiles: {
        local: { suffix: '-local', domain: 'numero.local', proxy: 'caddy' },
      },
    });
    writeProfile(tmpDir, 'local', { name: 'local', description: 'Local' });
    writeComponent(tmpDir, 'admin', { default: {} });
    writeContract(tmpDir, 'admin', {
      name: 'admin',
      target: {
        type: 'docker-compose',
        file: 'docker-compose.yml',
        service: 'admin',
        subdomain: 'admin',
        config: { ports: ['3664:3664'] },
      },
      vars: {},
    });

    const result = await buildAll({ local: '-local' });
    expect(result.success).toBe(true);

    const caddyPath = path.join(tmpDir, 'Caddyfile');
    expect(fs.existsSync(caddyPath)).toBe(true);

    const content = fs.readFileSync(caddyPath, 'utf8');
    expect(content).toContain('admin.numero.local {');
    expect(content).toContain('reverse_proxy admin-local:3664');
    expect(content).toContain('# Profile: local');

    // No nginx.conf should exist when proxy is caddy only
    expect(fs.existsSync(path.join(tmpDir, 'nginx.conf'))).toBe(false);
  });

  it('emits nginx by default (proxy field omitted)', async () => {
    writeCeConfig(tmpDir, {
      envDir: 'env',
      defaultProfile: 'local',
      profiles: {
        local: { suffix: '-local', domain: 'numero.local' },
      },
    });
    writeProfile(tmpDir, 'local', { name: 'local', description: 'Local' });
    writeComponent(tmpDir, 'admin', { default: {} });
    writeContract(tmpDir, 'admin', {
      name: 'admin',
      target: {
        type: 'docker-compose',
        file: 'docker-compose.yml',
        service: 'admin',
        subdomain: 'admin',
        config: { ports: ['3664:3664'] },
      },
      vars: {},
    });

    const result = await buildAll({ local: '-local' });
    expect(result.success).toBe(true);

    expect(fs.existsSync(path.join(tmpDir, 'nginx.conf'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'Caddyfile'))).toBe(false);
  });

  it('emits both when proxy = "both"', async () => {
    writeCeConfig(tmpDir, {
      envDir: 'env',
      defaultProfile: 'local',
      profiles: {
        local: { suffix: '-local', domain: 'numero.local', proxy: 'both' },
      },
    });
    writeProfile(tmpDir, 'local', { name: 'local', description: 'Local' });
    writeComponent(tmpDir, 'admin', { default: {} });
    writeContract(tmpDir, 'admin', {
      name: 'admin',
      target: {
        type: 'docker-compose',
        file: 'docker-compose.yml',
        service: 'admin',
        subdomain: 'admin',
        config: { ports: ['3664:3664'] },
      },
      vars: {},
    });

    const result = await buildAll({ local: '-local' });
    expect(result.success).toBe(true);

    expect(fs.existsSync(path.join(tmpDir, 'nginx.conf'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'Caddyfile'))).toBe(true);
  });

  it('uses suffixed filenames when multiple profiles emit caddy', async () => {
    writeCeConfig(tmpDir, {
      envDir: 'env',
      defaultProfile: 'local',
      profiles: {
        local: { suffix: '-local', domain: 'numero.local', proxy: 'caddy' },
        staging: { suffix: '-stg', domain: 'staging.numero.com', proxy: 'caddy' },
      },
    });
    writeProfile(tmpDir, 'local', { name: 'local', description: 'Local' });
    writeProfile(tmpDir, 'staging', { name: 'staging', description: 'Staging' });
    writeComponent(tmpDir, 'admin', { default: {} });
    writeContract(tmpDir, 'admin', {
      name: 'admin',
      target: {
        type: 'docker-compose',
        file: 'docker-compose.yml',
        service: 'admin',
        subdomain: 'admin',
        config: { ports: ['3664:3664'] },
      },
      vars: {},
    });

    const result = await buildAll({ local: '-local', staging: '-stg' });
    expect(result.success).toBe(true);

    expect(fs.existsSync(path.join(tmpDir, 'Caddyfile.local'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'Caddyfile.staging'))).toBe(true);

    const local = fs.readFileSync(path.join(tmpDir, 'Caddyfile.local'), 'utf8');
    expect(local).toContain('admin.numero.local {');
    expect(local).toContain('reverse_proxy admin-local:3664');

    const staging = fs.readFileSync(path.join(tmpDir, 'Caddyfile.staging'), 'utf8');
    expect(staging).toContain('admin.staging.numero.com {');
    expect(staging).toContain('reverse_proxy admin-stg:3664');
  });

  it('skips contracts without subdomain', async () => {
    writeCeConfig(tmpDir, {
      envDir: 'env',
      defaultProfile: 'local',
      profiles: {
        local: { suffix: '-local', domain: 'numero.local', proxy: 'caddy' },
      },
    });
    writeProfile(tmpDir, 'local', { name: 'local', description: 'Local' });
    writeComponent(tmpDir, 'redis', { default: {} });
    writeContract(tmpDir, 'redis', {
      name: 'redis',
      // No subdomain — internal service, not browser-facing
      target: {
        type: 'docker-compose',
        file: 'docker-compose.yml',
        service: 'redis',
        config: { ports: ['6379:6379'] },
      },
      vars: {},
    });

    const result = await buildAll({ local: '-local' });
    expect(result.success).toBe(true);

    // No Caddyfile written when nothing has a subdomain
    expect(fs.existsSync(path.join(tmpDir, 'Caddyfile'))).toBe(false);
  });

  it('resolves variable refs in target.config.ports before parsing', async () => {
    // Regression: contracts using "${component.PORT}:${component.PORT}"
    // for the port field were silently dropped from the proxy config.
    // The builder must resolve the ports before passing to the emitter.
    writeCeConfig(tmpDir, {
      envDir: 'env',
      defaultProfile: 'local',
      profiles: {
        local: { suffix: '-local', domain: 'numero.local', proxy: 'caddy' },
      },
    });
    writeProfile(tmpDir, 'local', { name: 'local', description: 'Local' });
    writeComponent(tmpDir, 'poker', { default: { PORT: '3666' } });
    writeContract(tmpDir, 'poker', {
      name: 'poker',
      target: {
        type: 'docker-compose',
        file: 'docker-compose.yml',
        service: 'poker',
        subdomain: 'poker',
        config: { ports: ['${poker.PORT}:${poker.PORT}'] },
      },
      vars: { PORT: '${poker.PORT}' },
    });

    const result = await buildAll({ local: '-local' });
    expect(result.success).toBe(true);

    const caddyPath = path.join(tmpDir, 'Caddyfile');
    expect(fs.existsSync(caddyPath)).toBe(true);
    const content = fs.readFileSync(caddyPath, 'utf8');
    // The ${poker.PORT} reference should have resolved to 3666 before
    // the emitter parsed the ports field.
    expect(content).toContain('poker.numero.local {');
    expect(content).toContain('reverse_proxy poker-local:3666');
  });

  it('auto-injects a caddy container into docker-compose when proxy:caddy + subdomain', async () => {
    const composeFile = path.join(tmpDir, 'docker-compose.yml');
    writeCeConfig(tmpDir, {
      envDir: 'env',
      defaultProfile: 'local',
      profiles: {
        local: { suffix: '-local', domain: 'numero.local', proxy: 'caddy' },
      },
    });
    writeProfile(tmpDir, 'local', { name: 'local', description: 'Local' });
    writeComponent(tmpDir, 'admin', { default: {} });
    writeContract(tmpDir, 'admin', {
      name: 'admin',
      target: {
        type: 'docker-compose',
        file: composeFile,
        service: 'admin',
        subdomain: 'admin',
        config: { ports: ['3664:3664'] },
      },
      vars: {},
    });

    const result = await buildAll({ local: '-local' });
    expect(result.success).toBe(true);

    const compose = fs.readFileSync(composeFile, 'utf8');
    // The synthesized caddy service should appear in compose, with the
    // expected image, ports, and Caddyfile mount.
    expect(compose).toContain('caddy:2-alpine');
    expect(compose).toContain('80:80');
    expect(compose).toContain('443:443');
    expect(compose).toMatch(/\.\/Caddyfile:\/etc\/caddy\/Caddyfile/);
    // Profile-suffixed service name (caddy-local)
    expect(compose).toContain('caddy-local');
  });

  it('does NOT inject caddy when no contract has subdomain', async () => {
    const composeFile = path.join(tmpDir, 'docker-compose.yml');
    writeCeConfig(tmpDir, {
      envDir: 'env',
      defaultProfile: 'local',
      profiles: {
        local: { suffix: '-local', domain: 'numero.local', proxy: 'caddy' },
      },
    });
    writeProfile(tmpDir, 'local', { name: 'local', description: 'Local' });
    writeComponent(tmpDir, 'redis', { default: {} });
    writeContract(tmpDir, 'redis', {
      name: 'redis',
      target: {
        type: 'docker-compose',
        file: composeFile,
        service: 'redis',
        config: { ports: ['6379:6379'] },
      },
      vars: {},
    });

    const result = await buildAll({ local: '-local' });
    expect(result.success).toBe(true);

    const compose = fs.readFileSync(composeFile, 'utf8');
    expect(compose).not.toContain('caddy:2-alpine');
  });

  it('does NOT overwrite a user-authored caddy contract', async () => {
    const composeFile = path.join(tmpDir, 'docker-compose.yml');
    writeCeConfig(tmpDir, {
      envDir: 'env',
      defaultProfile: 'local',
      profiles: {
        local: { suffix: '-local', domain: 'numero.local', proxy: 'caddy' },
      },
    });
    writeProfile(tmpDir, 'local', { name: 'local', description: 'Local' });
    writeComponent(tmpDir, 'admin', { default: {} });
    writeContract(tmpDir, 'admin', {
      name: 'admin',
      target: {
        type: 'docker-compose',
        file: composeFile,
        service: 'admin',
        subdomain: 'admin',
        config: { ports: ['3664:3664'] },
      },
      vars: {},
    });
    // User-authored caddy contract with a custom image
    writeContract(tmpDir, 'caddy', {
      name: 'caddy',
      target: {
        type: 'docker-compose',
        file: composeFile,
        service: 'caddy',
        config: {
          image: 'caddy:2.7-alpine', // Custom version
          ports: ['8080:80', '8443:443'], // Custom host ports
          volumes: ['./Caddyfile:/etc/caddy/Caddyfile:ro'],
        },
      },
      vars: {},
    });

    const result = await buildAll({ local: '-local' });
    expect(result.success).toBe(true);

    const compose = fs.readFileSync(composeFile, 'utf8');
    // Synthesized version would have caddy:2-alpine and 80:80, but the
    // user-authored contract takes precedence.
    expect(compose).toContain('caddy:2.7-alpine');
    expect(compose).toContain('8080:80');
    expect(compose).toContain('8443:443');
    expect(compose).not.toContain('caddy:2-alpine');
  });

  it('emits "tls internal" inside vhost blocks when profile.tlsInternal is true', async () => {
    // For non-.local TLDs (.test, .dev, etc.) Caddy's default behavior is
    // to try Let's Encrypt — which fails locally because there's no public
    // DNS. tlsInternal: true forces Caddy to use its internal CA instead.
    writeCeConfig(tmpDir, {
      envDir: 'env',
      defaultProfile: 'test',
      profiles: {
        test: {
          suffix: '',
          domain: 'numero.test',
          proxy: 'caddy',
          tlsInternal: true,
        },
      },
    });
    writeProfile(tmpDir, 'test', { name: 'test', description: 'Test' });
    writeComponent(tmpDir, 'admin', { default: {} });
    writeContract(tmpDir, 'admin', {
      name: 'admin',
      target: {
        type: 'docker-compose',
        file: 'docker-compose.yml',
        service: 'admin',
        subdomain: 'admin',
        config: { ports: ['3664:3664'] },
      },
      vars: {},
    });

    const result = await buildAll({ test: '' });
    expect(result.success).toBe(true);

    const caddyPath = path.join(tmpDir, 'Caddyfile');
    expect(fs.existsSync(caddyPath)).toBe(true);

    const content = fs.readFileSync(caddyPath, 'utf8');
    expect(content).toContain('admin.numero.test {');
    expect(content).toContain('tls internal');
    expect(content).toContain('reverse_proxy admin:3664');
  });

  it('omits "tls internal" by default (so .local domains use Caddy default)', async () => {
    writeCeConfig(tmpDir, {
      envDir: 'env',
      defaultProfile: 'local',
      profiles: {
        local: { suffix: '-local', domain: 'numero.local', proxy: 'caddy' },
      },
    });
    writeProfile(tmpDir, 'local', { name: 'local', description: 'Local' });
    writeComponent(tmpDir, 'admin', { default: {} });
    writeContract(tmpDir, 'admin', {
      name: 'admin',
      target: {
        type: 'docker-compose',
        file: 'docker-compose.yml',
        service: 'admin',
        subdomain: 'admin',
        config: { ports: ['3664:3664'] },
      },
      vars: {},
    });

    const result = await buildAll({ local: '-local' });
    expect(result.success).toBe(true);

    const content = fs.readFileSync(path.join(tmpDir, 'Caddyfile'), 'utf8');
    expect(content).toContain('admin.numero.local {');
    // No explicit tls directive — Caddy's default auto-issues internal CA on .local
    expect(content).not.toContain('tls internal');
  });

  it('REGRESSION: env:build <X> emits services for ALL profiles, not just X', async () => {
    // Bug: env:build local would write a compose file with ONLY local
    // services, dropping the test variants. Then dc:up test had nothing
    // to start. Fix: every env:build re-resolves all other profiles for
    // the compose output (only .env.{profile} files stay per-profile).
    const composeFile = path.join(tmpDir, 'docker-compose.yml');
    writeCeConfig(tmpDir, {
      envDir: 'env',
      defaultProfile: 'local',
      profiles: {
        local: { suffix: '-local', domain: 'numero.local' },
        test:  { suffix: '-test',  domain: 'numero.test' },
      },
    });
    writeProfile(tmpDir, 'local', { name: 'local', description: 'Local' });
    writeProfile(tmpDir, 'test',  { name: 'test',  description: 'Test' });
    writeComponent(tmpDir, 'admin', { default: {} });
    writeContract(tmpDir, 'admin', {
      name: 'admin',
      target: {
        type: 'docker-compose',
        file: composeFile,
        service: 'admin',
        config: { ports: ['3664:3664'] },
      },
      vars: {},
    });

    // Build ONLY the local profile via the single-profile path
    const builder = new EnvironmentBuilder(tmpDir, '', 'local');
    await builder.initialize();
    const result = await builder.buildFromProfile('local');
    expect(result.success).toBe(true);

    const compose = fs.readFileSync(composeFile, 'utf8');
    // Both profile variants should appear — admin-local AND admin-test
    expect(compose).toContain('admin-local');
    expect(compose).toContain('admin-test');
    // Both profile tags should appear
    expect(compose).toContain('profiles:\n      - local');
    expect(compose).toContain('profiles:\n      - test');
  });

  it('auto-gitignores the generated Caddyfile', async () => {
    writeCeConfig(tmpDir, {
      envDir: 'env',
      defaultProfile: 'local',
      profiles: {
        local: { suffix: '-local', domain: 'numero.local', proxy: 'caddy' },
      },
    });
    writeProfile(tmpDir, 'local', { name: 'local', description: 'Local' });
    writeComponent(tmpDir, 'admin', { default: {} });
    writeContract(tmpDir, 'admin', {
      name: 'admin',
      target: {
        type: 'docker-compose',
        file: 'docker-compose.yml',
        service: 'admin',
        subdomain: 'admin',
        config: { ports: ['3664:3664'] },
      },
      vars: {},
    });

    // Seed .gitignore so the file exists for append
    fs.writeFileSync(path.join(tmpDir, '.gitignore'), 'node_modules\n');

    const result = await buildAll({ local: '-local' });
    expect(result.success).toBe(true);

    const gi = fs.readFileSync(path.join(tmpDir, '.gitignore'), 'utf8');
    expect(gi).toContain('Caddyfile');
  });
});
