import { describe, expect, it, vi } from 'vitest';
import {
  createReleaseChannelVerifier,
  OFFICIAL_CERTIFICATE_ISSUER,
  OFFICIAL_RELEASE_WORKFLOW_IDENTITY,
  OFFICIAL_SOURCE_REF,
  OFFICIAL_SOURCE_REPOSITORY,
  OFFICIAL_SOURCE_REPOSITORY_ID,
  type SignerIdentity,
  type VerifiedSigner,
} from './release-channel-verify.js';
import type { SignedReleaseChannel } from './release-channel.js';

const REVISION = 'a'.repeat(40);

/** DER `UTF8String`, which is how Fulcio encodes the GitHub extensions. */
const der = (value: string): Uint8Array =>
  Uint8Array.from([0x0c, Buffer.byteLength(value), ...Buffer.from(value, 'utf8')]);

const oid = (id: string, value: string | Uint8Array) => ({
  oid: { id: id.split('.').map(Number) },
  value: typeof value === 'string' ? der(value) : value,
});

const identity = (overrides: Partial<SignerIdentity> = {}): SignerIdentity => ({
  subjectAlternativeName: OFFICIAL_RELEASE_WORKFLOW_IDENTITY,
  extensions: { issuer: OFFICIAL_CERTIFICATE_ISSUER },
  oids: [
    oid('1.3.6.1.4.1.57264.1.12', OFFICIAL_SOURCE_REPOSITORY),
    oid('1.3.6.1.4.1.57264.1.13', REVISION),
    oid('1.3.6.1.4.1.57264.1.14', OFFICIAL_SOURCE_REF),
    oid('1.3.6.1.4.1.57264.1.15', OFFICIAL_SOURCE_REPOSITORY_ID),
  ],
  ...overrides,
});

const channel = (bundle = { mediaType: 'application/vnd.dev.sigstore.bundle.v0.3+json' }) =>
  ({
    metadata: { revision: REVISION },
    payload: new Uint8Array(Buffer.from('{"channel":"stable"}', 'utf8')),
    signature: {
      kind: 'sigstore-bundle',
      bundle: Buffer.from(JSON.stringify(bundle), 'utf8').toString('base64'),
    },
  }) as unknown as SignedReleaseChannel;

const verifierFor = (signer: VerifiedSigner, onReject?: (reason: string) => void) =>
  createReleaseChannelVerifier({
    tufCachePath: '/tmp/unused',
    verifyBundle: vi.fn(async () => signer),
    ...(onReject === undefined ? {} : { onReject }),
  });

