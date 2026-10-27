import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { AUDIT_DOMAINS, type AuditEvent, type AuditInitiator, type AuditLog } from './audit-log.js';
import type { AuditRecorder } from './audit-recorder.js';

/**
 * Administrator read API for the durable audit trail (ADR 0028). These routes are
 * not listed in `paired-route-policy.ts`, so only an active administrator reaches
 * them; project membership grants nothing here.
 *
 * Operations are returned, not raw events: one build is one entry, whatever number
 * of events it took to record it.
 */

export type AuditOperationKind = 'build' | 'image_removed' | 'project_deleted' | 'write_gap';
/** `unknown`: the operation never recorded a result and no longer runs here, e.g.
 *  because the Server was replaced mid-build. */
export type AuditOperationStatus = 'succeeded' | 'failed' | 'running' | 'unknown' | 'recorded';

export type AuditInitiatorView =
  | { kind: 'user'; isRequester: boolean }
  | { kind: 'session'; sessionId: string; name: string | null }
  | { kind: 'system'; trigger: string }
  | { kind: 'unknown' };

export interface AuditOperationSummary {
  operationId: string;
  kind: AuditOperationKind;
  status: AuditOperationStatus;
  startedAt: string;
  finishedAt: string | null;
  project: { id: string; label: string | null } | null;
  initiator: AuditInitiatorView;
  imageId: string | null;
  /** Set on write-gap entries: writes that failed in the window they cover. */
  failedWrites: number | null;
}

export interface AuditOperationDetail extends AuditOperationSummary {
  server: { release: string; generation: number | null };
  build: {
    imageTag: string;
    forceRebuild: boolean;
    commit: string | null;
    baseImageRef: string;
    baseImageDigest: string | null;
    features: string[];
    sizeBytes: number | null;
    durationMs: number | null;
  } | null;
  imageRef: string | null;
  gapWindow: { from: string; to: string } | null;
  events: { kind: string; recordedAt: string }[];
}

export interface AuditRouteDeps {
  log: AuditLog;
  recorder: AuditRecorder;
  sessionName: (sessionId: string) => Promise<string | null>;
}

const KIND: Record<string, AuditOperationKind> = {
  'build.requested': 'build',
  'image.removed': 'image_removed',
  'project.deleted': 'project_deleted',
  'audit.write_gap': 'write_gap',
};

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}
function num(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}

async function initiatorView(
  initiator: AuditInitiator,
  requesterUserId: string | null,
  sessionName: AuditRouteDeps['sessionName'],
): Promise<AuditInitiatorView> {
  switch (initiator.kind) {
    case 'user':
      return {
        kind: 'user',
        isRequester: initiator.userId !== null && initiator.userId === requesterUserId,
      };
    case 'session':
      return {
        kind: 'session',
        sessionId: initiator.sessionId,
        // A deleted session keeps its ID in the trail; only the name is gone.
        name: await sessionName(initiator.sessionId).catch(() => null),
      };
    case 'system':
      return { kind: 'system', trigger: initiator.trigger };
    default:
      return { kind: 'unknown' };
  }
}

