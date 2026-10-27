import { createHash, randomUUID } from 'node:crypto';

import {
  AUDIT_INSTALLATION_STREAM,
  UNKNOWN_INITIATOR,
  projectAuditStream,
  type AuditEventInput,
  type AuditInitiator,
  type AuditLog,
  type AuditServerIdentity,
} from './audit-log.js';

/** A build was refused because its audit intent could not be stored (ADR 0028:
 *  no new build without a committed intent). */
export class AuditUnavailableError extends Error {
  readonly code = 'audit_unavailable';
  constructor(cause: unknown) {
    super('Audit storage is unavailable, so the project image build was not started', { cause });
    this.name = 'AuditUnavailableError';
  }
}

export interface AuditHealth {
  status: 'ok' | 'degraded';
  /** Best-effort writes that failed and are not yet covered by a write-gap event. */
  pendingFailedWrites: number;
}

export interface BuildIntent {
  projectId: string;
  projectLabel: string;
  initiator: AuditInitiator;
  imageTag: string;
  forceRebuild: boolean;
  commit: string | null;
  baseImageRef: string | null;
  configFingerprint: string;
  features: string[];
}

export interface BuildAudit {
  readonly operationId: string;
  succeeded(result: {
    imageId: string | null;
    sizeBytes: number | null;
    baseImageDigest: string | null;
  }): Promise<void>;
  failed(): Promise<void>;
}

export interface AuditRecorder {
  /** Fail-closed: throws {@link AuditUnavailableError} when the intent is not stored. */
  beginBuild(intent: BuildIntent): Promise<BuildAudit>;
  imageRemoved(image: { imageRef: string; imageId?: string | null }): Promise<void>;
  projectDeleted(project: {
    projectId: string;
    projectLabel: string;
    initiator: AuditInitiator;
  }): Promise<void>;
  /** True while this process is running the operation; an unfinished operation that
   *  is not active here ended without a recorded result. */
  isActive(operationId: string): boolean;
  /** Retries outstanding write-gap events, then reports the result. */
  health(): Promise<AuditHealth>;
}

interface Gap {
  failedWrites: number;
  kinds: Record<string, number>;
  firstFailureAt: string;
  lastFailureAt: string;
}

type Draft = Omit<AuditEventInput, 'server'>;

