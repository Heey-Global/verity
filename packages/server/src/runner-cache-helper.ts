import { z } from 'zod';

const bytes = z.number().safe().nonnegative();
export const cacheMaintenanceResponse = z.object({
  ok: z.literal(true),
  maintenancePending: z.boolean().optional(),
  report: z.object({
    observedAt: z.iso.datetime({ offset: true }),
    sharedBytes: bytes.nullable(),
    legacyBytes: bytes.nullable(),
    removedBytes: bytes,
    legacyCachesRemoved: bytes,
    sharedCachePruned: z.boolean(),
    usageComplete: z.boolean(),
    blockers: z.array(z.string().max(500)).max(100),
    turnOwnershipCounts: z
      .object({
        missingState: bytes.max(1_000_000),
        invalidState: bytes.max(1_000_000),
        unsettledWithoutSession: bytes.max(1_000_000),
      })
      .optional(),
  }),
});

export const cacheHelperDiagnostic = z.enum([
  'broker-import-failed',
  'broker-unsupported',
  'invalid-request',
  'runtime-busy',
  'maintenance-failed',
  'invalid-response',
  'resource-unavailable',
  'helper-timeout',
  'unknown',
]);

// Importing is also the capability check for older images. Calling the export
// directly avoids keeping two Node runtimes alive inside the helper's limit.
export const cacheHelperCommand = String.raw`
const fail = (code, exit = 1) => {
  process.stdout.write(JSON.stringify({ok: false, code}));
  process.exitCode = exit;
};
(async () => {
  let broker;
  try { broker = await import('/usr/local/bin/verity-agent-spawn-broker'); }
  catch { fail('broker-import-failed', 78); return; }
  if (typeof broker.reclaimPackageCachesOffline !== 'function') {
    fail('broker-unsupported', 78); return;
  }
  let request;
  try {
    const input = process.env.VERITY_CACHE_MAINTENANCE_REQUEST;
    if (!input || Buffer.byteLength(input) > 96 * 1024) throw new Error();
    request = JSON.parse(input);
    if (!request || !Array.isArray(request.sessionIds) || request.sessionIds.length > 512 ||
        new Set(request.sessionIds).size !== request.sessionIds.length ||
        request.sessionIds.some(id => typeof id !== 'string' || !id || id.length > 256 || /[\x00-\x1f\x7f]/u.test(id)) ||
        !Number.isSafeInteger(request.maxBytes) || request.maxBytes <= 0) throw new Error();
  } catch { fail('invalid-request'); return; }
  let report;
  try {
    report = await broker.reclaimPackageCachesOffline(request, {
      runtimeDir: process.env.VERITY_RUNNER_RUNTIME,
      agentUid: Number(process.env.VERITY_AGENT_UID ?? 1000),
      agentGid: Number(process.env.VERITY_AGENT_GID ?? 1000),
      runnerUid: Number(process.env.VERITY_RUNNER_RUNTIME_UID ?? 1101),
      runnerGid: Number(process.env.VERITY_RUNNER_RUNTIME_GID ?? 1101),
    });
  } catch (error) {
    fail(error?.code === 'ENOMEM' || error?.code === 'EAGAIN' ? 'resource-unavailable' :
      error?.message === 'runner runtime is in use' ? 'runtime-busy' : 'maintenance-failed');
    return;
  }
  const output = JSON.stringify({ok: true, report});
  if (Buffer.byteLength(output) > 64 * 1024) { fail('invalid-response'); return; }
  process.stdout.write(output);
})().catch(() => fail('maintenance-failed'));
`;

/** Classify bounded evidence; never forward arbitrary helper output. */
export function cacheHelperFailureReason(output: string, exitCode: number) {
  if (exitCode === 124) return 'helper-timeout' as const;
  if (Buffer.byteLength(output) > 64 * 1024) return 'unknown' as const;
  try {
    const result = z
      .object({ ok: z.literal(false), code: cacheHelperDiagnostic })
      .parse(JSON.parse(output));
    return result.code;
  } catch {
    // tini can fail before Node starts, leaving no structured response.
    if (/^\[FATAL tini \(\d+\)\] exec timeout failed: Cannot allocate memory\s*$/u.test(output))
      return 'resource-unavailable' as const;
    return 'unknown' as const;
  }
}
