import { z } from 'zod';

/**
 * Canonical agent event model (concept doc §5b).
 *
 * This is the runtime-agnostic contract the control-plane emits to the mobile
 * app over the WebSocket and persists to Postgres. Runtime adapters (Claude
 * Code now, OpenCode later) normalize their native stream into these events;
 * nothing downstream of the adapter is allowed to be runtime-specific.
 *
 * Zod is the single source of truth: the TypeScript types are derived via
 * {@link z.infer}, and the same schema validates untrusted adapter output at
 * runtime before it is persisted. The `raw` variant is a display/logging
 * escape hatch only — never drive control logic off it (concept doc §16).
 */

/** Lifecycle state of a single agent (concept doc §5b `status`). */
export const agentStatusSchema = z.enum([
  'running',
  'awaiting_input',
  'awaiting_dependency',
  'crashed',
  'completed',
]);
export type AgentStatus = z.infer<typeof agentStatusSchema>;

/**
 * Permission risk class. `auto` is gated by the runtime's own classifier;
 * `ask` always escalates to the operator via the permission bridge (§5b).
 */
export const riskClassSchema = z.enum(['auto', 'ask']);
export type RiskClass = z.infer<typeof riskClassSchema>;

/**
 * The transport channel for brokered-secret prompts and standing grants (ADR 0014 D3).
 * ACP is the only remaining channel and carries a 24-hour ceiling with no `forever` scope.
 *
 * It lives here, with the event that carries it, because the value crosses every layer
 * — the backend derives it, the event carries it to the card, and the grant store keys
 * approvals by it — and two hand-kept copies of a security enum eventually disagree.
 */
export const brokeredGrantChannelSchema = z.literal('acp');
export type BrokeredGrantChannel = z.infer<typeof brokeredGrantChannelSchema>;

/**
 * A channel this event carried before that channel was retired — `native`, removed with the
 * native Codex transport.
 *
 * The event log is append-only and therefore older than the schema that reads it: narrowing
 * {@link brokeredGrantChannelSchema} to `acp` did not narrow the rows already written, and
 * this schema validates on the way OUT of the store as well as in. Every read of a session
 * holding such a row threw `corrupt event payload` instead — which the session list renders
 * as `crashed` and the orphan-prompt recovery reports as a failed background turn, so a
 * schema-only change made whole sessions unresumable.
 *
 * A retired channel is dropped rather than mapped onto the surviving one: the value's only
 * job is to say which standing grants may answer a prompt, and a channel that no longer
 * exists must not answer for the one that replaced it. Absence is already the safe reading
 * everywhere it is consumed — the card offers no standing scope, and the conductor resolves
 * no grant — which is exactly what a decision made on a transport this build no longer has
 * should be worth today.
 */
const retiredBrokeredGrantChannelSchema = z.literal('native').transform(() => undefined);

/**
 * What a persisted `grantChannel` is read as. `.optional()` stays outermost so the output type
 * is the `'acp' | undefined` every consumer has always seen; only `z.input` gains the retired
 * literal, and nothing in the repo types against it or converts this schema to JSON Schema.
 *
 * One schema serves both directions, so an event from a peer old enough to still name the
 * retired channel is accepted rather than refused — refusing it would fail the turn, accepting
 * costs only a standing grant this build would decline to resolve. It is not rewritten on the
 * way in: `prepareEventRow` persists the caller's object, so the row keeps what the peer said
 * and every read drops it. Two costs follow, both bounded by the rollout window and neither
 * worth widening this fix for: the shim outlives any cutoff date, since rows can still be
 * written (removing it needs a backfill, not just an older build going away), and a live
 * subscriber sees the retired name where a replaying one sees `undefined`. Consumers compare
 * against `'acp'`, where both readings agree; a `!== undefined` check would not.
 */
const persistedBrokeredGrantChannelSchema = z
  .union([brokeredGrantChannelSchema, retiredBrokeredGrantChannelSchema])
  .optional();

