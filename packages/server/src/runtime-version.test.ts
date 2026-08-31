import { describe, expect, it } from 'vitest';
import { runtimeServerVersion, SERVER_VERSION_STAMP } from './runtime-version.js';

describe('runtimeServerVersion', () => {
  it('prefers the immutable image stamp over an inherited outgoing version', () => {
    const readStamp = (path: string): string => {
      expect(path).toBe(SERVER_VERSION_STAMP);
      return '12.0.0\n';
    };
    expect(runtimeServerVersion(readStamp, { VERITY_SERVER_VERSION: '11.0.0' })).toBe('12.0.0');
  });

  it('uses the environment for unstamped development builds', () => {
    const missing = (): never => {
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    };
    expect(runtimeServerVersion(missing, { VERITY_SERVER_VERSION: '0.0.0-dev' })).toBe('0.0.0-dev');
  });

  it('fails closed when a shipped stamp is malformed', () => {
    expect(() => runtimeServerVersion(() => 'latest', {})).toThrow(/invalid version stamp/);
  });
});
