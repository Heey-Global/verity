import { DockerError } from './docker.js';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sanitizeDiagnostic, type BuildDiagnosticStore } from './build-diagnostics.js';
import type { AuditLog } from './audit-log.js';
import type { AuditRecorder } from './audit-recorder.js';
import type { createRuntimeDiagnostics } from './runtime-diagnostics.js';

export interface LogRouteDeps {
  log: Pick<AuditLog, 'operation'>;
  recorder: Pick<AuditRecorder, 'isActive'>;
  buildDiagnostics?: BuildDiagnosticStore | undefined;
  runtimeDiagnostics?: ReturnType<typeof createRuntimeDiagnostics> | undefined;
  serverLogs?: ((window: { since: string; until: string }) => Promise<string>) | undefined;
}

const querySchema = z
  .object({
    source: z.enum(['server', 'host']).default('server'),
    since: z.string().datetime({ offset: true }).optional(),
    until: z.string().datetime({ offset: true }).optional(),
    level: z.enum(['all', 'error', 'warning', 'info']).default('all'),
  })
  .strict();

function severity(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return value >= 50 ? 'error' : value >= 40 ? 'warning' : value >= 30 ? 'info' : null;
}

/** Administrator-only: deliberately absent from the paired route allowlist.
 * Reads authorize neither report export nor transmission to support. */
export function registerLogRoutes(app: FastifyInstance, deps: LogRouteDeps) {
  if (deps.buildDiagnostics !== undefined) {
    const sweep = setInterval(
      () => void deps.buildDiagnostics!.prune().catch(() => undefined),
      60 * 60 * 1000,
    );
    sweep.unref();
    app.addHook('onClose', (_instance, done) => {
      clearInterval(sweep);
      done();
    });
  }
  app.get('/audit/operations/:operationId/diagnostics', async (request, reply) => {
    void reply.header('cache-control', 'no-store');
    const params = z.object({ operationId: z.string().uuid() }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'invalid operation id' });
    const { operationId } = params.data;
    const events = await deps.log.operation(operationId);
    if (!events.length) return reply.code(404).send({ error: 'operation not found' });
    const provenance = {
      source: 'build' as const,
      operationId,
      supportConsent: 'required' as const,
    };
    try {
      const diagnostic = await deps.buildDiagnostics?.read(operationId);
      return {
        provenance,
        state: diagnostic
          ? 'available'
          : deps.recorder.isActive(operationId)
            ? 'pending'
            : Date.parse(events[0]!.recordedAt) < Date.now() - 7 * 86400_000
              ? 'expired'
              : 'unavailable',
        diagnostic: diagnostic ?? null,
      };
    } catch {
      return { provenance, state: 'failed', diagnostic: null };
    }
  });

  app.get('/diagnostics/logs', async (request, reply) => {
    void reply.header('cache-control', 'no-store');
    const parsed = querySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid log query' });
    const query = parsed.data;
    const until = query.until ?? new Date().toISOString();
    const since = query.since ?? new Date(Date.parse(until) - 60 * 60 * 1000).toISOString();
    if (
      Date.parse(since) >= Date.parse(until) ||
      Date.parse(until) > Date.now() + 60_000 ||
      Date.parse(until) - Date.parse(since) > 86400_000
    ) {
      return reply.code(400).send({ error: 'log window must be ordered and at most 24 hours' });
    }
    const base = {
      source: query.source,
      window: { since, until },
      supportConsent: 'required' as const,
    };
    if (query.source === 'host') {
      if (deps.runtimeDiagnostics === undefined)
        return {
          ...base,
          state: 'unavailable',
          reason: 'not_configured',
          stale: false,
          truncated: false,
          entries: [],
        };
      try {
        const result = await deps.runtimeDiagnostics({ window: { since, until } });
        const snapshot = result.host.snapshot;
        return {
          ...base,
          state: result.host.state,
          stale: result.host.stale,
          truncated: snapshot?.truncated ?? false,
          observedAt: snapshot?.observedAt ?? null,
          sourceWindow: snapshot ? { since: snapshot.since, until: snapshot.until } : null,
          sources: snapshot?.sources ?? null,
          entries: (snapshot?.records ?? [])
            .filter(
              (entry) =>
                Date.parse(entry.at) >= Date.parse(since) &&
                Date.parse(entry.at) <= Date.parse(until),
            )
            .map((entry) => ({
              at: entry.at,
              source: entry.source,
              code: entry.code,
              ...(entry.exitCode === undefined ? {} : { exitCode: entry.exitCode }),
              level: null,
              text: `${entry.source}: ${entry.code}${entry.exitCode === undefined ? '' : ` (exit ${entry.exitCode})`}`,
            })),
        };
      } catch {
        return { ...base, state: 'failed', stale: false, truncated: false, entries: [] };
      }
    }
    if (deps.serverLogs === undefined)
      return {
        ...base,
        state: 'unavailable',
        reason: 'not_configured',
        stale: false,
        truncated: false,
        entries: [],
      };
    try {
      const raw = await deps.serverLogs({ since, until });
      const safe = sanitizeDiagnostic(raw);
      const entries = safe
        .split('\n')
        .filter(Boolean)
        .slice(-1000)
        .map((line) => {
          const stamp = /^(\d{4}-\d\d-\d\dT\S+)\s/u.exec(line);
          const text = stamp ? line.slice(stamp[0].length) : line;
          let level: string | null;
          try {
            const value = JSON.parse(text) as { level?: number };
            level = severity(value?.level);
          } catch {
            // Redaction may omit the remainder of a credential-bearing JSON line.
            // Pino's leading numeric level remains usable without parsing that data.
            const prefix = /^\{\s*"level"\s*:\s*(\d+)\s*[,}]/u.exec(text);
            level = severity(prefix === null ? undefined : Number(prefix[1]));
          }
          return { at: stamp?.[1] ?? null, level, text };
        })
        .filter((entry) => query.level === 'all' || entry.level === query.level);
      return {
        ...base,
        state: 'available',
        stale: false,
        // A full tail may omit earlier output even without hitting the byte cap.
        truncated: raw.includes('[truncated') || raw.split('\n').filter(Boolean).length >= 1000,
        entries,
      };
    } catch (error) {
      const reason =
        error instanceof DockerError
          ? error.kind === 'container_not_found'
            ? 'container_not_found'
            : error.status === 401 || error.status === 403
              ? 'access_denied'
              : error.kind === 'network'
                ? 'docker_unreachable'
                : 'read_failed'
          : 'read_failed';
      return { ...base, state: 'failed', reason, stale: false, truncated: false, entries: [] };
    }
  });
}