/** Quota window a rate-limit event refers to (subscription 5h or weekly window, §13a). */
export const rateLimitWindowSchema = z.enum(['five_hour', 'weekly']);
export type RateLimitWindow = z.infer<typeof rateLimitWindowSchema>;

/**
 * Lifecycle phase of a background task / sub-agent (§5b). `started` opens the
 * task, `progress` is a mid-run heartbeat (no state transition), `ended` closes
 * it (terminal — see the event's `status` for the outcome). Tracking open tasks
 * is what keeps a turn/session "running" across a background dispatch: a
 * `run_in_background` Agent/Bash returns its tool call immediately, so the turn's
 * first `result` can fire while the task is still open and the backend re-invokes
 * with a later `result` once it finishes.
 */
export const taskPhaseSchema = z.enum(['started', 'progress', 'ended']);
export type TaskPhase = z.infer<typeof taskPhaseSchema>;

/**
 * Media types accepted for image attachments — the set every supported vision
 * backend understands. Kept narrow so each adapter maps it 1:1 to its own input
 * format without guessing.
 */
export const imageMediaTypeSchema = z.enum(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
export type ImageMediaType = z.infer<typeof imageMediaTypeSchema>;

/**
 * Media type for a non-image FILE attachment (PDF, doc, csv, …). Kept permissive —
 * unlike an image (which every vision backend maps 1:1, see {@link
 * imageMediaTypeSchema}), a file is delivered to the agent by materializing its
 * bytes to a real file in the working directory, so the backend only needs the
 * bytes plus a name; the exact MIME is advisory. Bounded so a bogus value can't
 * bloat an event.
 */
export const fileMediaTypeSchema = z.string().min(1).max(255);

/** Discriminant for the two things an operator can attach to a prompt. */
export const attachmentKindSchema = z.enum(['image', 'file']);
export type AttachmentKind = z.infer<typeof attachmentKindSchema>;

/**
 * What the operator UPLOADS with a prompt: the raw bytes as base64 (NO `data:` URL
 * prefix). `kind` discriminates how the byte stream reaches the agent:
 *   - `image` → shown to the vision model inline (Claude `stream-json` image block /
 *     Codex `--image`); constrained to {@link imageMediaTypeSchema}.
 *   - `file`  → materialized to a file in the working directory and referenced by
 *     path in the prompt, so the agent reads it with its own tools; carries the
 *     original `fileName` and an advisory `mediaType`.
 * This is the heavy, transient shape; it is NOT what gets persisted (see {@link
 * attachmentSchema}).
 */
export const attachmentUploadSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('image'),
    mediaType: imageMediaTypeSchema,
    data: z.string().min(1),
  }),
  z.object({
    kind: z.literal('file'),
    mediaType: fileMediaTypeSchema,
    /** Original name (basename); shown in the UI and used to name the on-disk file. */
    fileName: z.string().min(1).max(255),
    data: z.string().min(1),
  }),
]);
export type AttachmentUpload = z.infer<typeof attachmentUploadSchema>;

/** Shared rule for a persisted attachment: it must carry a stored ref OR inline
 * bytes (new writes set `id`; legacy pre-blob-storage events set `data`). */
const attachmentHasBytes = (a: { id?: string | undefined; data?: string | undefined }): boolean =>
  a.id !== undefined || a.data !== undefined;
const attachmentBytesMessage = { message: 'attachment needs an id or inline data' };

/**
 * A backend-neutral attachment as PERSISTED on a `prompt` event. The bytes are
 * stored once server-side (content-addressed) and the event carries only `id`
 * (the SHA-256 hash) — the client fetches the blob lazily by id, so opening a
 * session never transfers the full attachment backlog. `data` (inline base64) is
 * kept optional for backward compatibility with events written before blob storage;
 * the refine requires at least one of the two. New writes set `id` only.
 */
