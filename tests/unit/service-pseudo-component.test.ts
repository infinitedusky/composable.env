import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  TestableBuilder,
  createTempEnvDir,
  writeComponent,
  writeProfile,
  writeContract,
  writeCeConfig,
  readEnvFile,
  cleanupTempDir,
} from '../fixtures/helpers.js';

describe('service pseudo-component', () => {
  let builder: TestableBuilder;

  beforeEach(() => {
    builder = new TestableBuilder('/tmp/fake', '/tmp/fake/out');
  });

  describe('generateServiceVars', () => {
    it('generates host, address, suffix, domain for target contracts', () => {
      const contracts = new Map();
      contracts.set('redis', {
        name: 'redis',
        target: { type: 'docker-compose', file: 'docker-compose.yml', service: 'redis' },
        vars: {},
      });

      const result = builder.exposedGenerateServiceVars(
        contracts, 'local', { suffix: '-local', domain: 'example.orb.local' }
      );

      expect(result['redis.host']).toBe('redis-local');
      expect(result['redis.address']).toBe('redis-local.example.orb.local');
      expect(result['redis.suffix']).toBe('-local');
      expect(result['redis.domain']).toBe('example.orb.local');
    });

    it('generates default.suffix and default.domain', () => {
      const contracts = new Map();
      const result = builder.exposedGenerateServiceVars(
        contracts, 'local', { suffix: '-local', domain: 'example.orb.local' }
      );

      expect(result['default.suffix']).toBe('-local');
      expect(result['default.domain']).toBe('example.orb.local');
    });

    it('applies per-service overrides', () => {
      const contracts = new Map();
      contracts.set('admin', {
        name: 'admin',
        target: { type: 'docker-compose', file: 'docker-compose.yml', service: 'admin' },
        vars: {},
      });

      const result = builder.exposedGenerateServiceVars(
        contracts, 'local', {
          suffix: '-local',
          domain: 'example.orb.local',
          override: { admin: { suffix: '' } },
        }
      );

      expect(result['admin.host']).toBe('admin');
      expect(result['admin.address']).toBe('admin.example.orb.local');
    });

    it('handles empty suffix (production)', () => {
      const contracts = new Map();
      contracts.set('api', {
        name: 'api',
        target: { type: 'docker-compose', file: 'docker-compose.yml', service: 'api' },
        vars: {},
      });

      const result = builder.exposedGenerateServiceVars(
        contracts, 'production', { suffix: '', domain: 'example.com' }
      );

      expect(result['api.host']).toBe('api');
      expect(result['api.address']).toBe('api.example.com');
    });

    it('skips contracts without target', () => {
      const contracts = new Map();
      contracts.set('local-app', {
        name: 'local-app',
        location: 'apps/local-app',
        vars: {},
      });

      const result = builder.exposedGenerateServiceVars(
        contracts, 'local', { suffix: '-local', domain: 'example.orb.local' }
      );

      expect(result['local-app.host']).toBeUndefined();
    });

    describe('proxy-aware (proxy: caddy + subdomain)', () => {
      it('address resolves to {subdomain}.{domain} when proxied', () => {
        const contracts = new Map();
        contracts.set('auth-server', {
          name: 'auth-server',
          target: {
            type: 'docker-compose',
            file: 'docker-compose.yml',
            service: 'auth-server',
            subdomain: 'auth',
          },
          vars: {},
        });

        const result = builder.exposedGenerateServiceVars(
          contracts, 'local', {
            suffix: '-local',
            domain: 'numero.local',
            proxy: 'caddy',
          }
        );

        // host stays Docker DNS — internal calls still use this
        expect(result['auth-server.host']).toBe('auth-server-local');
        // address is the public Caddy vhost
        expect(result['auth-server.address']).toBe('auth.numero.local');
        // protocol is https — Caddy provides TLS
        expect(result['auth-server.protocol']).toBe('https');
      });

      it('proxy: "both" also triggers proxy-aware behavior', () => {
        const contracts = new Map();
        contracts.set('admin', {
          name: 'admin',
          target: {
            type: 'docker-compose', file: 'docker-compose.yml', service: 'admin',
            subdomain: 'admin',
          },
          vars: {},
        });

        const result = builder.exposedGenerateServiceVars(
          contracts, 'local', {
            suffix: '-local',
            domain: 'numero.local',
            proxy: 'both',
          }
        );

        expect(result['admin.address']).toBe('admin.numero.local');
        expect(result['admin.protocol']).toBe('https');
      });

      it('contract WITHOUT subdomain stays on Docker DNS even when proxy is set', () => {
        // Internal services (redis, postgres, etc.) aren't browser-routable.
        // Their service.address should keep returning the Docker DNS form
        // so other containers can reach them via the internal network.
        const contracts = new Map();
        contracts.set('redis', {
          name: 'redis',
          target: {
            type: 'docker-compose', file: 'docker-compose.yml', service: 'redis',
            // No subdomain — internal-only
          },
          vars: {},
        });

        const result = builder.exposedGenerateServiceVars(
          contracts, 'local', {
            suffix: '-local',
            domain: 'numero.local',
            proxy: 'caddy',
          }
        );

        expect(result['redis.host']).toBe('redis-local');
        expect(result['redis.address']).toBe('redis-local.numero.local');
        expect(result['redis.protocol']).toBe('http');
      });

      it('proxy: "nginx" (default) does NOT change address — only caddy does', () => {
        // nginx config is typically configured for TLS production-side, but
        // composable.env doesn't manage that cert chain — only Caddy is
        // turnkey TLS. Keep the address on Docker DNS for nginx profiles
        // unless the user explicitly opts into proxy: "caddy" for the
        // specific local-dev shape Caddy provides.
        const contracts = new Map();
        contracts.set('admin', {
          name: 'admin',
          target: {
            type: 'docker-compose', file: 'docker-compose.yml', service: 'admin',
            subdomain: 'admin',
          },
          vars: {},
        });

        const result = builder.exposedGenerateServiceVars(
          contracts, 'production', {
            suffix: '',
            domain: 'example.com',
            proxy: 'nginx',
          }
        );

        // No proxy:caddy → address stays on Docker DNS form
        expect(result['admin.address']).toBe('admin.example.com');
        // (Happens to look right because suffix is "" in production, but the
        // logic isn't proxy-aware here — it's just the Docker DNS form.)
        expect(result['admin.protocol']).toBe('http');
      });

      it('per-service domain override flows through to the proxy address', () => {
        const contracts = new Map();
        contracts.set('admin', {
          name: 'admin',
          target: {
            type: 'docker-compose', file: 'docker-compose.yml', service: 'admin',
            subdomain: 'admin',
          },
          vars: {},
        });

        const result = builder.exposedGenerateServiceVars(
          contracts, 'production', {
            suffix: '',
            domain: 'chitin.casino',
            proxy: 'caddy',
            override: { admin: { domain: 'admin-panel.example.com' } },
          }
        );

        expect(result['admin.address']).toBe('admin.admin-panel.example.com');
      });
    });
  });

  describe('REGRESSION: service vars resolve in components', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = createTempEnvDir();
    });

    afterEach(() => {
      cleanupTempDir(tmpDir);
    });

    it('${service.redis.address} resolves when used in a component', () => {
      // This was the core bug: service vars were injected after
      // resolveCrossComponentRefs, so components couldn't use them
      const pool = new Map<string, Record<string, string>>();
      pool.set('service', {
        'redis.host': 'redis-local',
        'redis.address': 'redis-local.example.orb.local',
        'redis.suffix': '-local',
        'redis.domain': 'example.orb.local',
      });
      pool.set('redis', {
        PORT: '6379',
        URL: 'redis://${service.redis.address}:${redis.PORT}',
      });

      builder.exposedResolveCrossComponentRefs(pool);

      expect(pool.get('redis')!['URL']).toBe('redis://redis-local.example.orb.local:6379');
    });

    it('component chain: service -> component URL -> contract', () => {
      const pool = new Map<string, Record<string, string>>();
      pool.set('service', {
        'chromadb.host': 'chromadb-local',
        'chromadb.address': 'chromadb-local.test.orb.local',
      });
      pool.set('chromadb', {
        PORT: '8000',
        URL: 'http://${service.chromadb.address}:${chromadb.PORT}',
      });

      // First: cross-component resolution
      builder.exposedResolveCrossComponentRefs(pool);
      expect(pool.get('chromadb')!['URL']).toBe('http://chromadb-local.test.orb.local:8000');

      // Then: flatten for contract resolution
      const flat = builder.exposedFlattenComponentPool(pool);
      expect(flat['chromadb.URL']).toBe('http://chromadb-local.test.orb.local:8000');
    });
  });
});
