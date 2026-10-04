import { z } from 'zod';
import { importDiagnosticSchema } from './integrations/routes.js';
import type { createControlPlaneSessionTools } from './session-handoff-tool.js';

type ControlPlaneSessionCall = Parameters<
  ReturnType<typeof createControlPlaneSessionTools>['progress']
>[0];

export const diagnosticsRequestSchema = z
  .object({
    sessionId: z.string().min(1).max(128).optional(),
    projectId: z.string().min(1).max(128).optional(),
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
  'Read a bounded Control-only diagnostic snapshot of server version, runtime readiness and Uplink state. Select projectId for safe Matrix import failure codes, event IDs and retry state, with optional matrixEvent {accountId,sourceId,eventId} for a content-free persisted event receipt; optionally select one project session by sessionId for structured technical failures. Returns no secrets, configuration values or messages. Unknown data is explicit; status codes alone do not prove a cause. Use on demand, never poll. Changes belong in a project-session handoff; verify the affected state after remediation.';

export const controlDiagnosticRecordSchema = z.object({
  seq: z.number().int(),
  ts: z.number().finite(),
  source: z.enum(['agent', 'tool', 'mcp']),
  outcome: z.enum(['completed', 'failed', 'cancelled']),
  phase: z.enum(['spawn', 'initialize', 'session_load', 'session_new', 'prompt', 'tool_call']),
  code: z.number().int().optional(),
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
  control: z.enum(['connected', 'connecting', 'reconnecting', 'rejected', 'disabled']),
  sharing: z.enum(['ready', 'unavailable']),
  remoteControl: z.enum(['ready', 'unavailable']),
  reason: z.enum(['unknown_key', 'revoked', 'expired']).optional(),
  lastCloseCode: z.number().int().optional(),
});

export function createControlDiagnosticsTool(deps: {
  authorizeCaller: (input: ControlPlaneSessionCall) => Promise<void>;
  readProgress: (input: ControlPlaneSessionCall) => Promise<Record<string, unknown>>;
  readMatrixDiagnostics?:
    | ((
        projectId: string,
        event?: { accountId: string; sourceId: string; eventId: string },
      ) => Promise<unknown>)
    | undefined;
  version: string;
  pushEnabled: boolean;
  publicPreviewsEnabled: () => boolean;
  runtimeReadiness?: (() => Promise<void>) | undefined;
  uplinkDiagnostics?: (() => unknown) | undefined;
}) {
  return async (input: ControlPlaneSessionCall) => {
    await deps.authorizeCaller(input);
    const request = diagnosticsRequestSchema.parse(input.request);
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
    await deps.authorizeCaller(input);
    return {
      schemaVersion: 1,
      observedAt: new Date().toISOString(),
      server: { version: deps.version },
      capabilities: { pushEnabled: deps.pushEnabled, publicPreviewsEnabled: publicPreviews },
      secretJobRuntime: { state: runtime },
      uplink,
      session,
      matrix,
      limitations: [
        'Capability flags do not prove delivery or dependency health.',
        'Session diagnostics cover at most the latest 2000 events and 20 technical records.',
        'Stored records alone do not prove Knowledge projection; missing retries alone do not prove successful import. Snapshot timestamps identify stale evidence.',
        'Matrix diagnostics contain at most 20 sources and the connector reports at most 20 active failed imports; additional failures may be omitted.',
        'Free-form errors, messages, backend labels and configuration values are omitted.',
        'Job inventory, queue depth, GitOps comparison, component versions and cross-component correlation are unavailable.',
        'No root cause is inferred from state or status codes; corroborate with other evidence.',
      ],
    };
  };
}
