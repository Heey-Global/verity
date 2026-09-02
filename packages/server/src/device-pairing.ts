import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  sign,
  timingSafeEqual,
} from 'node:crypto';

const PAIRING_DOMAIN = 'verity.device-pairing.v1';
const BOOTSTRAP_BYTES = 32;
const MAX_INVITATIONS = 32;

export class DevicePairingRejectedError extends Error {}

interface DevicePairingIdentity {
  serverId: string;
  identityKey: string;
}

export interface DevicePairingManager {
  identity(): DevicePairingIdentity;
  redeem(code: string): { bootstrapToken: string; expiresAt: string };
  consumeBootstrap(token: string): boolean;
  signChallenge(challenge: string): { serverId: string; signature: string };
  issueInvitation(): { code: string; expiresAt: string };
  consumeInvitation(code: string): boolean;
}

function digest(domain: string, value: string): Buffer {
  return createHash('sha256').update(`${domain}\0${value}`).digest();
}

/** Authority for one installer-issued code. Redemption is durably burned through
 * the required persistence callbacks; a restart invalidates only the short-lived,
 * in-memory bootstrap token. */
export function createDevicePairingManager(options: {
  privateKeyPem: string;
  pairingCode?: string;
  expiresAt?: string;
  loadPairingMaterial?: () => { pairingCode: string; expiresAt: string };
  bootstrapTtlMs?: number;
  now?: () => Date;
  random?: (bytes: number) => Buffer;
  loadConsumedCodeHash?: () => string | readonly string[] | undefined;
  /** Atomically records a hash iff it was not already present. Returning false
   * means another process won the redemption race. */
  storeConsumedCodeHash?: (hash: string) => boolean;
}): DevicePairingManager {
  const now = options.now ?? (() => new Date());
  const random = options.random ?? randomBytes;
  if (
    (options.loadPairingMaterial === undefined) ===
    (options.pairingCode === undefined || options.expiresAt === undefined)
  ) {
    throw new Error('configure either static or reloadable pairing material');
  }
  const loadMaterial =
    options.loadPairingMaterial ??
    (() => ({ pairingCode: options.pairingCode!, expiresAt: options.expiresAt! }));
  const validateMaterial = () => {
    const material = loadMaterial();
    const expiry = Date.parse(material.expiresAt);
    if (!Number.isFinite(expiry)) throw new Error('invalid pairing expiry');
    if (material.pairingCode.length < 32) throw new Error('pairing code is too short');
    return { ...material, expiry };
  };
  validateMaterial();
  const privateKey = createPrivateKey(options.privateKeyPem);
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('pairing identity key must be Ed25519');
  }
  const publicDer = createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
  const identityKey = publicDer.toString('base64url');
  const serverId = `srv_${digest(`${PAIRING_DOMAIN}.server-id`, identityKey)
    .subarray(0, 16)
    .toString('base64url')}`;
  const bootstrapTtlMs = options.bootstrapTtlMs ?? 5 * 60_000;
  if (
    !Number.isSafeInteger(bootstrapTtlMs) ||
    bootstrapTtlMs <= 0 ||
    bootstrapTtlMs > 15 * 60_000
  ) {
    throw new Error('bootstrap TTL must be between 1 and 900000 ms');
  }
  if (
    (options.loadConsumedCodeHash === undefined) !==
    (options.storeConsumedCodeHash === undefined)
  ) {
    throw new Error('pairing-code persistence requires both load and store callbacks');
  }
  if (options.loadConsumedCodeHash === undefined) {
    throw new Error('pairing-code redemption requires durable consumed-code persistence');
  }
  const consumedCodeHashes = new Set<string>();
  let bootstrapHash: Buffer | undefined;
  let bootstrapExpiry = 0;
  const invitations = new Map<string, number>();

  return {
    identity: () => ({ serverId, identityKey }),
    redeem(code) {
      const instant = now().getTime();
      const material = validateMaterial();
      const expectedCode = digest(`${PAIRING_DOMAIN}.code`, material.pairingCode);
      const supplied = digest(`${PAIRING_DOMAIN}.code`, code);
      const persisted = options.loadConsumedCodeHash?.();
      const persistedHashes = new Set(
        typeof persisted === 'string' ? [persisted] : (persisted ?? []),
      );
      const expectedEncoded = expectedCode.toString('base64url');
      if (
        consumedCodeHashes.has(expectedEncoded) ||
        persistedHashes.has(expectedEncoded) ||
        instant >= material.expiry ||
        supplied.length !== expectedCode.length ||
        !timingSafeEqual(supplied, expectedCode)
      ) {
        throw new DevicePairingRejectedError('invalid or expired pairing code');
      }
      // Burn before generating the successor capability. An RNG failure must not
      // make the installer code retryable as an oracle.
      if (options.storeConsumedCodeHash?.(expectedEncoded) === false) {
        throw new DevicePairingRejectedError('invalid or expired pairing code');
      }
      consumedCodeHashes.add(expectedEncoded);
      const token = random(BOOTSTRAP_BYTES).toString('base64url');
      bootstrapHash = digest(`${PAIRING_DOMAIN}.bootstrap`, token);
      bootstrapExpiry = Math.min(material.expiry, instant + bootstrapTtlMs);
      return { bootstrapToken: token, expiresAt: new Date(bootstrapExpiry).toISOString() };
    },
    consumeBootstrap(token) {
      const expected = bootstrapHash;
      if (expected === undefined || now().getTime() >= bootstrapExpiry) return false;
      const supplied = digest(`${PAIRING_DOMAIN}.bootstrap`, token);
      const valid = supplied.length === expected.length && timingSafeEqual(supplied, expected);
      // Only the successful presentation consumes the capability. Invalid guesses are handled by
      // the route's per-client rate limit and cannot let an unauthenticated peer burn another
      // device's valid token. Clear synchronously before returning to preserve replay safety.
      if (valid) bootstrapHash = undefined;
      return valid;
    },
    signChallenge(challenge) {
      if (!/^[A-Za-z0-9_-]{32,128}$/.test(challenge)) {
        throw new DevicePairingRejectedError('invalid identity challenge');
      }
      const transcript = Buffer.from(`${PAIRING_DOMAIN}\0${serverId}\0${challenge}`);
      return { serverId, signature: sign(null, transcript, privateKey).toString('base64url') };
    },
    issueInvitation() {
      const instant = now().getTime();
      for (const [hash, expiry] of invitations) if (expiry <= instant) invitations.delete(hash);
      while (invitations.size >= MAX_INVITATIONS) {
        const oldest = invitations.keys().next().value;
        if (oldest === undefined) break;
        invitations.delete(oldest);
      }
      const code = random(BOOTSTRAP_BYTES).toString('base64url');
      const expiry = instant + 5 * 60_000;
      invitations.set(digest(`${PAIRING_DOMAIN}.invitation`, code).toString('base64url'), expiry);
      return { code, expiresAt: new Date(expiry).toISOString() };
    },
    consumeInvitation(code) {
      const hash = digest(`${PAIRING_DOMAIN}.invitation`, code).toString('base64url');
      const expiry = invitations.get(hash);
      if (expiry === undefined || expiry <= now().getTime()) {
        if (expiry !== undefined) invitations.delete(hash);
        return false;
      }
      invitations.delete(hash);
      return true;
    },
  };
}
