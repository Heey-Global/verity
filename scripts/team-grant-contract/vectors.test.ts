import { createPublicKey, verify } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const vectors = JSON.parse(
  execFileSync(
    process.execPath,
    [fileURLToPath(new URL('./generate-vectors.mjs', import.meta.url))],
    {
      encoding: 'utf8',
    },
  ),
) as {
  testPublicKey: string;
  signingInput: string;
  valid: string;
  invalid: Record<string, string>;
};

const key = createPublicKey({
  key: Buffer.concat([
    Buffer.from('302a300506032b6570032100', 'hex'),
    Buffer.from(vectors.testPublicKey, 'base64url'),
  ]),
  format: 'der',
  type: 'spki',
});

function signatureValid(assertion: string): boolean {
  const segments = assertion.split('.');
  if (segments.length !== 3 || segments.some((segment) => !/^[A-Za-z0-9_-]+$/u.test(segment)))
    return false;
  const [protectedSegment, payloadSegment, signatureSegment] = segments as [string, string, string];
  const input = `${protectedSegment}.${payloadSegment}`;
  const signature = Buffer.from(signatureSegment, 'base64url');
  return signature.length === 64 && verify(null, Buffer.from(input, 'ascii'), key, signature);
}

function profileAccepts(assertion: string): boolean {
  if (!signatureValid(assertion)) return false;
  const [protectedSegment, payloadSegment] = assertion.split('.') as [string, string];
  const header = JSON.parse(Buffer.from(protectedSegment, 'base64url').toString('utf8')) as {
    kid: string;
  };
  const claims = JSON.parse(Buffer.from(payloadSegment, 'base64url').toString('utf8')) as {
    audience: string;
    installationId: string;
  };
  return (
    header.kid === 'fixture_key_1' &&
    claims.audience === 'verity-core-team' &&
    claims.installationId === 'installation_fixture'
  );
}

describe('team grant signing vectors', () => {
  it('checks the exact signed bytes with Ed25519', () => {
    expect(vectors.valid.startsWith(`${vectors.signingInput}.`)).toBe(true);
    expect(profileAccepts(vectors.valid)).toBe(true);
  });

  it('rejects a corrupted signature at the cryptographic layer', () => {
    expect(signatureValid(vectors.invalid.changedSignature)).toBe(false);
  });

  it.each(['wrongAudience', 'wrongInstallation', 'unknownKey'])(
    '%s is correctly signed but fails profile validation',
    (name) => {
      const assertion = vectors.invalid[name];
      expect(assertion).toBeDefined();
      expect(signatureValid(assertion!)).toBe(true);
      expect(profileAccepts(assertion!)).toBe(false);
    },
  );
});