export function createAuditRecorder(
  log: AuditLog,
  options: {
    server: () => Promise<AuditServerIdentity>;
    now?: () => Date;
    onError?: (error: unknown, kind: string) => void;
  },
): AuditRecorder {
  const now = options.now ?? (() => new Date());
  // Per-process and in memory on purpose: a failed write leaves no row anywhere else,
  // and the gap event says only what this process saw (ADR 0028).
  const gaps = new Map<string, Gap>();
  const active = new Set<string>();

  function countFailure(streamId: string, kind: string): void {
    const at = now().toISOString();
    const gap = gaps.get(streamId) ?? {
      failedWrites: 0,
      kinds: {},
      firstFailureAt: at,
      lastFailureAt: at,
    };
    gap.failedWrites += 1;
    gap.kinds[kind] = (gap.kinds[kind] ?? 0) + 1;
    gap.lastFailureAt = at;
    gaps.set(streamId, gap);
  }

  /** Put an unwritten gap back, merged with failures counted meanwhile. */
  function restoreGap(streamId: string, gap: Gap): void {
    const current = gaps.get(streamId);
    if (current === undefined) {
      gaps.set(streamId, gap);
      return;
    }
    current.failedWrites += gap.failedWrites;
    for (const [kind, count] of Object.entries(gap.kinds)) {
      current.kinds[kind] = (current.kinds[kind] ?? 0) + count;
    }
    if (gap.firstFailureAt < current.firstFailureAt) current.firstFailureAt = gap.firstFailureAt;
    if (gap.lastFailureAt > current.lastFailureAt) current.lastFailureAt = gap.lastFailureAt;
  }

  async function flushGap(streamId: string, server: AuditServerIdentity): Promise<void> {
    // Detached before the write, so concurrent callers (health checks, appends on the
    // same stream) cannot record the same failures twice.
    const gap = gaps.get(streamId);
    if (gap === undefined) return;
    gaps.delete(streamId);
    try {
      await log.append({
        kind: 'audit.write_gap',
        payload: { ...gap, kinds: { ...gap.kinds } },
        operationId: randomUUID(),
        streamId,
        projectId: streamId.startsWith('project:') ? streamId.slice('project:'.length) : null,
        initiator: UNKNOWN_INITIATOR,
        server,
      });
    } catch (error) {
      restoreGap(streamId, gap);
      throw error;
    }
  }

  function report(error: unknown, kind: string): void {
    try {
      options.onError?.(error, kind);
    } catch {
      // Reporting must not turn a best-effort write into a failure of the action.
    }
  }

  // One write at a time per stream, so a gap event is never overtaken by an event
  // this process writes concurrently on the same stream.
  const queues = new Map<string, Promise<unknown>>();
  function serial<T>(streamId: string, task: () => Promise<T>): Promise<T> {
    const previous = queues.get(streamId) ?? Promise.resolve();
    const next = previous.then(task, task);
    const settled = next.catch(() => undefined);
    queues.set(streamId, settled);
    void settled.then(() => {
      if (queues.get(streamId) === settled) queues.delete(streamId);
    });
    return next;
  }

  /** The recovering process writes its gap event before any other event of its own. */
  async function write(draft: Draft, mode: 'fail-closed' | 'best-effort'): Promise<boolean> {
    try {
      const server = await options.server();
      await serial(draft.streamId, async () => {
        await flushGap(draft.streamId, server);
        await log.append({ ...draft, server } as AuditEventInput);
      });
      return true;
    } catch (error) {
      if (mode === 'fail-closed') throw new AuditUnavailableError(error);
      countFailure(draft.streamId, draft.kind);
      report(error, draft.kind);
      return false;
    }
  }

  return {
    async beginBuild(intent) {
      const operationId = randomUUID();
      const streamId = projectAuditStream(intent.projectId);
      const base = {
        operationId,
        streamId,
        projectId: intent.projectId,
        projectLabel: intent.projectLabel,
        initiator: intent.initiator,
      };
      await write(
        {
          ...base,
          kind: 'build.requested',
          // Fitted to the allowlist here, so only unavailable storage — never an
          // unusual value — can refuse a build.
          payload: {
            imageTag: intent.imageTag.slice(0, 300),
            forceRebuild: intent.forceRebuild,
            commit:
              intent.commit !== null && /^[0-9a-f]{7,64}$/.test(intent.commit)
                ? intent.commit
                : null,
            baseImageRef: intent.baseImageRef?.slice(0, 500) ?? null,
            configFingerprint: /^[0-9a-f]{8,128}$/.test(intent.configFingerprint)
              ? intent.configFingerprint
              : createHash('sha256').update(intent.configFingerprint, 'utf8').digest('hex'),
            features: intent.features
              .filter((feature) => feature.length > 0)
              .slice(0, 20)
              .map((feature) => feature.slice(0, 500)),
          },
        },
        'fail-closed',
      );
      active.add(operationId);
      const startedAt = now().getTime();
      const durationMs = (): number => Math.max(0, now().getTime() - startedAt);
      return {
        operationId,
        async succeeded(result) {
          active.delete(operationId);
          await write(
            {
              ...base,
              imageId: result.imageId?.slice(0, 200) ?? null,
              kind: 'build.succeeded',
              payload: {
                imageId: result.imageId?.slice(0, 200) || null,
                sizeBytes:
                  result.sizeBytes !== null &&
                  Number.isSafeInteger(result.sizeBytes) &&
                  result.sizeBytes >= 0
                    ? result.sizeBytes
                    : null,
                baseImageDigest: result.baseImageDigest?.slice(0, 200) || null,
                durationMs: durationMs(),
              },
            },
            'best-effort',
          );
        },
        async failed() {
          active.delete(operationId);
          await write(
            {
              ...base,
              kind: 'build.failed',
              payload: { reason: 'build_failed', durationMs: durationMs() },
            },
            'best-effort',
          );
        },
      };
    },

    async imageRemoved(image) {
      await write(
        {
          kind: 'image.removed',
          payload: { imageRef: image.imageRef.slice(0, 500), reason: 'cleanup' },
          operationId: randomUUID(),
          streamId: AUDIT_INSTALLATION_STREAM,
          imageId: image.imageId?.slice(0, 200) ?? null,
          initiator: { kind: 'system', trigger: 'image_cleanup' },
        },
        'best-effort',
      );
    },

    async projectDeleted(project) {
      await write(
        {
          kind: 'project.deleted',
          payload: {},
          operationId: randomUUID(),
          streamId: projectAuditStream(project.projectId),
          projectId: project.projectId,
          projectLabel: project.projectLabel,
          initiator: project.initiator,
        },
        'best-effort',
      );
    },

    isActive(operationId) {
      return active.has(operationId);
    },

    async health() {
      if (gaps.size > 0) {
        try {
          const server = await options.server();
          // Each stream on its own: one failing write must not hold back the others.
          for (const streamId of [...gaps.keys()]) {
            await serial(streamId, () => flushGap(streamId, server)).catch((error: unknown) =>
              report(error, 'audit.write_gap'),
            );
          }
        } catch (error) {
          report(error, 'audit.write_gap');
        }
      }
      let pending = 0;
      for (const gap of gaps.values()) pending += gap.failedWrites;
      return { status: pending > 0 ? 'degraded' : 'ok', pendingFailedWrites: pending };
    },
  };
}
