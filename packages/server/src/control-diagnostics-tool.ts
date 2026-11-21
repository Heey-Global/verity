import { z } from 'zod';
import {
  resolveRuntimeWindow,
  runtimeWindowSchema,
  runtimeDiagnosticSnapshotSchema,
  type RuntimeWindow,
} from './runtime-diagnostics.js';
import { importDiagnosticSchema } from './integrations/routes.js';
import { GITHUB_CALLER_CATEGORIES } from './github-rate-budget.js';
import type { createControlPlaneSessionTools } from './session-handoff-tool.js';

type ControlPlaneSessionCall = Parameters<
  ReturnType<typeof createControlPlaneSessionTools>['progress']
>[0];

export const diagnosticsRequestSchema = z
  .object({
    sessionId: z.string().min(1).max(128).optional(),
    projectId: z.string().min(1).max(128).optional(),
    runtime: runtimeWindowSchema.optional(),
    matrixEvent: z
      .object({
        accountId: z.string().min(1).max(255),
        sourceId: z.string().min(1).max(255),
        eventId: z.string().min(1).max(255),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine(
    (value) => value.matrixEvent === undefined || value.projectId !== undefined,
    'matrixEvent requires projectId',
  );

export const DIAGNOSTICS_TOOL_DESCRIPTION =
  'Read a bounded Control-only diagnostic snapshot of server version, runtime readiness and Uplink state, plus managed builder migration status, local resources, scoped container lifecycle, memory/health, recent Docker events, classified infrastructure errors and exported historical host kernel/runtime evidence. Optional runtime {since,until} uses ISO timestamps with offsets, defaults to the last hour and accepts at most 24 hours. Source availability, coverage, stale timestamps and truncation are explicit; never infer OOM from exit code 137 or current RAM alone. Select projectId for safe Matrix import failure codes, event IDs and retry state, with optional matrixEvent {accountId,sourceId,eventId} for a content-free persisted event receipt; optionally select one project session by sessionId for structured technical failures. Process failures may include a bounded credential-redacted stderr tail. Returns no secrets, environment values or chat message contents. Unknown data is explicit; status codes alone do not prove a cause. Use on demand, never poll. Changes belong in a project-session handoff; verify the affected state after remediation.';

export const controlDiagnosticRecordSchema = z.object({
  seq: z.number().int(),
  ts: z.number().finite(),
  source: z.enum(['agent', 'tool', 'mcp']),
  outcome: z.enum(['completed', 'failed', 'cancelled']),
  phase: z.enum(['spawn', 'initialize', 'session_load', 'session_new', 'prompt', 'tool_call']),
  code: z.number().int().optional(),
  backend: z.string().max(40).optional(),
  model: z.string().max(200).optional(),
  exitCode: z.number().int().nullable().optional(),
  signal: z.string().max(40).nullable().optional(),
  turnActive: z.boolean().optional(),
  stderrTail: z.string().max(65_536).optional(),
});
const progressSchema = z.object({
  sessionId: z.string(),
  projectId: z.string(),
  lifecycle: z.enum(['running', 'waiting', 'queued', 'failed', 'completed']),
  lastActivityAt: z.number().finite().nullable(),
  projectionTruncated: z.boolean(),
  diagnostics: z.array(controlDiagnosticRecordSchema).max(20),
});
const uplinkSchema = z.object({
  control: z.enum(['idle', 'connected', 'connecting', 'reconnecting', 'rejected', 'disabled']),
  entitlement: z.enum(['unchecked', 'checked']).optional(),
  idleReason: z.enum(['no-demand', 'not-granted']).optional(),
  sharing: z.enum(['ready', 'unavailable']),
  remoteControl: z.enum(['ready', 'unavailable']),
  reason: z.enum(['unknown_key', 'revoked', 'expired']).optional(),
  lastCloseCode: z.number().int().optional(),
  features: z
    .object({
      sharing: z.object({ granted: z.boolean(), enabled: z.boolean(), effective: z.boolean() }),
      remoteAccess: z.object({
        granted: z.boolean(),
        enabled: z.boolean(),
        effective: z.boolean(),
      }),
    })
    .optional(),
});

const githubCountsSchema = z.object({
  requests: z.number().int().nonnegative(),
  notModified: z.number().int().nonnegative(),
  limited: z.number().int().nonnegative(),
  suppressed: z.number().int().nonnegative(),
});
const githubLimitKind = z.enum(['primary', 'secondary']);
/** Only counters, quota headers and coarse targets; never URLs, queries or tokens. */
const githubDiagnosticSchema = z.object({
  observedAt: z.string(),
  windowMinutes: z.number().int().positive(),
  categories: z.object(
    Object.fromEntries(
      GITHUB_CALLER_CATEGORIES.map((name) => [name, githubCountsSchema]),
    ) as Record<(typeof GITHUB_CALLER_CATEGORIES)[number], typeof githubCountsSchema>,
  ),
  quotas: z
    .array(
      z.object({
        account: z.string().max(100),
        resource: z.string().max(40),
        limit: z.number().nullable(),
        remaining: z.number().nullable(),
        used: z.number().nullable(),
        resetAt: z.string().nullable(),
        observedAt: z.string(),
        lockedUntil: z.string().nullable(),
        lockKind: githubLimitKind.nullable(),
      }),
    )
    .max(256),
  events: z
    .array(
      z.object({
        at: z.string(),
        category: z.enum(GITHUB_CALLER_CATEGORIES),
        kind: githubLimitKind,
        status: z.number().int(),
        account: z.string().max(100),
        repo: z.string().max(100).optional(),
        endpoint: z.string().max(40),
        resource: z.string().max(40),
        retryAt: z.string(),
      }),
    )
    .max(20),
});

/** Server-wide evidence sources the Control diagnostics snapshot reads. */
export function diagnosticSources(deps: {
  secretJobRuntimeReadiness?: (() => Promise<void>) | undefined;
  uplinkDiagnostics?: (() => unknown) | undefined;
  githubDiagnostics?: (() => unknown) | undefined;
}) {
  return {
    runtimeReadiness: deps.secretJobRuntimeReadiness,
    uplinkDiagnostics: deps.uplinkDiagnostics,
    githubDiagnostics: deps.githubDiagnostics,
  };
}

export function createControlDiagnosticsTool(deps: {
  authorizeCaller: (input: ControlPlaneSessionCall) => Promise<void>;
  readProgress: (input: ControlPlaneSessionCall) => Promise<Record<string, unknown>>;
  readMatrixDiagnostics?:
    | ((
        projectId: string,
        event?: { accountId: string; sourceId: string; eventId: string },
      ) => Promise<unknown>)
    | undefined;
  readRuntimeDiagnostics?:
    | ((projectId: string | undefined, window: RuntimeWindow | undefined) => Promise<unknown>)
    | undefined;
  authorizeDiagnosticProject?: ((projectId: string) => Promise<void>) | undefined;
  version: string;
  pushEnabled: boolean;
  publicPreviewsEnabled: () => boolean;
  runtimeReadiness?: (() => Promise<void>) | undefined;
  uplinkDiagnostics?: (() => unknown) | undefined;
  githubDiagnostics?: (() => unknown) | undefined;
}) {
  return async (input: ControlPlaneSessionCall) => {
    await deps.authorizeCaller(input);
    const request = diagnosticsRequestSchema.parse(input.request);
    resolveRuntimeWindow(request.runtime);
    let runtime: 'ready' | 'not_ready' | 'unknown' = 'unknown';
    if (deps.runtimeReadiness !== undefined) {
      try {
        await deps.runtimeReadiness();
        runtime = 'ready';
      } catch {
        runtime = 'not_ready';
      }
    }
    let uplink: z.infer<typeof uplinkSchema> | { state: 'unknown' } = { state: 'unknown' };
    try {
      const parsed = uplinkSchema.safeParse(deps.uplinkDiagnostics?.());
      if (parsed.success) uplink = parsed.data;
    } catch {
      // A diagnostic source failure must not expose its exception or hide other evidence.
    }
    let github: z.infer<typeof githubDiagnosticSchema> | { state: 'unavailable' | 'failed' } = {
      state: 'unavailable',
    };
    if (deps.githubDiagnostics !== undefined) {
      try {
        const snapshot = deps.githubDiagnostics();
        if (snapshot !== undefined) {
          const parsed = githubDiagnosticSchema.safeParse(snapshot);
          github = parsed.success ? parsed.data : { state: 'failed' };
        }
      } catch {
        github = { state: 'failed' };
      }
    }
    let publicPreviews: boolean | null = null;
    try {
      publicPreviews = deps.publicPreviewsEnabled();
    } catch {
      // Null distinguishes unavailable evidence from a disabled capability.
    }
    const session =
      request.sessionId === undefined
        ? null
        : progressSchema.parse(
            await deps.readProgress({ ...input, request: { sessionId: request.sessionId } }),
          );
    const matrix =
      request.projectId === undefined || deps.readMatrixDiagnostics === undefined
        ? null
        : z
            .object({
              projectId: z.string(),
              sources: z
                .array(
                  z.object({
                    accountId: z.string(),
                    sourceId: z.string(),
                    status: z.enum(['pending', 'active', 'paused']),
                    lastIngestedAt: z.string().nullable(),
                    importDiagnostics: z.array(importDiagnosticSchema.strip()).max(20),
                    importDiagnosticsTruncated: z.boolean().default(false),
                    importDiagnosticsReportedAt: z.string().nullable().default(null),
                  }),
                )
                .max(20),
              truncated: z.boolean(),
              event: z
                .object({
                  stored: z.boolean(),
                  kind: z.enum(['message', 'edit', 'redaction']).optional(),
                  targetEventId: z.string().nullable().optional(),
                  occurredAt: z.string().optional(),
                })
                .nullable()
                .default(null),
            })
            .parse(await deps.readMatrixDiagnostics(request.projectId, request.matrixEvent));
    const runtimeProjectId = request.projectId ?? session?.projectId;
    if (runtimeProjectId !== undefined && deps.readRuntimeDiagnostics !== undefined) {
      if (deps.authorizeDiagnosticProject === undefined)
        throw new Error('Project diagnostic authorization unavailable');
      await deps.authorizeDiagnosticProject(runtimeProjectId);
    }
    let infrastructure:
      z.infer<typeof runtimeDiagnosticSnapshotSchema> | { state: 'unavailable' | 'failed' } = {
      state: 'unavailable',
    };
    if (deps.readRuntimeDiagnostics !== undefined) {
      try {
        infrastructure = runtimeDiagnosticSnapshotSchema.parse(
          await deps.readRuntimeDiagnostics(runtimeProjectId, request.runtime),
        );
      } catch {
        infrastructure = { state: 'failed' };
      }
    }
    if (runtimeProjectId !== undefined && deps.readRuntimeDiagnostics !== undefined)
      await deps.authorizeDiagnosticProject!(runtimeProjectId);
    await deps.authorizeCaller(input);
    return {
      schemaVersion: 1,
      observedAt: new Date().toISOString(),
      server: { version: deps.version },
      capabilities: { pushEnabled: deps.pushEnabled, publicPreviewsEnabled: publicPreviews },
      secretJobRuntime: { state: runtime },
      uplink,
      github,
      session,
      matrix,
      infrastructure,
      limitations: [
        'Capability flags do not prove delivery or dependency health.',
        'Session diagnostics cover at most the latest 2000 events and 20 technical records.',
        'Stored records alone do not prove Knowledge projection; missing retries alone do not prove successful import. Snapshot timestamps identify stale evidence.',
        'Matrix diagnostics contain at most 20 sources and the connector reports at most 20 active failed imports; additional failures may be omitted.',
        'Free-form errors, message contents, backend labels and environment values are omitted.',
        'Job inventory, queue depth and GitOps comparison are unavailable. Runtime timestamps support correlation but do not establish causality.',
        'GitHub usage covers server-side REST requests since the last restart, at most the latest 60 minutes and 20 limit events; quota values are the last headers GitHub returned.',
        'No root cause is inferred from state or status codes; corroborate with other evidence.',
      ],
    };
  };
}