export const attachmentSchema = z.union([
  z
    .object({
      kind: z.literal('image'),
      mediaType: imageMediaTypeSchema,
      /** Content-addressed reference (SHA-256 hex) — fetch via `GET /attachments/:id`. */
      id: z.string().min(1).optional(),
      /** Legacy inline base64 (pre-blob-storage events only). */
      data: z.string().min(1).optional(),
    })
    .refine(attachmentHasBytes, attachmentBytesMessage),
  z
    .object({
      kind: z.literal('file'),
      mediaType: fileMediaTypeSchema,
      /** Original file name — rendered in the transcript and used to name the file
       * materialized into the agent's working directory. */
      fileName: z.string().min(1).max(255),
      id: z.string().min(1).optional(),
      data: z.string().min(1).optional(),
    })
    .refine(attachmentHasBytes, attachmentBytesMessage),
]);
export type Attachment = z.infer<typeof attachmentSchema>;

/**
 * A content-addressed reference to a tool result's FULL output, carried as
 * `outputRef` on a `tool_result` event when the store externalizes a large text
 * result (see {@link ./toolResultText}). When present, the event's inline `output`
 * is only a truncated preview and the full body — the JSON serialization of the
 * output — lives in the blob store at `id` (fetch via `GET /attachments/:id`),
 * so opening a session never transfers the whole tool-output backlog. `bytes` is
 * the full body's size, for display/budgeting.
 */
export const toolResultRefSchema = z.object({
  id: z.string().min(1),
  bytes: z.number().int().nonnegative(),
});
export type ToolResultRef = z.infer<typeof toolResultRefSchema>;

/**
 * One tappable option of a {@link agentEventSchema} `choices` event (issue #97).
 * `label` is both what the operator sees on the chip AND what is sent verbatim as
 * the next turn's prompt when tapped, so it must be a self-contained short answer.
 * `recommended` pre-highlights the agent's default pick (at most one per choice).
 */
export const choicesOptionSchema = z.object({
  label: z.string().min(1).max(200),
  recommended: z.boolean().optional(),
});
export type ChoicesOption = z.infer<typeof choicesOptionSchema>;

/**
 * The payload of a `choices` decision point: the options plus optional question
 * text and a multi-select flag. Shared by the canonical `choices` event and the
 * end-of-turn contract parser ({@link ./choices}); the agent emits this JSON in a
 * ` ```verity:choices ` fence, the adapter lifts it onto the event.
 */
export const choicesPayloadSchema = z
  .object({
    question: z.string().max(1_000).optional(),
    options: z.array(choicesOptionSchema).min(1).max(20),
    multiSelect: z.boolean().optional(),
  })
  .refine(
    (payload) => payload.options.filter((option) => option.recommended === true).length <= 1,
    { message: 'at most one choice option may be recommended', path: ['options'] },
  );
export type ChoicesPayload = z.infer<typeof choicesPayloadSchema>;

export const agentLoopScheduleSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('interval'), everyMinutes: z.number().int().min(15) }),
  z.object({
    kind: z.literal('daily'),
    hour: z.number().int().min(0).max(23),
    minute: z.number().int().min(0).max(59),
  }),
  z.object({
    kind: z.literal('weekly'),
    weekday: z.number().int().min(0).max(6),
    hour: z.number().int().min(0).max(23),
    minute: z.number().int().min(0).max(59),
  }),
]);

/** Structured Agent Loop configuration proposed by an agent for explicit user approval. */
export const agentLoopProposalSchema = z.object({
  loopId: z.string().uuid(),
  name: z.string().trim().min(1).max(80),
  script: z.string().min(1),
  schedule: agentLoopScheduleSchema,
  reactionPrompt: z.string().trim().min(1).optional(),
  reactionModel: z.string().trim().min(1).nullable().optional(),
});
export type AgentLoopProposal = z.infer<typeof agentLoopProposalSchema>;

