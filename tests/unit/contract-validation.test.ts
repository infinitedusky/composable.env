import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  TestableBuilder,
  createTempEnvDir,
  writeComponent,
  writeContract,
  cleanupTempDir,
} from '../fixtures/helpers.js';
import { ContractManager } from '../../src/contracts.js';

describe('contract validation', () => {
  describe('validateVarsContract', () => {
    let tmpDir: string;
    let manager: ContractManager;

    beforeEach(async () => {
      tmpDir = createTempEnvDir();
    });

    afterEach(() => {
      cleanupTempDir(tmpDir);
    });

    it('valid when all refs exist in pool', async () => {
      writeContract(tmpDir, 'api', {
        name: 'api',
        location: 'apps/api',
        vars: { DB_URL: '${database.URL}' },
      });

      manager = new ContractManager(tmpDir);
      await manager.initialize();

      const pool = new Map<string, Record<string, string>>();
      pool.set('database', { URL: 'postgresql://localhost:5432/mydb' });

      const result = manager.validateVarsContract('api', pool);
      expect(result.valid).toBe(true);
      expect(result.missing).toHaveLength(0);
    });

    it('invalid when ref is missing', async () => {
      writeContract(tmpDir, 'api', {
        name: 'api',
        location: 'apps/api',
        vars: { DB_URL: '${database.URL}' },
      });

      manager = new ContractManager(tmpDir);
      await manager.initialize();

      const pool = new Map<string, Record<string, string>>();
      pool.set('database', { HOST: 'localhost' }); // URL is missing

      const result = manager.validateVarsContract('api', pool);
      expect(result.valid).toBe(false);
      expect(result.missing.length).toBeGreaterThan(0);
      expect(result.missing[0]).toContain('database.URL');
    });

    it('valid with default for missing ref', async () => {
      writeContract(tmpDir, 'api', {
        name: 'api',
        location: 'apps/api',
        vars: { LOG_LEVEL: '${app.LOG_LEVEL}' },
        defaults: { LOG_LEVEL: 'info' },
      });

      manager = new ContractManager(tmpDir);
      await manager.initialize();

      const pool = new Map<string, Record<string, string>>();
      // app component doesn't exist at all

      const result = manager.validateVarsContract('api', pool);
      expect(result.valid).toBe(true);
    });

    it('REGRESSION: validates against resolved pool, not raw', () => {
      // Bug: validation ran against raw componentPool where
      // database.URL was still "postgresql://${database.HOST}:5432"
      // The resolvedComponentPool has the fully expanded value.
      const builder = new TestableBuilder('/tmp/fake', '/tmp/fake/out');

      const rawPool = new Map<string, Record<string, string>>();
      rawPool.set('database', {
        HOST: 'localhost',
        PORT: '5432',
        URL: 'postgresql://${database.HOST}:${database.PORT}/mydb',
      });

      // Simulate what the builder does: resolve, then rebuild
      const flat = builder.exposedFlattenComponentPool(rawPool);
      const resolved = builder.exposedResolveVariables(flat);
      const rebuiltPool = builder.exposedRebuildComponentPool(rawPool, resolved);

      // The rebuilt pool should have fully resolved values
      expect(rebuiltPool.get('database')!['URL']).toBe('postgresql://localhost:5432/mydb');

      // Raw pool still has unresolved refs
      expect(rawPool.get('database')!['URL']).toContain('${');
    });
  });
});
