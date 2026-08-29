import type { SignedReleaseChannel } from './release-channel.js';

/**
 * The one build identity allowed to declare a Verity release (ADR 0008 D4).
 *
 * These are not configuration. A deployment that could be pointed at a different
 * signer would offer exactly the guarantee that is missing today, so the identity
 * is compiled in and changing it requires shipping a new Server.
 */
export const OFFICIAL_SOURCE_REPOSITORY = 'https://github.com/Heey-Global/verity';
/** Immutable numeric repository id. Survives a rename; a new repository that
 *  takes over the old name does not inherit it. */
export const OFFICIAL_SOURCE_REPOSITORY_ID = '1274346177';
export const OFFICIAL_SOURCE_REF = 'refs/heads/main';
export const OFFICIAL_RELEASE_WORKFLOW_IDENTITY = `${OFFICIAL_SOURCE_REPOSITORY}/.github/workflows/release.yml@${OFFICIAL_SOURCE_REF}`;
export const OFFICIAL_CERTIFICATE_ISSUER = 'https://token.actions.githubusercontent.com';

/** Fulcio GitHub Actions certificate extensions. */
const OID_SOURCE_REPOSITORY_URI = '1.3.6.1.4.1.57264.1.12';
const OID_SOURCE_REPOSITORY_DIGEST = '1.3.6.1.4.1.57264.1.13';
const OID_SOURCE_REPOSITORY_REF = '1.3.6.1.4.1.57264.1.14';
const OID_SOURCE_REPOSITORY_IDENTIFIER = '1.3.6.1.4.1.57264.1.15';

/** The parts of a Sigstore `Signer` this module reads, restated structurally so
 *  the verifier can be exercised without the Sigstore stack. */
export interface SignerObjectIdentifier {
  readonly oid?: { readonly id?: readonly number[] } | undefined;
  readonly value: Uint8Array;
}

export interface SignerIdentity {
  readonly subjectAlternativeName?: string | undefined;
  readonly extensions?: { readonly issuer?: string | undefined } | undefined;
  readonly oids?: readonly SignerObjectIdentifier[] | undefined;
}

export interface VerifiedSigner {
  readonly identity?: SignerIdentity | undefined;
}

/** Verify a Sigstore bundle against the exact signed bytes, returning the signer
 *  whose certificate the bundle chains to. Throws on any cryptographic failure. */
export type SigstoreBundleVerifier = (bundle: unknown, data: Buffer) => Promise<VerifiedSigner>;

export interface ReleaseChannelVerifierOptions {
  /** Where the Sigstore TUF trusted root is cached between restarts. */
  readonly tufCachePath: string;
  readonly verifyBundle?: SigstoreBundleVerifier;
  /** Called with the reason whenever a channel document is refused. */
  readonly onReject?: (reason: string) => void;
}

/**
 * Read a Fulcio extension value.
 *
 * The GitHub extensions from `1.3.6.1.4.1.57264.1.9` upwards carry a DER-encoded
 * `UTF8String` rather than the raw string the older extensions used, and the
 * certificate parser hands back the extension octets unchanged. Both spellings
 * denote the same value, so both are accepted — the string this returns is then
 * compared exactly.
 */
function decodeExtensionValue(value: Uint8Array): string {
  const bytes = Buffer.from(value);
  if (bytes.length >= 2 && bytes[0] === 0x0c) {
    const length = bytes[1]!;
    if (length < 0x80 && bytes.length === 2 + length) return bytes.subarray(2).toString('utf8');
    if (length === 0x81 && bytes.length >= 3 && bytes.length === 3 + bytes[2]!) {
      return bytes.subarray(3).toString('utf8');
    }
  }
  return bytes.toString('utf8');
}

