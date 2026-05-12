import { describe, it, expect, beforeEach } from 'vitest';
import { TestableBuilder } from '../fixtures/helpers.js';

describe('profile pseudo-component', () => {
  let builder: TestableBuilder;

  beforeEach(() => {
    builder = new TestableBuilder('/tmp/fake', '/tmp/fake/out');
  });

  describe('generateProfileVars', () => {
    it('generates name, suffix, domain, protocol from profile config', () => {
      const result = builder.exposedGenerateProfileVars('local', {
        suffix: '-local',
        domain: 'numero.local',
      });

      expect(result.name).toBe('local');
      expect(result.suffix).toBe('-local');
      expect(result.domain).toBe('numero.local');
      expect(result.protocol).toBe('http');
    });

    it('protocol is "https" when tls is true', () => {
      const result = builder.exposedGenerateProfileVars('local', {
        suffix: '-local',
        domain: 'numero.local',
        tls: true,
      });
      expect(result.protocol).toBe('https');
    });

    it('domain defaults to empty string when missing', () => {
      const result = builder.exposedGenerateProfileVars('default', {
        suffix: '',
      });
      expect(result.domain).toBe('');
    });

    it('uses the actual profile name passed in', () => {
      const result = builder.exposedGenerateProfileVars('production', {
        suffix: '',
        domain: 'chitin.casino',
      });
      expect(result.name).toBe('production');
    });

    it('uses the configured suffix exactly (including empty)', () => {
      const local = builder.exposedGenerateProfileVars('local', { suffix: '-local' });
      const stg = builder.exposedGenerateProfileVars('staging', { suffix: '-stg' });
      const prod = builder.exposedGenerateProfileVars('production', { suffix: '' });

      expect(local.suffix).toBe('-local');
      expect(stg.suffix).toBe('-stg');
      expect(prod.suffix).toBe('');
    });
  });
});
