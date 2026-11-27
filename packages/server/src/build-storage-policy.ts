const GiB = 1024 ** 3;

export interface BuildStoragePolicy {
  /** Includes all remaining snapshot, archive, import and context growth. */
  estimateBytes: number;
  reserveBytes: number;
  reserveInodes: number;
}

export function buildStoragePolicy(
  environment: NodeJS.ProcessEnv = process.env,
): BuildStoragePolicy {
  const positive = (name: string, fallback: number, maxDigits = 6): number => {
    const value = environment[name];
    if (value === undefined) return fallback;
    if (!/^[1-9]\d*$/.test(value) || value.length > maxDigits) throw new Error(`Invalid ${name}`);
    return Number(value);
  };
  return {
    // Used only when no valid project image measurement is available.
    estimateBytes: positive('VERITY_BUILD_ESTIMATE_GIB', 24) * GiB,
    reserveBytes: positive('VERITY_BUILD_FREE_GIB', 10) * GiB,
    reserveInodes: positive('VERITY_BUILD_FREE_INODES', 1_000_000, 12),
  };
}

/**
 * Overlayfs admission heuristic: 2 GiB context allowance plus twice the previous
 * uncompressed image size. One image covers an export archive without assuming
 * compression; the other allows changed snapshots and import growth (unchanged
 * layers are shared). Bound the heuristic to 12–96 GiB. This is not a peak-space
 * guarantee: arbitrary build steps can outgrow it, so live reserve checks remain.
 */
export function estimateBuildStorageBytes(policy: BuildStoragePolicy, imageBytes?: number): number {
  if (imageBytes === undefined || !Number.isSafeInteger(imageBytes) || imageBytes <= 0)
    return policy.estimateBytes;
  return Math.ceil(Math.min(96 * GiB, Math.max(12 * GiB, 2 * GiB + 2 * imageBytes)));
}
