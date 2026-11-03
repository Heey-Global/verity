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
  }),
});

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
        incomplete('Runner cache inventory exceeds the runtime limit; caches retained.');
      } else {
        const seen = new Set<string>();
        for (const runtime of runtimes) {
          // An in-flight broker request has its own bound; do not start another after this budget.
          if (Date.now() >= deadline) {
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
            for (const blocker of project.blockers) {
              if (report.blockers.length < 100)
                report.blockers.push(`Project ${runtime.projectId}: ${blocker}`.slice(0, 500));
            }
          } catch {
            incomplete(
              `Project ${runtime.projectId}: runner cache maintenance unavailable or invalid; caches retained where unverified.`,
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
