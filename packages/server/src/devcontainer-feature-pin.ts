import { resolvePublicOciTagDigest } from './oci-ref.js';

export interface PinnedToolkitFeature {
  ref: string;
  version: string;
  identity: string;
}

/** Select the exact manifest before hashing build inputs or passing anything to the CLI.
 * The repository comes from trusted Server configuration, never project metadata.
 * Digest integrity is not a publisher signature; boundary attestation still checks
 * the resulting toolkit against the signed Server's bundled trust root.
 */
export async function pinToolkitFeature(
  feature: PinnedToolkitFeature | undefined,
  resolveDigest: (ref: string) => Promise<string> = (ref) =>
    resolvePublicOciTagDigest(ref, AbortSignal.timeout(30_000)),
): Promise<PinnedToolkitFeature | undefined> {
  if (feature === undefined) return undefined;
  const digestPattern = /^([^\s@]+)@sha256:[a-f0-9]{64}$/;
  if (digestPattern.test(feature.ref)) return feature;
  if (feature.ref.includes('@') || !feature.ref.includes(':')) {
    throw new Error('Toolkit Feature must name a version tag or sha256 digest');
  }
  const repository = feature.ref.slice(0, feature.ref.lastIndexOf(':'));
  const pinned = await resolveDigest(feature.ref);
  if (digestPattern.exec(pinned)?.[1] !== repository) {
    throw new Error(
      'Toolkit Feature resolution did not return a digest from the configured repository',
    );
  }
  return { ...feature, ref: pinned, identity: `${feature.identity}\n${pinned}` };
}

/** The signed Server release names the exact Feature authorized by its host
 * helper. Numeric version aliases can move after publication; do not resolve
 * those aliases again when a release-owned pin is available. Explicit operator
 * configuration remains explicit and is checked against the host's allowlist.
 */
export function releaseToolkitFeature(
  feature: PinnedToolkitFeature | undefined,
  releaseRef: string | undefined,
  configured: boolean,
): PinnedToolkitFeature | undefined {
  if (configured || feature === undefined || !releaseRef) return feature;
  const matched = /^([^\s@]+)@sha256:[a-f0-9]{64}$/u.exec(releaseRef);
  if (!matched) throw new Error('Invalid release toolkit Feature pin');
  const repository = feature.ref.split('@')[0]!.replace(/:[^/:]+$/u, '');
  if (matched[1] !== repository) throw new Error('Release toolkit Feature repository mismatch');
  return { ...feature, ref: releaseRef, identity: `${feature.identity}\n${releaseRef}` };
}
