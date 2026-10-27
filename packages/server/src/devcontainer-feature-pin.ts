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
