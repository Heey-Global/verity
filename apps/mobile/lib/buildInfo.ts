import { BUILD_COMMIT, RELEASE_VERSION } from './buildInfo.generated';

/**
 * The git commit stamped into this JS bundle when it was published. Unlike the EAS
 * update UUID (see updateStatus.ts), a commit is a recognizable, git-linked
 * identifier for *which commit's JavaScript* is running — the "real version" of the
 * bundle the operator asked to see.
 *
 * Only OTA bundles are stamped: the OTA workflow writes buildInfo.generated.ts
 * before `eas update`. The embedded bundle inside a native binary keeps the 'dev'
 * placeholder because its visible release is already the native marketing version.
 * So a real commit here is, in effect, proof that this exact commit arrived over
 * the air.
 */
export type BuildLabel = {
  /** True when a real commit was stamped (an OTA bundle); false for the 'dev' placeholder. */
  stamped: boolean;
  /** Short commit for the settings footer. */
  text: string;
};

/** Turn the stamped commit into a short footer label. */
export function describeBuild(commit: string = BUILD_COMMIT): BuildLabel {
  const trimmed = commit.trim();
  if (!trimmed || trimmed === 'dev') return { stamped: false, text: 'dev' };
  return { stamped: true, text: trimmed.slice(0, 7) };
}

/**
 * Return the version of the JavaScript bundle that is actually running. OTA
 * exports carry their own patch version; an embedded bundle falls back to the
 * native marketing version baked into the binary.
 */
export function runningReleaseVersion(
  nativeVersion: string | null | undefined,
  otaVersion: string | null = RELEASE_VERSION,
): string {
  const stamped = otaVersion?.trim();
  if (stamped) return stamped;
  return nativeVersion?.trim() || '0.0.0';
}
