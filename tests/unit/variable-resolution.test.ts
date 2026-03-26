import { describe, it, expect, beforeEach } from 'vitest';
import { TestableBuilder } from '../fixtures/helpers.js';

describe('variable resolution', () => {
  let builder: TestableBuilder;

  beforeEach(() => {
    // Builder needs a configDir and outputPath — we won't use filesystem here
    builder = new TestableBuilder('/tmp/fake', '/tmp/fake/out');
  });

  describe('resolveVariables (flat pool)', () => {
    it('resolves simple ${key} references', () => {
      const result = builder.exposedResolveVariables({
        'HOST': 'localhost',
        'PORT': '5432',
        'URL': 'postgresql://${HOST}:${PORT}/mydb',
      });
      expect(result['URL']).toBe('postgresql://localhost:5432/mydb');
    });

    it('resolves chained references across multiple passes', () => {
      const result = builder.exposedResolveVariables({
        'A': '${B}-suffix',
        'B': '${C}-middle',
        'C': 'base',
      });
      expect(result['A']).toBe('base-middle-suffix');
    });

    it('leaves unresolvable refs as-is', () => {
      const result = builder.exposedResolveVariables({
        'URL': 'http://${MISSING_HOST}:3000',
      });
      expect(result['URL']).toBe('http://${MISSING_HOST}:3000');
    });

    it('does not infinite loop on circular refs', () => {
      const result = builder.exposedResolveVariables({
        'A': '${B}',
        'B': '${A}',
      });
      // Should complete without hanging — values stay unresolved
      expect(result['A']).toContain('${');
      expect(result['B']).toContain('${');
    });
  });

  describe('resolveCrossComponentRefs (scoped pool)', () => {
    it('resolves ${component.KEY} across components', () => {
      const pool = new Map<string, Record<string, string>>();
      pool.set('database', { HOST: 'localhost', PORT: '5432' });
      pool.set('app', { DB_HOST: '${database.HOST}', DB_PORT: '${database.PORT}' });

      builder.exposedResolveCrossComponentRefs(pool);

      expect(pool.get('app')!['DB_HOST']).toBe('localhost');
      expect(pool.get('app')!['DB_PORT']).toBe('5432');
    });

    it('resolves multi-level cross-component chains', () => {
      const pool = new Map<string, Record<string, string>>();
      pool.set('database', { HOST: 'localhost', PORT: '5432' });
      pool.set('networking', { DB_URL: 'postgresql://${database.HOST}:${database.PORT}' });
      pool.set('app', { CONNECTION: '${networking.DB_URL}/mydb' });

      builder.exposedResolveCrossComponentRefs(pool);

      expect(pool.get('networking')!['DB_URL']).toBe('postgresql://localhost:5432');
      expect(pool.get('app')!['CONNECTION']).toBe('postgresql://localhost:5432/mydb');
    });

    it('REGRESSION: splits ${service.name.key} on first dot', () => {
      // Bug: greedy regex split service.chromadb.address as
      //   component="service.chromadb", key="address"
      // instead of component="service", key="chromadb.address"
      const pool = new Map<string, Record<string, string>>();
      pool.set('service', {
        'chromadb.host': 'chromadb-local',
        'chromadb.address': 'chromadb-local.example.com',
      });
      pool.set('chromadb', {
        URL: 'http://${service.chromadb.address}:8000',
      });

      builder.exposedResolveCrossComponentRefs(pool);

      expect(pool.get('chromadb')!['URL']).toBe('http://chromadb-local.example.com:8000');
    });

    it('REGRESSION: resolves ${service.default.domain}', () => {
      const pool = new Map<string, Record<string, string>>();
      pool.set('service', {
        'default.domain': 'example.orb.local',
        'default.suffix': '-local',
      });
      pool.set('app', {
        DOMAIN: '${service.default.domain}',
      });

      builder.exposedResolveCrossComponentRefs(pool);

      expect(pool.get('app')!['DOMAIN']).toBe('example.orb.local');
    });

    it('skips secrets component', () => {
      const pool = new Map<string, Record<string, string>>();
      pool.set('secrets', { DB_PASS: 'supersecret' });
      pool.set('app', { PASS: '${secrets.DB_PASS}' });

      builder.exposedResolveCrossComponentRefs(pool);

      // secrets are resolved in a separate pass, not here
      expect(pool.get('app')!['PASS']).toBe('${secrets.DB_PASS}');
    });

    it('does not infinite loop on circular cross-component refs', () => {
      const pool = new Map<string, Record<string, string>>();
      pool.set('a', { VAL: '${b.VAL}' });
      pool.set('b', { VAL: '${a.VAL}' });

      // Should complete without hanging
      builder.exposedResolveCrossComponentRefs(pool);

      // Values stay unresolved
      expect(pool.get('a')!['VAL']).toContain('${');
    });
  });
});