function readExtension(
  oids: readonly SignerObjectIdentifier[] | undefined,
  oid: string,
): string | null {
  const wanted = oid.split('.').map(Number);
  const match = oids?.find((entry) => {
    const id = entry.oid?.id;
    return (
      id !== undefined && id.length === wanted.length && wanted.every((part, at) => id[at] === part)
    );
  });
  return match === undefined ? null : decodeExtensionValue(match.value);
}

/**
 * Bind the signer to the official release build, or explain why it is not.
 *
 * The identity is checked here rather than through Sigstore's own
 * `certificateIdentityURI` option because that option is matched as an
 * *unanchored regular expression*: `release.yml@refs/heads/main` would also
 * accept a certificate issued for a branch named `main-anything`. An identity
 * binding wants exact equality, so it is done exactly, once, here.
 */
function rejectSigner(signer: VerifiedSigner, revision: string): string | null {
  const identity = signer.identity;
  const subject = identity?.subjectAlternativeName;
  if (subject !== OFFICIAL_RELEASE_WORKFLOW_IDENTITY) {
    return `signer ${subject ?? '<none>'} is not the official release workflow`;
  }
  const issuer = identity?.extensions?.issuer;
  if (issuer !== OFFICIAL_CERTIFICATE_ISSUER) {
    return `certificate issuer ${issuer ?? '<none>'} is not GitHub Actions OIDC`;
  }
  const expected: readonly (readonly [string, string])[] = [
    [OID_SOURCE_REPOSITORY_URI, OFFICIAL_SOURCE_REPOSITORY],
    [OID_SOURCE_REPOSITORY_IDENTIFIER, OFFICIAL_SOURCE_REPOSITORY_ID],
    [OID_SOURCE_REPOSITORY_REF, OFFICIAL_SOURCE_REF],
    // Binds the signature to the very commit the channel document names, so a
    // valid signature over one release cannot be replayed onto another.
    [OID_SOURCE_REPOSITORY_DIGEST, revision],
  ];
  for (const [oid, want] of expected) {
    const actual = readExtension(identity?.oids, oid);
    if (actual !== want) return `certificate ${oid} is ${actual ?? '<missing>'}, expected ${want}`;
  }
  return null;
}

/**
 * The default bundle verifier: full Sigstore keyless verification against the
 * TUF trusted root, including certificate chain, signed certificate timestamps,
 * and transparency-log inclusion.
 *
 * Imported lazily so an unmanaged deployment — which never resolves a channel —
 * does not pay for the Sigstore stack at startup.
 */
function createSigstoreBundleVerifier(tufCachePath: string): SigstoreBundleVerifier {
  return async (bundle, data) => {
    const { verify } = await import('sigstore');
    // Issuer only: it is compared for equality by the library. Everything that
    // is regex-matched there is checked exactly in rejectSigner instead.
    return verify(bundle as never, data, {
      tufCachePath,
      certificateIssuer: OFFICIAL_CERTIFICATE_ISSUER,
    });
  };
}

/**
 * Build the release-channel signature check.
 *
 * Fails closed: every failure — malformed bundle, broken chain, missing log
 * entry, foreign signer — returns `false` rather than throwing, because the
 * caller's contract is "is this release eligible", and an exception escaping
 * here would be indistinguishable from a channel outage.
 */
export function createReleaseChannelVerifier(
  options: ReleaseChannelVerifierOptions,
): (channel: SignedReleaseChannel) => Promise<boolean> {
  const verifyBundle = options.verifyBundle ?? createSigstoreBundleVerifier(options.tufCachePath);
  return async (channel) => {
    try {
      const bundle: unknown = JSON.parse(
        Buffer.from(channel.signature.bundle, 'base64').toString('utf8'),
      );
      const signer = await verifyBundle(bundle, Buffer.from(channel.payload));
      const rejection = rejectSigner(signer, channel.metadata.revision);
      if (rejection !== null) {
        options.onReject?.(rejection);
        return false;
      }
      return true;
    } catch (error) {
      options.onReject?.(error instanceof Error ? error.message : String(error));
      return false;
    }
  };
}
