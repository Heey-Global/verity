import { describe, expect, it } from 'vitest';
import { clientLabel, identifyClient } from './client-identity.js';

describe('identifyClient', () => {
  it('takes the kind and release the app declares', () => {
    expect(identifyClient({ 'x-verity-client': 'ios/1.95.4' })).toEqual({
      kind: 'ios',
      version: '1.95.4',
    });
  });

  // A client that could choose its own label would grow the counter set (and
  // the server's memory) with every invented value.
  it('never turns an unknown declared kind or a malformed version into a label', () => {
    expect(identifyClient({ 'x-verity-client': 'evil/1.0', 'user-agent': 'curl/8' }).kind).toBe(
      'cli',
    );
    expect(identifyClient({ 'x-verity-client': 'ios/1.0; drop table' })).toEqual({
      kind: 'ios',
      version: null,
    });
    expect(identifyClient({ 'x-verity-client': `ios/${'1.'.repeat(30)}1` }).version).toBeNull();
  });

  it('falls back to the user agent', () => {
    expect(identifyClient({ 'user-agent': 'Verity/1 CFNetwork/1498 Darwin/24' }).kind).toBe('ios');
    expect(identifyClient({ 'user-agent': 'okhttp/4.12' }).kind).toBe('android');
    expect(identifyClient({ 'user-agent': 'Mozilla/5.0 (Macintosh)' }).kind).toBe('web');
    expect(identifyClient({ 'user-agent': 'node' }).kind).toBe('agent');
    expect(identifyClient({}).kind).toBe('other');
  });

  it('labels with the version only when it is known', () => {
    expect(clientLabel({ kind: 'web', version: null })).toBe('web');
    expect(clientLabel({ kind: 'android', version: '2.0' })).toBe('android/2.0');
  });
});