export async function summarizeOperation(
  events: AuditEvent[],
  context: {
    isActive: (operationId: string) => boolean;
    requesterUserId: string | null;
    sessionName: AuditRouteDeps['sessionName'];
  },
): Promise<AuditOperationDetail | undefined> {
  const first = events[0];
  if (first === undefined) return undefined;
  const kind = KIND[first.kind];
  if (kind === undefined) return undefined;
  const terminal = events.find((e) => e.kind === 'build.succeeded' || e.kind === 'build.failed');
  const status: AuditOperationStatus =
    kind !== 'build'
      ? 'recorded'
      : terminal?.kind === 'build.succeeded'
        ? 'succeeded'
        : terminal?.kind === 'build.failed'
          ? 'failed'
          : context.isActive(first.operationId)
            ? 'running'
            : 'unknown';
  const requested = first.payload;
  const result = terminal?.payload ?? {};
  const latest = events.at(-1) ?? first;
  return {
    operationId: first.operationId,
    kind,
    status,
    startedAt: first.recordedAt,
    finishedAt: terminal?.recordedAt ?? (kind === 'build' ? null : first.recordedAt),
    project: first.projectId === null ? null : { id: first.projectId, label: first.projectLabel },
    initiator: await initiatorView(first.initiator, context.requesterUserId, context.sessionName),
    imageId: events.map((e) => e.imageId).find((id) => id !== null) ?? null,
    failedWrites: kind === 'write_gap' ? num(requested.failedWrites) : null,
    server: latest.server,
    build:
      kind === 'build'
        ? {
            imageTag: str(requested.imageTag) ?? '',
            forceRebuild: requested.forceRebuild === true,
            commit: str(requested.commit),
            baseImageRef: str(requested.baseImageRef) ?? '',
            baseImageDigest: str(result.baseImageDigest),
            features: Array.isArray(requested.features)
              ? requested.features.filter((f): f is string => typeof f === 'string')
              : [],
            sizeBytes: num(result.sizeBytes),
            durationMs: num(result.durationMs),
          }
        : null,
    imageRef: kind === 'image_removed' ? str(requested.imageRef) : null,
    gapWindow:
      kind === 'write_gap'
        ? { from: str(requested.firstFailureAt) ?? '', to: str(requested.lastFailureAt) ?? '' }
        : null,
    events: events.map((e) => ({ kind: e.kind, recordedAt: e.recordedAt })),
  };
}

function toSummary(detail: AuditOperationDetail): AuditOperationSummary {
  return {
    operationId: detail.operationId,
    kind: detail.kind,
    status: detail.status,
    startedAt: detail.startedAt,
    finishedAt: detail.finishedAt,
    project: detail.project,
    initiator: detail.initiator,
    imageId: detail.imageId,
    failedWrites: detail.failedWrites,
  };
}

const listQuerySchema = z
  .object({
    domain: z.enum(AUDIT_DOMAINS as [string, ...string[]]).optional(),
    q: z.string().trim().max(200).optional(),
    before: z.string().datetime().optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  })
  .strict();

const operationParamsSchema = z.object({ operationId: z.string().min(1).max(100) });

export function registerAuditRoutes(app: FastifyInstance, deps: AuditRouteDeps): void {
  const context = (requesterUserId: string | null) => ({
    isActive: (id: string) => deps.recorder.isActive(id),
    requesterUserId,
    sessionName: deps.sessionName,
  });

  app.get('/audit/operations', async (request, reply) => {
    const query = listQuerySchema.safeParse(request.query);
    if (!query.success) {
      reply.code(400);
      return { error: 'invalid audit query' };
    }
    void reply.header('cache-control', 'no-store');
    const { operations, nextBefore } = await deps.log.listOperations({
      domain: query.data.domain as never,
      search: query.data.q,
      before: query.data.before,
      limit: query.data.limit,
    });
    const summaries: AuditOperationSummary[] = [];
    for (const events of operations) {
      const detail = await summarizeOperation(events, context(request.localUserId));
      if (detail !== undefined) summaries.push(toSummary(detail));
    }
    return {
      operations: summaries,
      nextBefore,
      oldestRecordedAt: await deps.log.oldestRecordedAt(),
    };
  });

  app.get('/audit/operations/:operationId', async (request, reply) => {
    const params = operationParamsSchema.safeParse(request.params);
    if (!params.success) {
      reply.code(400);
      return { error: 'invalid operation id' };
    }
    void reply.header('cache-control', 'no-store');
    const detail = await summarizeOperation(
      await deps.log.operation(params.data.operationId),
      context(request.localUserId),
    );
    if (detail === undefined) {
      reply.code(404);
      return { error: 'operation not found' };
    }
    return { operation: detail };
  });

  app.get('/audit/health', async (_request, reply) => {
    void reply.header('cache-control', 'no-store');
    return deps.recorder.health();
  });
}
