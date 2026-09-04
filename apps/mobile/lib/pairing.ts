export interface VerityPairingPayload {
  version: 1;
  kind?: 'installer' | 'device';
  serverId: string;
  identityKey: string;
  tlsPin: string;
  pairingCode: string;
  suggestedUrl: string;
  expiresAt: string;
}

const TOKEN = /^[A-Za-z0-9_-]+$/;
const SHA256_PIN = /^sha256-[A-Za-z0-9_-]{43}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

function decodePayload(encoded: string): unknown {
  if (!BASE64URL.test(encoded)) throw new Error('Invalid pairing-code payload.');
  const padded =
    encoded.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (encoded.length % 4)) % 4);
  try {
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error('Invalid pairing-code payload.');
  }
}

/** Parse the deliberately small URI shown by `verity-install`. No field is trusted
 * until the pinned TLS handshake and signed identity challenge both succeed. */
export function parsePairingUri(raw: string, now: Date = new Date()): VerityPairingPayload {
  const uri = new URL(raw.trim());
  if (uri.protocol !== 'verity:' || uri.hostname !== 'pair' || uri.pathname !== '') {
    throw new Error('This is not a Verity pairing code.');
  }
  const payload = decodePayload(uri.searchParams.get('payload') ?? '');
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Invalid pairing-code payload.');
  }
  const fields = payload as Record<string, unknown>;
  if (fields.v !== 1) throw new Error('Unsupported pairing-code version.');
  const serverId = typeof fields.serverId === 'string' ? fields.serverId : '';
  const identityKey = typeof fields.identityKey === 'string' ? fields.identityKey : '';
  const tlsPin = typeof fields.tlsPin === 'string' ? fields.tlsPin : '';
  const pairingCode = typeof fields.code === 'string' ? fields.code : '';
  const suggestedUrlRaw = typeof fields.url === 'string' ? fields.url : '';
  const expiresAt = typeof fields.expiresAt === 'string' ? fields.expiresAt : '';
  const kind = fields.kind === 'device' ? 'device' : 'installer';
  if (!TOKEN.test(serverId) || serverId.length < 16 || serverId.length > 128) {
    throw new Error('Invalid server identity.');
  }
  if (!TOKEN.test(identityKey) || identityKey.length < 40 || identityKey.length > 128) {
    throw new Error('Invalid server identity key.');
  }
  if (!SHA256_PIN.test(tlsPin)) throw new Error('Invalid TLS certificate pin.');
  if (!TOKEN.test(pairingCode) || pairingCode.length < 32 || pairingCode.length > 128) {
    throw new Error('Invalid pairing secret.');
  }
  const suggestedUrl = new URL(suggestedUrlRaw);
  if (suggestedUrl.protocol !== 'https:' || suggestedUrl.username || suggestedUrl.password) {
    throw new Error('Pairing requires an HTTPS server address.');
  }
  suggestedUrl.pathname = '';
  suggestedUrl.search = '';
  suggestedUrl.hash = '';
  const expiry = Date.parse(expiresAt);
  if (!Number.isFinite(expiry) || expiry <= now.getTime()) {
    throw new Error('This pairing code has expired.');
  }
  if (expiry > now.getTime() + 60 * 60 * 1000) {
    throw new Error('Pairing-code expiry is outside the allowed window.');
  }
  return {
    version: 1,
    kind,
    serverId,
    identityKey,
    tlsPin,
    pairingCode,
    suggestedUrl: suggestedUrl.origin,
    expiresAt: new Date(expiry).toISOString(),
  };
}

export function createPairingUri(payload: VerityPairingPayload): string {
  const json = JSON.stringify({
    v: payload.version,
    kind: payload.kind ?? 'installer',
    serverId: payload.serverId,
    identityKey: payload.identityKey,
    tlsPin: payload.tlsPin,
    code: payload.pairingCode,
    url: payload.suggestedUrl,
    expiresAt: payload.expiresAt,
  });
  const bytes = new TextEncoder().encode(json);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const encoded = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `verity://pair?payload=${encoded}`;
}