/** Token accounting carried on a turn result (§5b `result`, §13a quota math). */
export const usageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
  cacheCreationTokens: z.number().int().nonnegative(),
});
export type Usage = z.infer<typeof usageSchema>;

/**
 * Backend/path metadata carried on a turn result. This deliberately stores only
 * counts and labels, never prompt contents, so token-cost investigations can
 * distinguish hot/live vs resume paths without duplicating sensitive text.
 */
export const resultTelemetrySchema = z.object({
  backend: z.string().min(1),
  mode: z.string().min(1),
  userPromptChars: z.number().int().nonnegative().optional(),
  runtimePromptChars: z.number().int().nonnegative().optional(),
  submittedPromptChars: z.number().int().nonnegative().optional(),
  attachments: z.number().int().nonnegative().optional(),
  resumed: z.boolean().optional(),
});
export type ResultTelemetry = z.infer<typeof resultTelemetrySchema>;

/**
 * One tool the turn requested but was NOT permitted (§5b, carried on `result`).
 * `tool` (the canonical tool name) is always present and non-blank. `toolUseId`
 * + `input` are additive/optional (#26): when the backend emits them, they let
 * the operator correlate the denial back to its `tool_call`/`permission` event
 * in the same turn and see what input was attempted before deciding to re-approve.
 * Older streams (and backends that don't surface them) omit both keys entirely —
 * the bare `{ tool }` shape stays valid.
 */
export const permissionDenialSchema = z.object({
  tool: z.string().min(1),
  toolUseId: z.string().min(1).optional(),
  input: z.unknown().optional(),
});
export type PermissionDenial = z.infer<typeof permissionDenialSchema>;

/**
 * Sub-agent attribution: the id of the `tool_call` (a `Task`/`Agent` dispatch)
 * whose execution produced this event. Present on every event a SUB-agent emits
 * (its text, thinking, tool calls + results); absent on top-level events. Lets the
 * UI nest a delegation's whole subtree under one collapsible card instead of
 * flattening it into the main transcript. Backend-neutral — any agent runtime with
 * sub-agents has an equivalent parent reference (Claude Code: `parent_tool_use_id`).
 */
const parentToolId = z.string().min(1).optional();

/**
 * Discriminated union of every canonical event. The discriminant is `t`.
 *
 * Field-level notes from the spike (§5b/§18):
 * - `tool_call.input` is only valid JSON once the runtime emits `block_stop`;
 *   the adapter must not surface a partial `tool_call` before then.
 * - `thinking.signature` is required to replay a thinking block on `--resume`;
 *   it is model-specific and must round-trip verbatim.
 */