describe('createReleaseChannelVerifier', () => {
  it('accepts a signature from the official release workflow at the named commit', async () => {
    await expect(verifierFor({ identity: identity() })(channel())).resolves.toBe(true);
  });

  it('accepts the raw extension encoding older Fulcio certificates used', async () => {
    const raw = identity({
      oids: [
        oid('1.3.6.1.4.1.57264.1.12', Buffer.from(OFFICIAL_SOURCE_REPOSITORY, 'utf8')),
        oid('1.3.6.1.4.1.57264.1.13', Buffer.from(REVISION, 'utf8')),
        oid('1.3.6.1.4.1.57264.1.14', Buffer.from(OFFICIAL_SOURCE_REF, 'utf8')),
        oid('1.3.6.1.4.1.57264.1.15', Buffer.from(OFFICIAL_SOURCE_REPOSITORY_ID, 'utf8')),
      ],
    });
    await expect(verifierFor({ identity: raw })(channel())).resolves.toBe(true);
  });

  it('verifies the exact signed bytes rather than a re-serialization', async () => {
    const verifyBundle = vi.fn(async () => ({ identity: identity() }));
    const subject = createReleaseChannelVerifier({ tufCachePath: '/tmp/unused', verifyBundle });
    const document = channel();
    await subject(document);
    expect(verifyBundle).toHaveBeenCalledWith(
      { mediaType: 'application/vnd.dev.sigstore.bundle.v0.3+json' },
      Buffer.from(document.payload),
    );
  });

  it('rejects a signer whose identity merely starts with the official one', async () => {
    const reasons: string[] = [];
    const subject = verifierFor(
      {
        identity: identity({
          // A branch named `main-evil` in the same repository: an unanchored
          // identity match would accept this certificate.
          subjectAlternativeName: `${OFFICIAL_RELEASE_WORKFLOW_IDENTITY}-evil`,
        }),
      },
      (reason) => reasons.push(reason),
    );
    await expect(subject(channel())).resolves.toBe(false);
    expect(reasons).toEqual([expect.stringContaining('is not the official release workflow')]);
  });

  it('rejects another workflow in the same repository', async () => {
    const subject = verifierFor({
      identity: identity({
        subjectAlternativeName: `${OFFICIAL_SOURCE_REPOSITORY}/.github/workflows/ci.yml@${OFFICIAL_SOURCE_REF}`,
      }),
    });
    await expect(subject(channel())).resolves.toBe(false);
  });

  it('rejects a certificate from another OIDC issuer', async () => {
    const subject = verifierFor({
      identity: identity({ extensions: { issuer: 'https://accounts.google.com' } }),
    });
    await expect(subject(channel())).resolves.toBe(false);
  });

  it('rejects a repository that took over the name but not the id', async () => {
    const reasons: string[] = [];
    const subject = verifierFor(
      {
        identity: identity({
          oids: [
            oid('1.3.6.1.4.1.57264.1.12', OFFICIAL_SOURCE_REPOSITORY),
            oid('1.3.6.1.4.1.57264.1.13', REVISION),
            oid('1.3.6.1.4.1.57264.1.14', OFFICIAL_SOURCE_REF),
            oid('1.3.6.1.4.1.57264.1.15', '999'),
          ],
        }),
      },
      (reason) => reasons.push(reason),
    );
    await expect(subject(channel())).resolves.toBe(false);
    expect(reasons).toEqual([expect.stringContaining('1.3.6.1.4.1.57264.1.15')]);
  });

  it('rejects a signature replayed from a different commit', async () => {
    const subject = verifierFor({
      identity: identity({
        oids: [
          oid('1.3.6.1.4.1.57264.1.12', OFFICIAL_SOURCE_REPOSITORY),
          oid('1.3.6.1.4.1.57264.1.13', 'b'.repeat(40)),
          oid('1.3.6.1.4.1.57264.1.14', OFFICIAL_SOURCE_REF),
          oid('1.3.6.1.4.1.57264.1.15', OFFICIAL_SOURCE_REPOSITORY_ID),
        ],
      }),
    });
    await expect(subject(channel())).resolves.toBe(false);
  });

  it('rejects a signer with no certificate identity at all', async () => {
    await expect(verifierFor({})(channel())).resolves.toBe(false);
    await expect(verifierFor({ identity: identity({ oids: [] }) })(channel())).resolves.toBe(false);
  });

  it('fails closed instead of throwing when verification itself fails', async () => {
    const reasons: string[] = [];
    const subject = createReleaseChannelVerifier({
      tufCachePath: '/tmp/unused',
      verifyBundle: vi.fn(async () => {
        throw new Error('no trusted certificate path found');
      }),
      onReject: (reason) => reasons.push(reason),
    });
    await expect(subject(channel())).resolves.toBe(false);
    expect(reasons).toEqual(['no trusted certificate path found']);
  });

  it('fails closed on a bundle that is not JSON', async () => {
    const verifyBundle = vi.fn(async () => ({ identity: identity() }));
    const subject = createReleaseChannelVerifier({ tufCachePath: '/tmp/unused', verifyBundle });
    const broken = {
      ...channel(),
      signature: { kind: 'sigstore-bundle', bundle: Buffer.from('nope').toString('base64') },
    } as SignedReleaseChannel;
    await expect(subject(broken)).resolves.toBe(false);
    expect(verifyBundle).not.toHaveBeenCalled();
  });
});
