import { generateKeyPairSync, verify } from 'node:crypto';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { satisfies } from 'semver';

const require = createRequire(import.meta.url);
let xcodeManifest: string | undefined;
try {
  xcodeManifest = require.resolve('@bacons/xcode');
} catch (error) {
  if (process.env.VERITY_REQUIRE_MOBILE_NATIVE === '1') throw error;
}

describe.skipIf(!xcodeManifest)('mobile dependency security compatibility', () => {
  it('resolves the patched legacy parser selected for the Xcode plist consumer', () => {
    const xcodeRequire = createRequire(xcodeManifest!);
    const plistRequire = createRequire(xcodeRequire.resolve('@expo/plist'));
    const parser = plistRequire('@xmldom/xmldom/package.json') as { version: string };
    const manifest = require('../package.json') as {
      overrides: Record<string, Record<string, Record<string, string>>>;
    };
    // Removing the override can silently restore the plist consumer's vulnerable 0.7 range.
    expect(parser.version).toBe(
      manifest.overrides['@bacons/xcode']['@expo/plist']['@xmldom/xmldom'],
    );
    expect(satisfies(parser.version, '>=0.8.15 <0.9.0')).toBe(true);
  });

  it('round-trips escaped plist values through the overridden XML parser', () => {
    const xcodeRequire = createRequire(xcodeManifest!);
    const { default: plist } = xcodeRequire('@expo/plist') as {
      default: { build(value: unknown): string; parse(xml: string): unknown };
    };
    const value = { name: 'A & B <example>', enabled: true, items: [1, 'two'] };
    expect(plist.parse(plist.build(value))).toEqual(value);
  });

  it('retains CommonJS UUID generation and rejects truncated output buffers', () => {
    const uuid = createRequire(xcodeManifest!)('uuid') as typeof import('uuid');
    expect(uuid.validate(uuid.v4())).toBe(true);
    expect(() => uuid.v5('fixture', uuid.v5.DNS, new Uint8Array(8))).toThrow(RangeError);
  });

  it('signs and verifies using the Expo certificate helper', () => {
    const expoRequire = createRequire(require.resolve('@expo/code-signing-certificates'));
    const certificates = expoRequire('@expo/code-signing-certificates') as {
      convertKeyPairPEMToKeyPair(keys: { privateKeyPEM: string; publicKeyPEM: string }): unknown;
      generateSelfSignedCodeSigningCertificate(parameters: {
        keyPair: unknown;
        validityNotBefore: Date;
        validityNotAfter: Date;
        commonName: string;
      }): unknown;
      validateSelfSignedCertificate(certificate: unknown, keyPair: unknown): void;
      signBufferRSASHA256AndVerify(key: unknown, certificate: unknown, payload: Buffer): string;
    };
    const { privateKey, publicKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    const keyPair = certificates.convertKeyPairPEMToKeyPair({
      privateKeyPEM: privateKey,
      publicKeyPEM: publicKey,
    }) as { privateKey: unknown };
    const certificate = certificates.generateSelfSignedCodeSigningCertificate({
      keyPair,
      validityNotBefore: new Date('2020-01-01'),
      validityNotAfter: new Date('2040-01-01'),
      commonName: 'Dependency compatibility fixture',
    });
    certificates.validateSelfSignedCertificate(certificate, keyPair);
    const payload = Buffer.from('dependency compatibility');
    const signature = certificates.signBufferRSASHA256AndVerify(
      keyPair.privateKey,
      certificate,
      payload,
    );
    expect(verify('sha256', payload, publicKey, Buffer.from(signature, 'base64'))).toBe(true);
  });
});