export const agentEventSchema = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('session'),
    id: z.string().min(1),
    model: z.string().min(1),
    worktree: z.string().min(1),
  }),
  z.object({
    t: z.literal('status'),
    state: agentStatusSchema,
  }),
  z.object({
    t: z.literal('text'),
    delta: z.string(),
    parentToolId,
  }),
  z.object({
    // Server-authored transcript note shown as a standalone chat message. Unlike
    // streaming `text`, a notice is never coalesced into an open agent response and
    // starts no turn. `role` lets system workflows show an operator-facing action
    // ("Please transcribe…") followed by agent-style progress/results.
    t: z.literal('notice'),
    text: z.string(),
    role: z.enum(['agent', 'operator']).optional(),
    // Correlates a server-confirmed workflow notice with an optimistic local echo.
    clientRequestId: z.string().max(100).optional(),
  }),
  z.object({
    // The operator's steering prompt for a turn — persisted by the conductor when
    // a turn is dispatched, so the operator's own message shows in the transcript
    // (claude's stream doesn't echo it). Distinct from `text` (the agent's output).
    t: z.literal('prompt'),
    // May be empty when the turn carries only attachments (e.g. a screenshot with
    // no caption); the dispatch boundary guarantees at least one of text/attachments.
    text: z.string(),
    // True when the message was injected into an already-running turn rather than
    // starting a new one. Status projections use this to distinguish a real turn
    // boundary from mid-turn steering while background tasks remain open.
    steered: z.boolean().optional(),
    // Operator-attached files (v1: images) sent with this prompt, so the transcript
    // can render them. Omitted when the turn had no attachments.
    attachments: z.array(attachmentSchema).optional(),
  }),
  z.object({
    t: z.literal('thinking'),
    blockId: z.string().min(1),
    signature: z.string().optional(),
    delta: z.string(),
    parentToolId,
  }),
  z.object({
    // The body Claude Code injects when a skill/slash-command (e.g. /code-review)
    // is invoked — a synthetic `user` turn the model reads as
    // instructions. The adapter routes it here instead of rendering it as operator
    // prose (which dumped the whole skill into the chat). The reducer folds the
    // text into the preceding `Skill` tool card as collapsed detail; a `skill`
    // event that doesn't correlate to a skill call renders nothing.
    t: z.literal('skill'),
    text: z.string(),
  }),
  z.object({
    t: z.literal('tool_call_start'),
    id: z.string().min(1),
    name: z.string().min(1),
    parentToolId,
  }),
  z.object({
    t: z.literal('tool_call'),
    id: z.string().min(1),
    name: z.string().min(1),
    input: z.unknown(),
    parentToolId,
  }),
  z.object({
    t: z.literal('tool_result'),
    id: z.string().min(1),
    output: z.unknown(),
    isError: z.boolean(),
    // Present when the store externalized a large text output: `output` above is
    // then a truncated preview and this points at the full body (see
    // {@link toolResultRefSchema}). Absent → `output` is the full result.
    outputRef: toolResultRefSchema.optional(),
    parentToolId,
  }),
  z.object({
    t: z.literal('permission'),
    id: z.string().min(1),
    tool: z.string().min(1),
    input: z.unknown(),
    riskClass: riskClassSchema,
    /**
     * Transport this prompt arrived on, for the brokered-secret tools (ADR 0014 D3).
     * The card offers only the standing scopes that channel accepts — `forever` is not
     * available on `acp`, and the server refuses it there, so offering it would produce
     * an approval that silently saves nothing. Server-derived; the agent never supplies
     * it. Absent on events written before this existed, and on events from a server
     * across a rollout boundary; the card reads absence as the restricted channel,
     * since it cannot tell which transport raised such a prompt and the server refuses
     * a standing scope it cannot resolve a channel for. A channel retired since the event
     * was written reads as absent for the same reason
     * ({@link persistedBrokeredGrantChannelSchema}).
     */
    grantChannel: persistedBrokeredGrantChannelSchema,
  }),
  z.object({
    t: z.literal('result'),
    usage: usageSchema,
    stopReason: z.string(),
    telemetry: resultTelemetrySchema.optional(),
    /**
     * Tools the turn requested but were NOT permitted (§5b). In `--resume`-per-
     * turn (argv) mode `claude` silently auto-denies un-pre-approved tools, so
     * surfacing these is how the operator sees what was blocked. Omitted when the
     * turn had no denials.
     */
    permissionDenials: z.array(permissionDenialSchema).optional(),
  }),
  z.object({
    t: z.literal('rate_limit'),
    status: z.string(),
    resetsAt: z.number().int().nonnegative(),
    window: rateLimitWindowSchema,
    /** Optional percent used for meter-style provider quota display. */
    usedPercent: z.number().min(0).max(100).optional(),
    /** Provider-defined quota scope. Omitted by older events means all models. */
    scope: z.string().min(1).optional(),
    /** Human-facing provider/engine label whose quota window this event describes. */
    providerLabel: z.string().min(1).optional(),
  }),
  z.object({
    // A background task / sub-agent the turn spawned (Claude Code `system/task_*`).
    // A `run_in_background` dispatch (Agent/Bash) returns its `tool_call`
    // immediately while the work continues off-turn, so the turn's `result` can
    // fire while the task is still open; the backend then re-invokes with more
    // output and a later `result` once it finishes. The control plane tracks the
    // open set (by `id`) to keep the turn/session "running" across that gap instead
    // of reporting it completed at the first `result` — see `deriveSessionStatus`.
    // Backend-neutral: any runtime with background work
    // has an equivalent start/end signal.
    t: z.literal('task'),
    id: z.string().min(1),
    phase: taskPhaseSchema,
    // The dispatching `tool_call` id (the Agent/Task/Bash `tool_use`) when the
    // backend reports it — lets the UI attribute the task to its tool_call. Absent
    // on phases where the backend omits it (e.g. a bare `task_updated` patch).
    toolUseId: z.string().min(1).optional(),
    // Human label the backend attached (task description / notification summary).
    description: z.string().min(1).optional(),
    // Terminal outcome on phase `ended` (backend string, e.g. `completed`/`failed`).
    status: z.string().min(1).optional(),
  }),
  z
    .object({
      // A decision point the agent posed at end-of-turn (issue #97). The adapter
      // lifts this off a ` ```verity:choices ` contract block the agent appends to
      // its final text (see {@link ./choices}); the app renders the options as
      // tappable Quick-Action chips and a tap sends the chosen label as a new turn.
      t: z.literal('choices'),
      question: z.string().max(1_000).optional(),
      options: z.array(choicesOptionSchema).min(1).max(20),
      multiSelect: z.boolean().optional(),
    })
    .refine((event) => event.options.filter((option) => option.recommended === true).length <= 1, {
      message: 'at most one choice option may be recommended',
      path: ['options'],
    }),
  z.object({
    t: z.literal('agent_loop_proposal'),
    proposal: agentLoopProposalSchema,
  }),
  z.object({
    // A turn ended without normal completion. Emitted for an explicit cancel, an
    // abandoned-turn recovery, or a shutdown drain; any partial output the agent
    // already streamed stays in the log. Actor provenance is intentionally absent,
    // so this renders as the neutral "Turn interrupted" transcript row.
    t: z.literal('interrupted'),
  }),
  z.object({
    // The operator merged this session's open PR from the PR bar. The server appends
    // this as a transcript-only marker so the operator SEES the merge landed when they
    // return to the chat — it triggers NO turn and NO agent reply. The agent learns of
    // the merge separately, via the pending note the merge route leaves (folded into
    // its next turn). Rendered as a "Merged PR #N" row.
    t: z.literal('merged'),
    number: z.number().int().positive(),
  }),
  z.object({
    t: z.literal('compaction'),
    boundary: z.literal(true),
  }),
  z.object({
    t: z.literal('error'),
    kind: z.string(),
    message: z.string(),
  }),
  z.object({
    t: z.literal('session_progress'),
    summary: z.string().min(1).max(1_000),
    outcomeDelivered: z.boolean(),
    blocker: z.string().min(1).max(500).optional(),
    requiredDecision: z.string().min(1).max(500).optional(),
  }),
  z.object({
    t: z.literal('raw'),
    backend: z.string().min(1),
    payload: z.unknown(),
  }),
]);
export type AgentEvent = z.infer<typeof agentEventSchema>;

/** Discriminant literal of {@link AgentEvent}. */
export type AgentEventType = AgentEvent['t'];

/**
 * Validate an untrusted value as an {@link AgentEvent}. Returns a Zod
 * {@link z.ZodSafeParseResult} so the caller decides how to handle malformed
 * adapter output (the adapter persists nothing it cannot validate).
 */
export function parseAgentEvent(input: unknown): z.ZodSafeParseResult<AgentEvent> {
  return agentEventSchema.safeParse(input);
}

/** Type guard for {@link AgentEvent}. */
export function isAgentEvent(input: unknown): input is AgentEvent {
  return agentEventSchema.safeParse(input).success;
}
