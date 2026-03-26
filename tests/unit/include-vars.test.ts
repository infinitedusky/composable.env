import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createTempEnvDir,
  writeContract,
  writeVarSet,
  cleanupTempDir,
} from '../fixtures/helpers.js';
import { ContractManager } from '../../src/contracts.js';

describe('includeVars', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTempEnvDir();
  });

  afterEach(() => {
    cleanupTempDir(tmpDir);
  });

  it('merges var set into contract vars', async () => {
    writeVarSet(tmpDir, 'platform-base', {
      vars: {
        DATABASE_URL: '${database.URL}',
        REDIS_URL: '${redis.URL}',
      },
    });

    writeContract(tmpDir, 'api', {
      name: 'api',
      location: 'apps/api',
      includeVars: ['platform-base'],
      vars: { PORT: '${api.PORT}' },
    });

    const manager = new ContractManager(tmpDir);
    await manager.initialize();

    const contract = manager.getContracts().get('api');
    expect(contract!.vars).toEqual({
      DATABASE_URL: '${database.URL}',
      REDIS_URL: '${redis.URL}',
      PORT: '${api.PORT}',
    });
  });

  it('contract vars override var set on conflict', async () => {
    writeVarSet(tmpDir, 'base', {
      vars: { PORT: '${base.PORT}' },
    });

    writeContract(tmpDir, 'api', {
      name: 'api',
      location: 'apps/api',
      includeVars: ['base'],
      vars: { PORT: '${api.PORT}' },
    });

    const manager = new ContractManager(tmpDir);
    await manager.initialize();

    const contract = manager.getContracts().get('api');
    expect(contract!.vars!['PORT']).toBe('${api.PORT}');
  });

  it('supports chained includes', async () => {
    writeVarSet(tmpDir, 'common', {
      vars: { COMMON: '${common.VAL}' },
    });

    writeVarSet(tmpDir, 'web', {
      includeVars: ['common'],
      vars: { WEB: '${web.VAL}' },
    });

    writeContract(tmpDir, 'app', {
      name: 'app',
      location: 'apps/app',
      includeVars: ['web'],
      vars: { APP: '${app.VAL}' },
    });

    const manager = new ContractManager(tmpDir);
    await manager.initialize();

    const contract = manager.getContracts().get('app');
    expect(contract!.vars).toEqual({
      COMMON: '${common.VAL}',
      WEB: '${web.VAL}',
      APP: '${app.VAL}',
    });
  });

  it('detects circular includes', async () => {
    writeVarSet(tmpDir, 'a', {
      includeVars: ['b'],
      vars: { A: 'a' },
    });

    writeVarSet(tmpDir, 'b', {
      includeVars: ['a'],
      vars: { B: 'b' },
    });

    writeContract(tmpDir, 'app', {
      name: 'app',
      location: 'apps/app',
      includeVars: ['a'],
      vars: {},
    });

    const manager = new ContractManager(tmpDir);
    // Should not throw — warns instead
    await manager.initialize();

    // The contract may have partial vars but shouldn't crash
    const contract = manager.getContracts().get('app');
    expect(contract).toBeDefined();
  });

  it('warns on missing var set without crashing', async () => {
    writeContract(tmpDir, 'app', {
      name: 'app',
      location: 'apps/app',
      includeVars: ['nonexistent'],
      vars: { PORT: '3000' },
    });

    const manager = new ContractManager(tmpDir);
    // Should not throw
    await manager.initialize();

    const contract = manager.getContracts().get('app');
    expect(contract!.vars!['PORT']).toBe('3000');
  });

  it('supports var sets in subdirectories', async () => {
    const subDir = `${tmpDir}/env/contracts/shared`;
    const fs = await import('fs');
    fs.mkdirSync(subDir, { recursive: true });
    fs.writeFileSync(
      `${subDir}/platform.vars.json`,
      JSON.stringify({ vars: { SHARED: '${shared.VAL}' } })
    );

    writeContract(tmpDir, 'app', {
      name: 'app',
      location: 'apps/app',
      includeVars: ['shared/platform'],
      vars: {},
    });

    const manager = new ContractManager(tmpDir);
    await manager.initialize();

    const contract = manager.getContracts().get('app');
    expect(contract!.vars!['SHARED']).toBe('${shared.VAL}');
  });
});
