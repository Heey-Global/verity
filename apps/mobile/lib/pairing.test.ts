import { createPairingUri, parsePairingUri } from './pairing';

const now = new Date('2026-08-29T12:00:00.000Z');
const basePayload = {
  v: 1,
  serverId: 'srv_0123456789abcdef',
  identityKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  tlsPin: 'sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  code: 'abcdefghijklmnopqrstuvwxyz_0123456789',
  url: 'https://192.168.1.42:8082/path?ignored=1',
  expiresAt: '2026-08-29T12:15:00.000Z',
};

function uri(overrides: Record<string, unknown> = {}): string {
  const json = JSON.stringify({ ...basePayload, ...overrides });
  const payload = btoa(json).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `verity://pair?payload=${payload}`;
}

describe('parsePairingUri', () => {
  it('parses and canonicalizes an installer pairing URI', () => {
    expect(parsePairingUri(uri(), now)).toMatchObject({
      serverId: 'srv_0123456789abcdef',
      suggestedUrl: 'https://192.168.1.42:8082',
      expiresAt: '2026-08-29T12:15:00.000Z',
    });
  });

  it('round-trips an additional-device invitation', () => {
    const parsed = parsePairingUri(uri({ kind: 'device' }), now);
    expect(parsePairingUri(createPairingUri(parsed), now)).toEqual(parsed);
    expect(parsed.kind).toBe('device');
  });

  it('rejects plaintext and embedded credentials', () => {
    expect(() => parsePairingUri(uri({ url: 'http://192.168.1.42:8082' }), now)).toThrow(
      'requires an HTTPS',
    );
    expect(() => parsePairingUri(uri({ url: 'https://user:pass@192.168.1.42' }), now)).toThrow(
      'requires an HTTPS',
    );
  });

  it('rejects expired and implausibly long-lived codes', () => {
    expect(() => parsePairingUri(uri({ expiresAt: '2026-08-29T11:59:00.000Z' }), now)).toThrow(
      'expired',
    );
    expect(() => parsePairingUri(uri({ expiresAt: '2026-08-29T14:00:00.000Z' }), now)).toThrow(
      'outside the allowed window',
    );
  });

  it('rejects malformed compact payloads and pins', () => {
    expect(() => parsePairingUri('verity://pair?payload=%25%25%25', now)).toThrow(
      'Invalid pairing-code payload',
    );
    expect(() => parsePairingUri(uri({ tlsPin: 'sha256/AAAA=' }), now)).toThrow(
      'Invalid TLS certificate pin',
    );
  });
});
