export interface RuntimeReadinessGateOptions {
  ttlMs?: number;
  now?: () => number;
}

export function validateRuntimeReadinessTtl(ttlMs: number | undefined): number {
  const resolved = ttlMs ?? 5_000;
  if (!Number.isFinite(resolved) || resolved < 0) {
    throw new Error('runtime readiness ttl must be >= 0');
  }
  return resolved;
}

/** Coalesce and briefly cache a probe so public health traffic cannot amplify into Docker calls. */
export function createRuntimeReadinessGate(
  probe: () => Promise<void>,
  options: RuntimeReadinessGateOptions = {},
): () => Promise<void> {
  const ttlMs = validateRuntimeReadinessTtl(options.ttlMs);
  const now = options.now ?? Date.now;
  let checkedAt = Number.NEGATIVE_INFINITY;
  let ready: boolean | undefined;
  let inFlight: Promise<void> | undefined;

  return async () => {
    if (ready !== undefined && now() - checkedAt < ttlMs) {
      if (!ready) throw new Error('runtime is not ready');
      return;
    }
    if (inFlight === undefined) {
      inFlight = probe()
        .then(
          () => {
            ready = true;
          },
          () => {
            ready = false;
            throw new Error('runtime is not ready');
          },
        )
        .finally(() => {
          checkedAt = now();
          inFlight = undefined;
        });
    }
    await inFlight;
  };
}
