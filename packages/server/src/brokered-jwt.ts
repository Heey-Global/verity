import { createPrivateKey, randomUUID, sign, type KeyObject } from 'node:crypto';

/**
 * Mint the short-lived assertion `verity_http_request` sends as
 * `authorization: Bearer <JWT>` when `auth.kind` is `jwt` (ADR 0011 D1).
 *
 * The point of doing this here rather than in the Sandbox is the private key: an
 * API that authenticates with a signed assertion otherwise forces the key itself
 * into the agent's process, where a trusted CLI can read it in full. Signing
 * server-side keeps the key on the server and gives the Sandbox nothing but a
 * request it never sees the credential for.
 */

export type BrokeredJwtAlgorithm = 'ES256' | 'RS256';

export class BrokeredJwtError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrokeredJwtError';
  }
}

function base64UrlJson(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

/**
 * Load the PEM and prove it matches the requested algorithm.
 *
 * A mismatch has to fail here rather than at the API: signing an EC key as RS256
 * throws something opaque, and signing with the wrong curve produces a token the
 * upstream rejects as a generic 401 — which reads to an agent like bad
 * credentials and sends it looking for a second, wrong, cause.
 */
function loadPrivateKey(pem: string, algorithm: BrokeredJwtAlgorithm): KeyObject {
  let key: KeyObject;
  try {
    key = createPrivateKey(pem);
  } catch {
    throw new BrokeredJwtError('brokered JWT secret is not a private key in PEM form');
  }
  if (algorithm === 'ES256') {
    if (key.asymmetricKeyType !== 'ec') {
      throw new BrokeredJwtError('ES256 requires an EC private key');
    }
    if (key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
      throw new BrokeredJwtError('ES256 requires the P-256 curve');
    }
    return key;
  }
  // Not `rsa-pss`. RS256 means RSASSA-PKCS1-v1_5, but Node carries an RSA-PSS
  // key's own restrictions into sign(), so such a key produces a PSS signature
  // under an `RS256` header — which a conforming API rejects as malformed rather
  // than as the wrong key, sending the agent looking for a second, wrong cause.
  if (key.asymmetricKeyType !== 'rsa') {
    throw new BrokeredJwtError('RS256 requires an RSASSA-PKCS1-v1_5 private key');
  }
  const modulusLength = key.asymmetricKeyDetails?.modulusLength ?? 0;
  if (modulusLength < 2048) {
    throw new BrokeredJwtError('RS256 requires a modulus of at least 2048 bits');
  }
  return key;
}

export function mintBrokeredJwt(input: {
  algorithm: BrokeredJwtAlgorithm;
  privateKeyPem: string;
  keyId?: string;
  issuer: string;
  audience: string;
  subject?: string;
  scope?: string;
  expiresInSeconds: number;
  /** Milliseconds since the epoch; injected so tests do not depend on the clock. */
  now?: number;
  jwtId?: string;
}): string {
  const key = loadPrivateKey(input.privateKeyPem, input.algorithm);
  const issuedAt = Math.floor((input.now ?? Date.now()) / 1000);
  const header = {
    alg: input.algorithm,
    typ: 'JWT',
    ...(input.keyId === undefined ? {} : { kid: input.keyId }),
  };
  const payload = {
    iss: input.issuer,
    aud: input.audience,
    iat: issuedAt,
    exp: issuedAt + input.expiresInSeconds,
    jti: input.jwtId ?? randomUUID(),
    ...(input.subject === undefined ? {} : { sub: input.subject }),
    ...(input.scope === undefined ? {} : { scope: input.scope }),
  };
  const signingInput = `${base64UrlJson(header)}.${base64UrlJson(payload)}`;
  // JWS wants ES256 as the raw r||s pair, not the DER sequence OpenSSL emits by
  // default. `ieee-p1363` is that encoding; without it every signature is
  // structurally wrong and every call comes back 401.
  const signature = sign(
    'sha256',
    Buffer.from(signingInput, 'utf8'),
    input.algorithm === 'ES256' ? { key, dsaEncoding: 'ieee-p1363' } : key,
  );
  return `${signingInput}.${signature.toString('base64url')}`;
}
