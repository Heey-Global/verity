// Public deterministic test material. Never use this seed for production grants.
import { Buffer } from 'node:buffer';
import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import process from 'node:process';

const seed = Buffer.alloc(32, 0x42);
const privateKey = createPrivateKey({
  key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]),
  format: 'der',
  type: 'pkcs8',
});
const publicKey = createPublicKey(privateKey);
const rawPublicKey = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
const b64url = (value) => Buffer.from(value).toString('base64url');
const header = { alg: 'EdDSA', typ: 'verity-team-grant+jws', kid: 'fixture_key_1' };
const claims = {
  issuer: 'verity-uplink',
  audience: 'verity-core-team',
  installationId: 'installation_fixture',
  teamVersion: 1,
  grantId: 'grant_fixture',
  generation: 7,
  capabilities: ['team-sharing'],
  issuedAt: 1800000000,
  notBefore: 1800000000,
  expiresAt: 1800000900,
};
const protectedSegment = b64url(JSON.stringify(header));
const payloadSegment = b64url(JSON.stringify(claims));
const input = `${protectedSegment}.${payloadSegment}`;
const signature = b64url(sign(null, Buffer.from(input, 'ascii'), privateKey));
const assertion = `${input}.${signature}`;
const signSegments = (protectedPart, payloadPart) => {
  const changedInput = `${protectedPart}.${payloadPart}`;
  return `${changedInput}.${b64url(sign(null, Buffer.from(changedInput, 'ascii'), privateKey))}`;
};
const withClaims = (patch) =>
  signSegments(protectedSegment, b64url(JSON.stringify({ ...claims, ...patch })));
const withHeader = (patch) =>
  signSegments(b64url(JSON.stringify({ ...header, ...patch })), payloadSegment);
const duplicatePayload = `{"issuer":"verity-uplink",${JSON.stringify(claims).slice(1)}`;
const duplicateHeader = `{"kid":"fixture_key_1",${JSON.stringify(header).slice(1)}`;
const vectors = {
  testPublicKey: b64url(rawPublicKey),
  signingInput: input,
  valid: assertion,
  invalid: {
    changedSignature: `${input}.${signature.slice(0, -1)}${signature.endsWith('A') ? 'B' : 'A'}`,
    wrongAudience: withClaims({ audience: 'other-audience' }),
    wrongInstallation: withClaims({ installationId: 'other_installation' }),
    unknownKey: withHeader({ kid: 'unknown_key' }),
    duplicatePayloadKey: signSegments(protectedSegment, b64url(duplicatePayload)),
    duplicateHeaderKey: signSegments(b64url(duplicateHeader), payloadSegment),
    notYetValid: withClaims({ notBefore: claims.issuedAt + 120 }),
  },
};
process.stdout.write(`${JSON.stringify(vectors, null, 2)}\n`);
