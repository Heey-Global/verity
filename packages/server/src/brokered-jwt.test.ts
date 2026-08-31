import { createVerify, generateKeyPairSync, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { BrokeredJwtError, mintBrokeredJwt } from './brokered-jwt.js';

const ec = generateKeyPairSync('ec', {
  namedCurve: 'prime256v1',
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const rsa = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

function decode(jwt: string): {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
} {
  const [header, payload] = jwt.split('.');
  return {
    header: JSON.parse(Buffer.from(header!, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >,
    payload: JSON.parse(Buffer.from(payload!, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >,
  };
}

describe('brokered JWT minting', () => {
  it('signs an App Store Connect assertion the way the API reads it', () => {
    const jwt = mintBrokeredJwt({
      algorithm: 'ES256',
      privateKeyPem: ec.privateKey,
      keyId: 'ABCD1234',
      issuer: '69a6de70-issuer',
      audience: 'appstoreconnect-v1',
      expiresInSeconds: 600,
      now: 1_700_000_000_000,
      jwtId: 'fixed-jti',
    });
    const { header, payload } = decode(jwt);
    expect(header).toEqual({ alg: 'ES256', typ: 'JWT', kid: 'ABCD1234' });
    expect(payload).toEqual({
      iss: '69a6de70-issuer',
      aud: 'appstoreconnect-v1',
      iat: 1_700_000_000,
      exp: 1_700_000_600,
      jti: 'fixed-jti',
    });
    // JWS wants the raw r||s pair; the DER sequence OpenSSL emits by default is
    // longer and every verifier rejects it, which upstream reports as a plain 401.
    const [encodedHeader, encodedPayload, signature] = jwt.split('.');
    expect(Buffer.from(signature!, 'base64url')).toHaveLength(64);
    expect(
      verify(
        'sha256',
        Buffer.from(`${encodedHeader!}.${encodedPayload!}`, 'utf8'),
        { key: ec.publicKey, dsaEncoding: 'ieee-p1363' },
        Buffer.from(signature!, 'base64url'),
      ),
    ).toBe(true);
  });

  it('signs an RS256 assertion and omits absent claims rather than sending them empty', () => {
    const jwt = mintBrokeredJwt({
      algorithm: 'RS256',
      privateKeyPem: rsa.privateKey,
      issuer: 'verity@example.iam.gserviceaccount.com',
      audience: 'https://oauth2.googleapis.com/token',
      scope: 'https://www.googleapis.com/auth/cloud-platform',
      expiresInSeconds: 3_600,
      now: 1_700_000_000_000,
      jwtId: 'fixed-jti',
    });
    const { header, payload } = decode(jwt);
    expect(header).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(payload).not.toHaveProperty('kid');
    expect(payload).not.toHaveProperty('sub');
    expect(payload['scope']).toBe('https://www.googleapis.com/auth/cloud-platform');
    const [encodedHeader, encodedPayload, signature] = jwt.split('.');
    const verifier = createVerify('sha256');
    verifier.update(`${encodedHeader!}.${encodedPayload!}`);
    expect(verifier.verify(rsa.publicKey, Buffer.from(signature!, 'base64url'))).toBe(true);
  });

  it('gives each assertion its own jti', () => {
    const mint = () =>
      mintBrokeredJwt({
        algorithm: 'ES256',
        privateKeyPem: ec.privateKey,
        issuer: 'issuer',
        audience: 'appstoreconnect-v1',
        expiresInSeconds: 600,
      });
    expect(decode(mint()).payload['jti']).not.toBe(decode(mint()).payload['jti']);
  });

  // A key/algorithm mismatch has to be named here. Signing an EC key as RS256
  // throws something opaque, and the wrong curve produces a token upstream
  // rejects as a generic 401 — which reads to an agent like a bad credential and
  // sends it looking for a second, wrong, cause.
  it('names a key that cannot produce the requested algorithm', () => {
    expect(() =>
      mintBrokeredJwt({
        algorithm: 'ES256',
        privateKeyPem: rsa.privateKey,
        issuer: 'issuer',
        audience: 'appstoreconnect-v1',
        expiresInSeconds: 600,
      }),
    ).toThrow(BrokeredJwtError);
    expect(() =>
      mintBrokeredJwt({
        algorithm: 'RS256',
        privateKeyPem: ec.privateKey,
        issuer: 'issuer',
        audience: 'aud',
        expiresInSeconds: 600,
      }),
    ).toThrow(/RSASSA-PKCS1-v1_5/u);
    // An RSA-PSS key is still "an RSA key", and Node signs with it happily — but
    // it carries its own padding restrictions into sign(), so the result is a PSS
    // signature wearing an `RS256` header. A conforming API rejects that as
    // malformed, which reads to an agent as a bad credential rather than as the
    // wrong key type. Refuse it where the cause is still nameable.
    const pss = generateKeyPairSync('rsa-pss', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    expect(() =>
      mintBrokeredJwt({
        algorithm: 'RS256',
        privateKeyPem: pss.privateKey,
        issuer: 'issuer',
        audience: 'aud',
        expiresInSeconds: 600,
      }),
    ).toThrow(/RSASSA-PKCS1-v1_5/u);
    const p384 = generateKeyPairSync('ec', {
      namedCurve: 'secp384r1',
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    expect(() =>
      mintBrokeredJwt({
        algorithm: 'ES256',
        privateKeyPem: p384.privateKey,
        issuer: 'issuer',
        audience: 'appstoreconnect-v1',
        expiresInSeconds: 600,
      }),
    ).toThrow(/P-256 curve/u);
    const weakRsa = generateKeyPairSync('rsa', {
      modulusLength: 1024,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    expect(() =>
      mintBrokeredJwt({
        algorithm: 'RS256',
        privateKeyPem: weakRsa.privateKey,
        issuer: 'issuer',
        audience: 'aud',
        expiresInSeconds: 600,
      }),
    ).toThrow(/2048 bits/u);
    // The likeliest operator mistake: the alias holds the API key rather than
    // the signing key. Say that, instead of throwing an OpenSSL error.
    expect(() =>
      mintBrokeredJwt({
        algorithm: 'ES256',
        privateKeyPem: 'not-a-pem',
        issuer: 'issuer',
        audience: 'appstoreconnect-v1',
        expiresInSeconds: 600,
      }),
    ).toThrow(/not a private key in PEM form/u);
  });
});
