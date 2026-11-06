import type { RunnerCacheReclamationReport } from '@verity/events';
import { z } from 'zod';

const DEFAULT_MAX_BYTES = 4 * 1024 ** 3;
const MAX_RUNTIMES = 1000;
const MAX_SESSIONS = 512;
const PASS_BUDGET_MS = 60_000;
const bytes = z.number().safe().nonnegative();
const responseSchema = z.object({
  ok: z.literal(true),
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

// Never copy exception messages or arbitrary peer strings into host diagnostics.
const maintenanceFailure = z.object({
  code: z.enum([
    'runtime-not-idle',
    'maintenance-helper-failed',
    'turn-ownership-unknown',
    'turn-inventory-unavailable',
    'broker-access-denied',
    'broker-unavailable',
    'broker-timeout',
    'broker-invalid-response',
    'broker-rejected',
    'unsupported',
    'supervisor-rejected',
    'invalid-response',
  ]),
  counts: z
    .object({
      missingState: bytes.max(1_000_000),
      invalidState: bytes.max(1_000_000),
      unsettledWithoutSession: bytes.max(1_000_000),
    })
    .optional(),
});
function failureReason(error: unknown): string {
  const record = typeof error === 'object' && error !== null ? error : {};
  const parsed = maintenanceFailure.safeParse(
    'runnerCacheFailure' in record ? record.runnerCacheFailure : undefined,
  );
  if (parsed.success) {
    const { code, counts } = parsed.data;
    return `[${code}]${counts === undefined ? '' : ` missingState=${counts.missingState}, invalidState=${counts.invalidState}, unsettledWithoutSession=${counts.unsettledWithoutSession}`}`;
  }
  const code = 'code' in record ? record.code : undefined;
  if (code === 'EACCES' || code === 'EPERM') return '[supervisor-access-denied]';
  if (code === 'ENOENT' || code === 'ECONNREFUSED') return '[supervisor-unavailable]';
  if (code === 'ETIMEDOUT') return '[supervisor-timeout]';
  if (error instanceof z.ZodError) return '[invalid-response]';
  return '[unclassified-failure]';
}
const safeBlockers = new Set([
  'Runner cache maintenance inventory is incomplete',
  'Runner turn ownership is unknown; legacy package caches were retained',
  'Shared cache is busy',
  'session home ownership is unknown',
  'session home is in use',
  'package cache is in use',
  'package cache inventory limit',
  'invalid package cache root',
  'invalid package cache',
  'invalid package cache lease',
  'unsafe package cache entry',
  'unsafe package cache root',
  'unsafe session homes root',
  'unsafe session home',
  'invalid package cache owner result',
  'Retained non-cacache npm cache entries have unknown allocation',
  'Runner sessions have unsettled turns; their legacy package caches were retained',
]);
function safeBlocker(blocker: string): string {
  return safeBlockers.has(blocker) ? blocker : '[unclassified-cache-blocker] Details withheld';
}

/** An unset environment value leaves the embedded default in force. */
export function runnerCacheTargetFromEnv(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  if (!/^[0-9]+$/u.test(value.trim()))
    throw new Error('VERITY_RUNNER_NPM_CACHE_MAX_BYTES must be a positive safe integer');
  const target = Number(value.trim());
  if (!Number.isSafeInteger(target) || target <= 0)
    throw new Error('VERITY_RUNNER_NPM_CACHE_MAX_BYTES must be a positive safe integer');
  return target;
}

interface RunnerRuntime {
  projectId: string;
  /** Only sessions whose ownership is known; the broker independently checks its live leases. */
  sessionIds: string[];
}

/** Maintenance stays inside the broker: Server paths alone cannot establish idle ownership. */
export class RunnerCacheStorage {
  private flight: Promise<void> | undefined;
  private report: RunnerCacheReclamationReport | undefined;
  private readonly maxBytes: number;
  private nextProject: string | undefined;

  constructor(
    private readonly deps: {
      listRuntimes: () => Promise<RunnerRuntime[]>;
      request: (projectId: string, sessionIds: string[], maxBytes: number) => Promise<unknown>;
      maxBytes?: number | undefined;
    },
  ) {
    this.maxBytes = deps.maxBytes ?? DEFAULT_MAX_BYTES;
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes <= 0)
      throw new Error('Runner cache target must be a positive safe integer');
  }

  get lastReport(): RunnerCacheReclamationReport | undefined {
    return this.report;
  }

  runOnce(): Promise<void> {
    if (this.flight) return this.flight;
    this.flight = this.collect().finally(() => {
      this.flight = undefined;
    });
    return this.flight;
  }

  private async collect(): Promise<void> {
    const deadline = Date.now() + PASS_BUDGET_MS;
    const report: RunnerCacheReclamationReport = {
      observedAt: new Date().toISOString(),
      sharedBytes: 0,
      legacyBytes: 0,
      removedBytes: 0,
      legacyCachesRemoved: 0,
      sharedCachesPruned: 0,
      usageComplete: true,
      blockers: [],
    };
    const incomplete = (reason: string) => {
      report.usageComplete = false;
      report.sharedBytes = null;
      report.legacyBytes = null;
      if (report.blockers.length < 100) report.blockers.push(reason);
    };
    try {
      const runtimes = await this.deps.listRuntimes();
      if (runtimes.length > MAX_RUNTIMES) {
        incomplete(
          'Runner cache inventory exceeds the per-pass runtime limit; remaining caches retained.',
        );
      }
      {
        const seen = new Set<string>();
        const ordered = [...runtimes].sort((a, b) => a.projectId.localeCompare(b.projectId));
        const start =
          this.nextProject === undefined
            ? 0
            : Math.max(
                0,
                ordered.findIndex((r) => r.projectId === this.nextProject),
              );
        const rotated = [...ordered.slice(start), ...ordered.slice(0, start)];
        for (const runtime of rotated.slice(0, MAX_RUNTIMES)) {
          // An in-flight broker request has its own bound; do not start another after this budget.
          if (Date.now() >= deadline) {
            this.nextProject = runtime.projectId;
            incomplete('Runner cache collection deadline reached; remaining caches retained.');
            break;
          }
          if (
            !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(runtime.projectId) ||
            seen.has(runtime.projectId)
          ) {
            incomplete('Runner cache inventory has ambiguous project ownership; caches retained.');
            continue;
          }
          seen.add(runtime.projectId);
          this.nextProject = rotated[(rotated.indexOf(runtime) + 1) % rotated.length]?.projectId;
          const sessionIds = [...new Set(runtime.sessionIds)];
          if (sessionIds.length > MAX_SESSIONS) {
            incomplete(
              `Project ${runtime.projectId}: runner cache session limit exceeded; caches retained.`,
            );
            continue;
          }
          try {
            const { report: project } = responseSchema.parse(
              await this.deps.request(runtime.projectId, sessionIds, this.maxBytes),
            );
            const sharedBytes =
              report.sharedBytes === null || project.sharedBytes === null
                ? null
                : report.sharedBytes + project.sharedBytes;
            const legacyBytes =
              report.legacyBytes === null || project.legacyBytes === null
                ? null
                : report.legacyBytes + project.legacyBytes;
            const removedBytes = report.removedBytes + project.removedBytes;
            const legacyCachesRemoved = report.legacyCachesRemoved + project.legacyCachesRemoved;
            if (
              ![sharedBytes, legacyBytes, removedBytes, legacyCachesRemoved].every(
                (value) => value === null || Number.isSafeInteger(value),
              )
            ) {
              // Never publish rounded totals as measured bytes.
              throw new Error('Runner cache accounting exceeds safe integer range');
            }
            report.sharedBytes = sharedBytes;
            report.legacyBytes = legacyBytes;
            report.removedBytes = removedBytes;
            report.legacyCachesRemoved = legacyCachesRemoved;
            report.sharedCachesPruned += Number(project.sharedCachePruned);
            report.usageComplete &&=
              project.usageComplete && project.sharedBytes !== null && project.legacyBytes !== null;
            if (project.turnOwnershipCounts && report.blockers.length < 100) {
              const counts = project.turnOwnershipCounts;
              report.blockers.push(
                `Project ${runtime.projectId}: [turn-ownership-unknown] missingState=${counts.missingState}, invalidState=${counts.invalidState}, unsettledWithoutSession=${counts.unsettledWithoutSession}`,
              );
            }
            for (const blocker of project.blockers) {
              if (report.blockers.length < 100)
                report.blockers.push(
                  `Project ${runtime.projectId}: ${safeBlocker(blocker)}`.slice(0, 500),
                );
            }
          } catch (error) {
            incomplete(
              `Project ${runtime.projectId}: ${failureReason(error)} runner cache maintenance unavailable or invalid; caches retained where unverified.`,
            );
          }
        }
      }
    } catch {
      incomplete('Runner cache inventory is unavailable; caches retained.');
    }
    this.report = report;
  }
}
