import { describe, it, expect } from 'vitest';
import { extractApps } from '../../src/execution/ecosystem.js';
import type { ServiceContract } from '../../src/contracts.js';

describe('PM2 app selection (extractApps)', () => {
  function makeContracts(entries: Record<string, ServiceContract>): Map<string, ServiceContract> {
    return new Map(Object.entries(entries));
  }

  it('skips contracts with location only (no runtime declared) — env-only contracts', () => {
    // The datadog use case: writes an env file but has nothing to run.
    const contracts = makeContracts({
      datadog: {
        name: 'datadog',
        location: '.indusk/extensions/datadog',
        vars: { DD_APP_KEY: '${datadog.APP_KEY}' },
      },
    });

    const apps = extractApps(contracts, '/project', 'local');
    expect(apps).toHaveLength(0);
  });

  it('skips docker-compose-only contracts (no location)', () => {
    const contracts = makeContracts({
      redis: {
        name: 'redis',
        target: { type: 'docker-compose', file: 'docker-compose.yml', service: 'redis' },
      },
    });

    const apps = extractApps(contracts, '/project', 'local');
    expect(apps).toHaveLength(0);
  });

  it('includes contracts with target.type: "pm2"', () => {
    const contracts = makeContracts({
      api: {
        name: 'api',
        location: 'apps/api',
        target: { type: 'pm2', command: 'pnpm dev' },
        vars: { PORT: '${api.PORT}' },
      },
    });

    const apps = extractApps(contracts, '/project', 'local');
    expect(apps).toHaveLength(1);
    expect(apps[0]).toMatchObject({
      name: 'api',
      command: 'pnpm dev',
      label: 'api',
    });
  });

  it('still includes contracts with legacy top-level dev field', () => {
    const contracts = makeContracts({
      api: {
        name: 'api',
        location: 'apps/api',
        dev: { command: 'pnpm dev', label: 'API' },
        vars: {},
      },
    });

    const apps = extractApps(contracts, '/project', 'local');
    expect(apps).toHaveLength(1);
    expect(apps[0].label).toBe('API');
  });

  it('target.type: "pm2" takes precedence over legacy dev field', () => {
    const contracts = makeContracts({
      api: {
        name: 'api',
        location: 'apps/api',
        target: { type: 'pm2', command: 'pnpm start' },
        dev: { command: 'pnpm dev' },
        vars: {},
      },
    });

    const apps = extractApps(contracts, '/project', 'local');
    expect(apps[0].command).toBe('pnpm start');
  });

  it('mixed contract set: only PM2-declared ones are included', () => {
    const contracts = makeContracts({
      datadog: {
        name: 'datadog',
        location: '.indusk/extensions/datadog',
        vars: {},
      },
      redis: {
        name: 'redis',
        target: { type: 'docker-compose', file: 'docker-compose.yml', service: 'redis' },
      },
      api: {
        name: 'api',
        location: 'apps/api',
        target: { type: 'pm2', command: 'pnpm dev' },
        vars: {},
      },
      web: {
        name: 'web',
        location: 'apps/web',
        dev: { command: 'pnpm dev' },
        vars: {},
      },
    });

    const apps = extractApps(contracts, '/project', 'local');
    const names = apps.map(a => a.name).sort();
    expect(names).toEqual(['api', 'web']);
  });

  it('uses contract.location as cwd when target.cwd not set', () => {
    const contracts = makeContracts({
      api: {
        name: 'api',
        location: 'apps/api',
        target: { type: 'pm2', command: 'pnpm dev' },
        vars: {},
      },
    });

    const apps = extractApps(contracts, '/project', 'local');
    expect(apps[0].cwd).toBe('/project/apps/api');
  });

  it('honors target.cwd override', () => {
    const contracts = makeContracts({
      api: {
        name: 'api',
        location: 'apps/api',
        target: { type: 'pm2', command: 'pnpm dev', cwd: 'apps/api/server' },
        vars: {},
      },
    });

    const apps = extractApps(contracts, '/project', 'local');
    expect(apps[0].cwd).toBe('/project/apps/api/server');
  });
});
