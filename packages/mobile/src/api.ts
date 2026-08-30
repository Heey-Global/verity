import {
  agentEventSchema,
  attachmentSchema,
  attachmentUploadSchema,
  type AttachmentUpload,
  agentStatusSchema,
  usageSchema,
} from '@verity/events';
import { z } from 'zod';

export type { Attachment, AttachmentUpload } from '@verity/events';

/**
 * Typed client for the Verity control-plane REST API (server `server.ts`). The
 * response shapes are validated with zod so a drifted/garbled server response
 * fails loudly here rather than corrupting the UI. The substantive contract
 * (status enum, usage) is reused from `@verity/events`, the shared model.
 */

/** Session status as the server derives it: the agent status plus `idle`. */
export const sessionStatusSchema = z.union([agentStatusSchema, z.literal('idle')]);
export type SessionStatus = z.infer<typeof sessionStatusSchema>;

/** Compact PR status for a session's CURRENT branch, carried on the session list so
 * the overview can show merge-ready / merge-blocked / CI-failed markers without a
 * per-session branch fetch. A projection of the richer `pullRequest` in
 * {@link branchListSchema}. */
/** GitHub's `mergeable_state`, when the server queried it. Unknown/absent values fall
 * back to `undefined` rather than failing the parse, so a state GitHub adds later (or
 * an older server that omits the field) degrades to "no conflict signal". */
const mergeStateSchema = z
  .enum(['clean', 'dirty', 'blocked', 'behind', 'unstable', 'draft', 'unknown'])
  .optional()
  .catch(undefined);

export const sessionPrSchema = z.object({
  phase: z.enum(['open', 'merged', 'closed']),
  pipeline: z.enum(['pending', 'running', 'success', 'failure', 'unknown']),
  // Tri-state: true = mergeable, false = blocked/conflict, null = unknown (checks
  // not green yet, or GitHub still computing mergeability just after a push).
  // `.catch(null)` keeps an older server's bare boolean parseable during rollout.
  mergeable: z.boolean().nullable().catch(null),
  // GitHub's `mergeable_state`. `'dirty'` = the branch CONFLICTS with its base, which
  // also means GitHub started no `pull_request` checks — the one state that must read
  // as blocked even though `pipeline` is `unknown`. ABSENT = older server, or the
  // server didn't query mergeability for this PR.
  mergeState: mergeStateSchema,
});
export type SessionPr = z.infer<typeof sessionPrSchema>;

const usageTotalsSchema = usageSchema.extend({ turns: z.number().int().nonnegative() });

const rateLimitStateSchema = z.object({
  status: z.string(),
  resetsAt: z.number().int().nonnegative(),
  window: z.enum(['five_hour', 'weekly']).default('five_hour'),
  usedPercent: z.number().min(0).max(100).optional(),
  scope: z.string().min(1).optional(),
  providerLabel: z.string().min(1).optional(),
  observedAt: z.number().int().nonnegative().optional(),
});
export type ProviderLimitSummary = z.infer<typeof rateLimitStateSchema>;

/**
 * A condition worth interrupting the operator for, delivered next to the thing
 * it is about: server-level ones on the session-list envelope, session-level
 * ones on the session summary itself.
 *
 * `code` is deliberately a free string rather than an enum: it exists to key the
 * banner and to let a future client special-case a condition, and a server newer
 * than this app must not be able to break the session-list parse by adding one.
 * `message` is already operator-facing and is rendered verbatim.
 *
 * `action` names the one remedy a signal has, when it has exactly one, so the
 * banner can offer it as a tap instead of leaving the operator to find the screen.
 * A free string for the same reason `code` is, and one step further: it is parsed
 * loosely here — anything unusable is dropped rather than failing the signal
 * around it — and mapped to a known action at the render site, so an action this
 * build has never heard of costs the button and nothing else. `message` always
 * stands on its own — the tap is an accelerator, never the only way to act.
 */
export const attentionSignalSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  action: z.string().min(1).optional().catch(undefined),
});
export type AttentionSignal = z.infer<typeof attentionSignalSchema>;

export const sessionSummarySchema = z.object({
  sessionId: z.string().min(1),
  worktree: z.string(),
  model: z.string(),
  /** Operator-assigned display name; `null` until set at spawn or via rename. */
  name: z.string().nullable(),
  /** Project binding for multi-repo fleet sessions (#174). Older servers omit it. */
  projectId: z.string().nullable().optional(),
  /** Agent Loop sessions are visually distinct and pinned below normal sessions. */
  kind: z.enum(['normal', 'agent_loop']).optional(),
  status: sessionStatusSchema,
  /** Tool-use ids currently waiting for permission. Optional for compatibility
   * with older servers. */
  pendingPermissions: z.array(z.string().min(1)).optional(),
  /** True only when awaiting_input is caused by those permissions. */
  permissionAwaitingInput: z.literal(true).optional(),
  usage: usageTotalsSchema,
  /** Latest rate-limit state for this session. Optional for rollout with
   * older servers and absent until a runtime emits one. */
  rateLimit: rateLimitStateSchema.optional(),
  /** Latest rate-limit states by provider/window. Optional for older servers. */
  rateLimits: z.array(rateLimitStateSchema).optional(),
  /** False once the session's worktree is gone (cleaned up after its PR merged):
   * a steering turn would 410. The UI disables the input + flags the session.
   * OPTIONAL on the wire for forward-compat: an app newer than the server (no
   * `resumable` yet) must not hard-fail the list parse — a missing value reads as
   * "resumable" (the safe default: don't block sending on absent metadata). */
  resumable: z.boolean().optional(),
  /** Compact PR status for this session's current branch (#387), so the overview can
   * mark merge-ready / merge-blocked / CI-failed sessions without a per-session branch fetch. `null` =
   * looked up, no open PR; ABSENT = older server OR GitHub not configured (no
   * token/remote) — both render as "no PR marker". */
  pr: sessionPrSchema.nullable().optional(),
  /** Total persisted events (#387) — a monotonic activity counter the overview
   * compares against a per-device "last seen" mark for the unread dot. OPTIONAL on
   * the wire: an OLDER server omits it on the list, and absent simply reads as "no
   * unread signal" (never a false unread). The detail endpoint always sends it. */
  eventCount: z.number().int().nonnegative().optional(),
  /** Operator's "last seen" mark for the unread dot (#387): the `eventCount` at the
   * last open, persisted server-side so the dot syncs across devices. A session is
   * unread when `eventCount > lastSeenEventCount`. `null` = never opened (→ not
   * unread); ABSENT = older server with no synced mark (→ not unread either). */
  lastSeenEventCount: z.number().int().nonnegative().nullable().optional(),
  /** Conditions about THIS session, e.g. a sandbox that lost its connection to
   * the server (`sandbox_disconnected`). Absent from a healthy session and from
   * any older server, both of which read as "nothing to report". */
  attention: z.array(attentionSignalSchema).optional(),
});
export type SessionSummary = z.infer<typeof sessionSummarySchema>;

/**
 * The session list plus anything server-level worth showing.
 *
 * Accepts BOTH shapes on purpose. `GET /sessions` answered with a bare array for
 * this route's whole life and still does unless `?envelope=1` is asked for, so a
 * server older than this app keeps parsing — it simply reports no attention
 * signals, which is also what a healthy newer server reports.
 */
export const sessionListEnvelopeSchema = z.union([
  z
    .array(sessionSummarySchema)
    .transform((sessions) => ({ sessions, attention: [] as AttentionSignal[] })),
  z
    .object({
      sessions: z.array(sessionSummarySchema),
      attention: z.array(attentionSignalSchema).optional(),
    })
    .transform(({ sessions, attention }) => ({ sessions, attention: attention ?? [] })),
]);
export type SessionListEnvelope = z.infer<typeof sessionListEnvelopeSchema>;

export const messageSearchResultSchema = z.object({
  id: z.number().int().positive(),
  sessionId: z.string().min(1),
  sessionName: z.string().nullable(),
  projectId: z.string().nullable(),
  projectName: z.string().nullable(),
  role: z.enum(['user', 'agent']),
  kind: z.enum(['prompt', 'text', 'notice']),
  text: z.string(),
  firstEventSeq: z.number().int().positive(),
  createdAt: z.number().int().nonnegative(),
});
export type MessageSearchResult = z.infer<typeof messageSearchResultSchema>;

/** One turn queued behind the in-flight one: its prompt `text` plus a stable `id`
 * the client uses to retract it (#80). Accepts a bare string from an OLDER server
 * (pre-#80, `queued: string[]`) and normalizes it to an id-less item — it then
 * renders as a waiting bubble but isn't retractable (no handle), the safe degrade. */
export const queuedItemSchema = z.union([
  z.string().transform((text) => ({ id: '', text })),
  z.object({
    id: z.string(),
    text: z.string(),
    attachments: z.array(attachmentSchema).optional(),
  }),
]);
export type QueuedItem = z.infer<typeof queuedItemSchema>;

export const sessionDetailSchema = sessionSummarySchema.extend({
  eventCount: z.number().int().nonnegative(),
  /** True while a turn is in flight (the agent is working). OPTIONAL on the wire
   * for forward-compat with an older server; absent → not busy. */
  busy: z.boolean().optional(),
  /** Turns queued behind the in-flight one (#90/#80), FIFO. Absent → none. */
  queued: z.array(queuedItemSchema).optional(),
});
export type SessionDetail = z.infer<typeof sessionDetailSchema>;

/** Live activity of a session (from `GET /sessions/:id/activity`): in-flight +
 * queued state, polled for the working indicator and persistent waiting bubbles. */
export const sessionActivitySchema = z.object({
  busy: z.boolean(),
  queued: z.array(queuedItemSchema),
  /** Tool-use ids currently parked on a server-side permission decision. Optional
   * for compatibility with older servers. The durable `permission` event carries
   * the card contents; this list is the polling/reconnect re-arm signal. */
  pendingPermissions: z.array(z.string().min(1)).optional(),
  /** Whether a model switch is outstanding. Two shapes share this bit: on an older
   * server it meant "accepted, applies at the current turn's settle boundary"; on a
   * current one it means "the handover is running RIGHT NOW" — the switch interrupts
   * the live turn and the PATCH does not answer until ownership has passed. Both are
   * "the engine is mid-change, don't trust the chip yet", which is what the banner
   * says. Optional for compatibility with older servers. */
  modelSwitchPending: z.boolean().optional(),
  /** Whether the session is reserved by a stop whose agent process could not be
   * confirmed gone. `busy` is true then with nothing running for the operator: the
   * worktree stays fenced until termination is established, and the server keeps
   * retrying by itself. Optional for compatibility with older servers. */
  terminationUnconfirmed: z.boolean().optional(),
  /** The worktree's current branch (#110), read live from git so the header label
   * auto-updates on an external/agent `git checkout` without a remount. OPTIONAL on
   * the wire: absent when branch switching isn't configured (scratch deploy) or an
   * older server — the header then keeps the load-once value. */
  branch: z.string().optional(),
  /** The session's display name (#auto-title): so the header reflects an
   * auto-generated or externally-renamed title within a poll, without a remount.
   * OPTIONAL on the wire (absent on an older server) — the header then keeps its
   * load-once value; `null` means explicitly unnamed. */
  name: z.string().nullable().optional(),
});
export type SessionActivity = z.infer<typeof sessionActivitySchema>;

/** One open GitHub issue from `GET /issues` (#137): the overview backlog the
 * operator can read and spawn a session from. `body` may be empty; `url` is the
 * issue's html page. PRs are excluded server-side. */
export const issueSummarySchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  body: z.string(),
  url: z.string(),
  projectId: z.string().nullable().optional(),
});
export type IssueSummary = z.infer<typeof issueSummarySchema>;

/** Task management over a GitHub Projects v2 board (ADR 0007). A board item is an
 * issue, a PR, or a repo-less draft (the inbox); a draft carries no `number`/`url`
 * and a `null` `state`. `id` is the board-item handle (reorder / convert), while
 * `contentId` is the underlying issue/PR node id (update). `fields` are the resolved
 * custom-field values (Priority/Status/…). */
export const taskFieldValueSchema = z.object({
  field: z.string(),
  value: z.string(),
});
export type TaskFieldValue = z.infer<typeof taskFieldValueSchema>;
export const taskContentTypeSchema = z.enum(['ISSUE', 'PULL_REQUEST', 'DRAFT_ISSUE']);
export const taskItemSchema = z.object({
  id: z.string(),
  type: taskContentTypeSchema,
  number: z.number().int().positive().nullable(),
  title: z.string(),
  body: z.string(),
  url: z.string(),
  state: z.string().nullable(),
  contentId: z.string().nullable(),
  fields: z.array(taskFieldValueSchema),
  projectId: z.string().nullable().optional(),
});
export type TaskItem = z.infer<typeof taskItemSchema>;
/** A board field DEFINITION (id + name + single-select options), so a picker can offer
 *  valid Priority/Status values. `options` is empty for non-single-select fields. */
export const taskFieldOptionSchema = z.object({ id: z.string(), name: z.string() });
export const taskFieldSchema = z.object({
  id: z.string(),
  name: z.string(),
  options: z.array(taskFieldOptionSchema),
});
export type TaskField = z.infer<typeof taskFieldSchema>;
/** The board itself: items are in stored order, so their index is the manual rank.
 *  `fields` defaults to `[]` so a server that predates field defs still parses. */
export const taskBoardSchema = z.object({
  projectId: z.string(),
  number: z.number().int(),
  title: z.string(),
  items: z.array(taskItemSchema),
  fields: z.array(taskFieldSchema).default([]),
});
export type TaskBoard = z.infer<typeof taskBoardSchema>;

const taskBoardResponseSchema = z.object({ board: taskBoardSchema.nullable() });
const taskDraftCreatedSchema = z.object({ item: taskItemSchema });
const taskIssueCreatedSchema = z.object({
  issue: z.object({
    issueId: z.string(),
    itemId: z.string().nullable(),
    number: z.number().int().positive().nullable(),
    url: z.string(),
  }),
});
/** The `{ issueId, itemId, number, url }` returned when an issue is created + boarded. */
export type TaskIssueCreated = z.infer<typeof taskIssueCreatedSchema>['issue'];
const taskDraftConvertedSchema = z.object({
  result: z.object({
    itemId: z.string(),
    number: z.number().int().positive().nullable(),
    url: z.string(),
  }),
});
/** The `{ itemId, number, url }` returned when a draft becomes a real issue. */
export type TaskDraftConverted = z.infer<typeof taskDraftConvertedSchema>['result'];

/** A refined task blueprint from Voice → Refiner (ADR 0007): the structured result of
 *  turning a raw transcript into an implementable issue, for the operator to review /
 *  edit before filing. */
export const refinedTaskSchema = z.object({
  title: z.string(),
  problem: z.string(),
  acceptanceCriteria: z.array(z.string()),
  affectedAreas: z.array(z.string()),
  openQuestions: z.array(z.string()),
});
export type RefinedTask = z.infer<typeof refinedTaskSchema>;
const taskRefinedResponseSchema = z.object({ refined: refinedTaskSchema });

export const projectStateSchema = z.enum([
  'absent',
  'cloning',
  'container_starting',
  'active',
  'failed',
]);
export type ProjectState = z.infer<typeof projectStateSchema>;

const sandboxUpdateSchema = z.object({
  state: z.enum(['current', 'available', 'unknown']),
  kind: z.enum(['normal', 'security']).nullable(),
  category: z.enum(['software', 'security', 'configuration']).nullable(),
  reason: z.string().nullable(),
  current: z.string().nullable(),
  target: z.string().nullable(),
  currentVersion: z.string().nullable(),
  currentRevision: z.string().nullable(),
  targetVersion: z.string().nullable(),
  targetRevision: z.string().nullable(),
  // Whether Verity's own recreate is still expected to close this gap.
  // `state: 'available'` alone is the normal state of the entire fleet for the
  // first minute after every Server update — the relay reconciler rebuilds each
  // sandbox onto the current image — so only `stalled` is worth surfacing.
  // Defaulted rather than required: a Server one release behind this app does not
  // send the field, and reading that as "converging" is exactly right (it is a
  // Server that still reconciles, it just cannot report the verdict).
  selfRepair: z.enum(['converging', 'stalled']).default('converging'),
});
export type SandboxUpdate = z.infer<typeof sandboxUpdateSchema>;

/** Whether the project's recorded runner-boundary attestation was made against
 *  the toolkit this Server ships (`packages/server/src/toolkit-drift.ts`).
 *
 *  `unknown` is NOT a synonym for `matches` — it means the comparison could not
 *  be made at all. `carrier` decides the remedy and is the reason the two
 *  populations are never merged into one number: a `devcontainer` image is
 *  rebuilt and re-attested by re-provisioning, while a `base-image` project
 *  needs a new base image, which no Verity action produces. */
const toolkitDriftSchema = z.object({
  verdict: z.enum(['matches', 'drifted', 'unknown']),
  carrier: z.enum(['devcontainer', 'base-image']),
});
export type ToolkitDrift = z.infer<typeof toolkitDriftSchema>;

/** Cached GitHub-installation repo plus Verity-side container lifecycle state (#174). */
export const projectRecordSchema = z.object({
  id: z.string().min(1),
  owner: z.string().min(1),
  repo: z.string().min(1),
  containerName: z.string().min(1),
  // `local` = created without a GitHub repository; `owner` is the reserved
  // `local` placeholder, so the UI shows `repo` alone as the project name.
  kind: z.enum(['github', 'control_plane', 'local']).default('github'),
  imageRef: z.string().nullable(),
  state: projectStateSchema,
  archived: z.boolean().optional(),
  provisionError: z.string().nullable(),
  provisionWarning: z.string().nullable().optional(),
  // Lifecycle generation from the server. Unlike `updatedAt`, unrelated repo
  // metadata writers do not bump it, so dropped-request recovery can prove a
  // recreate completed even when it missed the transitional state entirely.
  stateChangedAt: z.string().datetime().optional(),
  // Latest published GitHub release for the overview version badge. All optional
  // + nullable: any of them is null when GitHub isn't configured / the repo has
  // no releases / the lookup hasn't resolved yet, and `optional` tolerates a
  // producer that predates these fields. Today only `latestReleaseTag` is
  // rendered; the rest are carried for a follow-up detail view / link-out.
  latestReleaseTag: z.string().nullable().optional(),
  latestReleaseName: z.string().nullable().optional(),
  latestReleaseUrl: z.string().nullable().optional(),
  latestReleasePublishedAt: z.string().nullable().optional(),
  // Operator's overview fold state, persisted server-side so it syncs across
  // devices. Optional to tolerate a server that predates the field (then the
  // client treats a missing value as expanded).
  collapsed: z.boolean().optional(),
  // True once the repo was explicitly added as a Verity project. Paused projects
  // stay in the overview; unadded GitHub cache rows are picker-only.
  overviewVisible: z.boolean().optional(),
  setupStatus: z.enum(['pending', 'secrets_skipped', 'complete']).optional(),
  sandboxUpdate: sandboxUpdateSchema.optional(),
  // Null whenever the server declines to judge the row (control plane, or any
  // non-active state); optional so a server predating the field still parses.
  toolkitDrift: toolkitDriftSchema.nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ProjectRecord = z.infer<typeof projectRecordSchema>;

/** The result of linking a local project to GitHub. `pullRequest` is present when the
 *  target repository already had history: the project's history rides in on
 *  `importBranch` and is NOT on the default branch until that pull request merges. */
export const linkedProjectSchema = z.object({
  project: projectRecordSchema,
  importBranch: z.string().optional(),
  pullRequest: z.object({ number: z.number(), url: z.string() }).optional(),
  pullRequestError: z.string().optional(),
});
export type LinkedProject = z.infer<typeof linkedProjectSchema>;

export const projectSettingsSchema = z.object({
  projectId: z.string().min(1),
  // Broker-only Doppler mapping. Credentials remain central and never appear in
  // project settings or project containers.
  dopplerProject: z.string().nullable(),
  dopplerConfig: z.string().nullable(),
  defaultBranch: z.string().nullable(),
  defaultModel: z.string().nullable(),
  // Operator-curated agent memory (ADR 0008): plaintext notes injected into every
  // session's runtime system prompt. Optional so a producer predating the field is
  // tolerated; `null` when unset.
  memory: z.string().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ProjectSettings = z.infer<typeof projectSettingsSchema>;

type ProjectSettingsKey = 'defaultBranch' | 'defaultModel' | 'memory';

export type ProjectSettingsPatch = {
  [K in ProjectSettingsKey]?: ProjectSettings[K] | undefined;
} & {
  dopplerProject?: string | null | undefined;
  dopplerConfig?: string | null | undefined;
};

// Agent Loops — recurring script-first automations (ADR 0008). Structured schedule
// (never a raw cron string) so the mobile UI edits fields, not expressions.
export const agentLoopScheduleSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('interval'), everyMinutes: z.number() }),
  z.object({ kind: z.literal('daily'), hour: z.number(), minute: z.number() }),
  z.object({
    kind: z.literal('weekly'),
    weekday: z.number(),
    hour: z.number(),
    minute: z.number(),
  }),
]);
export type AgentLoopSchedule = z.infer<typeof agentLoopScheduleSchema>;

export const agentLoopSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  name: z.string(),
  status: z.enum(['draft', 'enabled', 'paused']),
  schedule: agentLoopScheduleSchema.nullable(),
  script: z.string().nullable(),
  reactionPrompt: z.string().nullable(),
  reactionModel: z.string().nullable(),
  sessionId: z.string().nullable(),
  testedScriptFingerprint: z.string().nullable(),
  consecutiveErrorCount: z.number(),
  lastRunAt: z.string().nullable(),
  lastOutcome: z.enum(['ok', 'acted', 'error', 'skipped']).nullable(),
  nextRunAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type AgentLoop = z.infer<typeof agentLoopSchema>;

/** Stable identity for the complete user-confirmed Agent Loop config. */
export function agentLoopConfigFingerprint(config: {
  name: string;
  script: string | null;
  schedule: AgentLoopSchedule | null;
  reactionPrompt?: string | null;
  reactionModel?: string | null;
}): string {
  return JSON.stringify({
    name: config.name,
    script: config.script,
    schedule: config.schedule,
    reactionPrompt: config.reactionPrompt ?? null,
    reactionModel: config.reactionModel ?? null,
  });
}

export const agentLoopRunSchema = z.object({
  id: z.string(),
  loopId: z.string(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  outcome: z.enum(['ok', 'acted', 'error', 'skipped']),
  exitCode: z.number().nullable(),
  detail: z.string().nullable(),
  sessionId: z.string().nullable(),
  isTest: z.boolean(),
});
export type AgentLoopRun = z.infer<typeof agentLoopRunSchema>;

export interface AgentLoopCreateRequest {
  name: string;
  schedule?: AgentLoopSchedule | null;
  script?: string | null;
  reactionPrompt?: string | null;
  reactionModel?: string | null;
}

export type AgentLoopPatchRequest = Partial<AgentLoopCreateRequest> & {
  status?: 'draft' | 'enabled' | 'paused';
};

const agentLoopResponseSchema = z.object({ loop: agentLoopSchema });
const agentLoopsResponseSchema = z.object({ loops: z.array(agentLoopSchema) });

// Dev servers — one-or-more named preview processes per project.
export const devServerSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  sourceKey: z.string().nullable().default(null),
  name: z.string(),
  command: z.string().nullable(),
  url: z.string().nullable(),
  workdir: z.string().nullable(),
  hostPort: z.string().nullable(),
  containerPort: z.string().nullable(),
  /** Session whose worktree this server previews; null = the main checkout.
   *  Defaulted for servers predating the preview feature. */
  previewSessionId: z.string().nullable().default(null),
  autoStart: z.boolean().default(false),
  running: z.boolean().default(false),
  sortOrder: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type DevServer = z.infer<typeof devServerSchema>;

export interface DevServerCreateRequest {
  sourceKey?: string | null;
  name?: string;
  command?: string | null;
  url?: string | null;
  workdir?: string | null;
  containerPort?: string | null;
  autoStart?: boolean;
  sortOrder?: number;
}
export type DevServerPatchRequest = Omit<DevServerCreateRequest, 'sourceKey'>;

export const publicPreviewShareSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  devServerId: z.string().nullable(),
  targetKind: z.enum(['dev-server', 'static-folder']),
  staticPath: z.string().nullable(),
  state: z.enum(['creating', 'active', 'revoking', 'revoked', 'expired', 'failed']),
  publicOrigin: z.string().url().nullable(),
  expiresAt: z.string(),
  createdAt: z.string(),
  failure: z.string().nullable(),
});
export type PublicPreviewShare = z.infer<typeof publicPreviewShareSchema>;

export interface PublicPreviewShareCreateRequest {
  pin: string;
  ttlSeconds: number;
}

const publicPreviewShareResponseSchema = z.object({ share: publicPreviewShareSchema });
const publicPreviewSharesResponseSchema = z.object({
  shares: z.array(publicPreviewShareSchema),
});

export interface DetectedDevServerSetupRequest {
  fingerprint: string;
  confirmWarnings?: boolean;
  devServers: Array<{
    sourceKey: string;
    name: string;
    command: string;
    workdir: string | null;
    containerPort: string | null;
  }>;
}

export const devServerSuggestionSchema = z.object({
  key: z.string(),
  name: z.string(),
  command: z.string(),
  workdir: z.string().nullable(),
  containerPort: z.string().nullable(),
  confidence: z.enum(['high', 'medium', 'low']),
  evidence: z.string(),
  status: z.enum(['new', 'changed', 'configured', 'missing']).default('new'),
  alreadyConfigured: z.boolean(),
  existingDevServerId: z.string().nullable(),
  existingConfig: z
    .object({
      name: z.string(),
      command: z.string().nullable(),
      workdir: z.string().nullable(),
      containerPort: z.string().nullable(),
    })
    .nullable()
    .default(null),
});
export type DevServerSuggestion = z.infer<typeof devServerSuggestionSchema>;

const devServerResponseSchema = z.object({ devServer: devServerSchema });
const devServersResponseSchema = z.object({ devServers: z.array(devServerSchema) });
const devServerSuggestionsResponseSchema = z.object({
  fingerprint: z.string().optional(),
  detectedAt: z.string().optional(),
  reviewedFingerprint: z.string().nullable().optional(),
  reviewedAt: z.string().nullable().optional(),
  suggestions: z.array(devServerSuggestionSchema),
});
export interface DevServerDetection {
  fingerprint: string | null;
  detectedAt: string | null;
  reviewedFingerprint: string | null;
  reviewedAt: string | null;
  suggestions: DevServerSuggestion[];
}
const devServerDetectionStateSchema = z.object({
  fingerprint: z.string(),
  detectedAt: z.string(),
  reviewedFingerprint: z.string().nullable(),
  reviewedAt: z.string().nullable(),
});
export type DevServerDetectionState = z.infer<typeof devServerDetectionStateSchema>;
const agentLoopRunsResponseSchema = z.object({ runs: z.array(agentLoopRunSchema) });
const agentLoopTestResponseSchema = z.object({
  result: z.object({
    outcome: z.enum(['ok', 'acted', 'error']),
    exitCode: z.number().nullable(),
    detail: z.string().nullable(),
    sessionId: z.string().nullable(),
  }),
  loop: agentLoopSchema,
});
export type AgentLoopTestResult = z.infer<typeof agentLoopTestResponseSchema>;
const agentLoopRunResponseSchema = z.object({
  result: z.object({
    outcome: z.enum(['ok', 'acted', 'error', 'skipped']),
    exitCode: z.number().nullable(),
    detail: z.string().nullable(),
    sessionId: z.string().nullable(),
  }),
  run: agentLoopRunSchema,
  loop: agentLoopSchema,
});
export type AgentLoopRunResult = z.infer<typeof agentLoopRunResponseSchema>;

export const veritySettingsSchema = z.object({
  gitUserName: z.string().nullable(),
  gitUserEmail: z.string().nullable(),
  gitSshPrivateKeyPath: z.string().nullable(),
  gitSshPublicKeyPath: z.string().nullable(),
  gitKnownHostsPath: z.string().nullable(),
  gitAllowedSignersPath: z.string().nullable(),
  gitSshPrivateKeyConfigured: z.boolean(),
  gitSshPublicKeyConfigured: z.boolean(),
  gitKnownHostsConfigured: z.boolean(),
  gitAllowedSignersConfigured: z.boolean(),
  githubAppId: z.string().nullable(),
  githubAppInstallationId: z.string().nullable(),
  githubAppPrivateKeyConfigured: z.boolean(),
  dopplerServiceTokenConfigured: z.boolean(),
  uplinkSubscriptionKeyConfigured: z.boolean(),
  uplinkInstallationId: z.string().nullable(),
  transcribeBaseUrl: z.string().nullable(),
  transcribeModel: z.string().nullable(),
  transcribeBackendMode: z.enum(['local', 'external']).nullable(),
  transcribeApiKeyConfigured: z.boolean(),
  transcribeLocalAvailable: z.boolean(),
  // Whether a remote backend is effectively configured — from the app's own
  // settings or, failing that, the deployment environment, which stores nothing
  // here. Defaulted rather than required so an app talking to a server that
  // predates the field still parses the response, and defaulted to `false`
  // because that is the conservative end: it under-claims readiness instead of
  // promising a backend that would reject the upload.
  transcribeExternalConfigured: z.boolean().default(false),
  claudeCodeOauthCredentialsConfigured: z.boolean(),
  codexAuthJsonConfigured: z.boolean(),
  // Google Drive connection (ADR 0009). The client id + account email are
  // non-secret; `googleDriveConnected` reflects whether a refresh token is held.
  googleDriveClientId: z.string().nullable(),
  googleDriveAccountEmail: z.string().nullable(),
  googleDriveConnected: z.boolean(),
  advancedModeEnabled: z.boolean().default(false),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type VeritySettings = z.infer<typeof veritySettingsSchema>;

// Managed self-update (ADR 0008 D4). The server projects the privileged update
// journal down to this closed shape; the app must not widen it — an unknown
// state or failure code is a mismatched server, not something to render.
export const serverUpdateOperationSchema = z.object({
  updateId: z.string().min(1),
  state: z.enum([
    'preparing',
    'prepared',
    'activating',
    'completed',
    'rolling-back',
    'rolled-back',
    'failed',
  ]),
  phase: z.string().min(1),
  step: z.number().int().positive(),
  totalSteps: z.number().int().positive(),
  generation: z.number().int().positive(),
  previousDigest: z.string().min(1),
  targetDigest: z.string().min(1),
  failureCode: z.string().min(1).nullable(),
  startedAt: z.string().min(1),
  updatedAt: z.string().min(1),
});
export type ServerUpdateOperation = z.infer<typeof serverUpdateOperationSchema>;

const serverReleaseSchema = z.object({
  version: z.string().min(1),
  serverImage: z.string().min(1),
  publishedAt: z.string().min(1),
});

export const serverUpdateStatusSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('unsupported'), reason: z.string() }),
  z.object({ state: z.literal('current'), release: serverReleaseSchema }),
  z.object({ state: z.literal('available'), release: serverReleaseSchema }),
  z.object({
    state: z.literal('incompatible'),
    release: serverReleaseSchema,
    reasons: z.array(z.string()),
  }),
  z.object({ state: z.literal('unreachable'), reason: z.string() }),
]);
export type ServerUpdateStatus = z.infer<typeof serverUpdateStatusSchema> & {
  operation: ServerUpdateOperation | null;
};

const serverUpdateEnvelopeSchema = z.object({
  operation: serverUpdateOperationSchema.nullable(),
});
const serverUpdateAcceptedSchema = z.object({ operation: serverUpdateOperationSchema });

export const meetingTranscriptionBackendStatusSchema = z.object({
  transcribeBackendMode: z.enum(['local', 'external']).nullable(),
  transcribeBaseUrl: z.string().nullable(),
  transcribeModel: z.string().nullable(),
  transcribeApiKeyConfigured: z.boolean(),
  transcribeLocalAvailable: z.boolean(),
  // The server's own verdict on whether meeting audio has anywhere to go. It is
  // not implied by the URL and model above: a deployment can supply its own
  // transcriber command, which reports neither and still works. Defaulted for
  // the same version-skew reason as on the settings record, and to the same
  // conservative end.
  transcribeExternalConfigured: z.boolean().default(false),
});
export type MeetingTranscriptionBackendStatus = z.infer<
  typeof meetingTranscriptionBackendStatusSchema
>;

// ── Google Drive sources (ADR 0009) ──────────────────────────────────────────
export const driveFileSchema = z.object({
  id: z.string(),
  name: z.string(),
  mimeType: z.string(),
  modifiedTime: z.string().optional(),
  size: z.string().optional(),
  iconLink: z.string().optional(),
});
export type DriveFile = z.infer<typeof driveFileSchema>;

/** A native Google editor file (Doc/Sheet/Slides) — exported to a text-first
 *  format on import. Folders are `application/vnd.google-apps.folder`. */
export const DRIVE_FOLDER_MIME = 'application/vnd.google-apps.folder';
export const isDriveFolder = (file: DriveFile): boolean => file.mimeType === DRIVE_FOLDER_MIME;

export const driveFileListSchema = z.object({
  files: z.array(driveFileSchema),
  nextPageToken: z.string().optional(),
});
export type DriveFileList = z.infer<typeof driveFileListSchema>;

export const googleDriveConnectResultSchema = z.object({
  connected: z.literal(true),
  accountEmail: z.string().nullable(),
});

export const googleDriveImportResultSchema = z.object({
  path: z.string(),
  name: z.string(),
});
export type GoogleDriveImportResult = z.infer<typeof googleDriveImportResultSchema>;

type VeritySettingsKey =
  | 'advancedModeEnabled'
  | 'gitUserName'
  | 'gitUserEmail'
  | 'gitSshPrivateKeyPath'
  | 'gitSshPublicKeyPath'
  | 'gitKnownHostsPath'
  | 'gitAllowedSignersPath'
  | 'githubAppId'
  | 'githubAppInstallationId'
  | 'transcribeBaseUrl'
  | 'transcribeModel'
  | 'transcribeBackendMode';

export type VeritySettingsPatch = {
  [K in VeritySettingsKey]?: VeritySettings[K] | undefined;
} & {
  gitSshPrivateKey?: string | null | undefined;
  gitSshPublicKey?: string | null | undefined;
  gitKnownHosts?: string | null | undefined;
  gitAllowedSigners?: string | null | undefined;
  githubAppPrivateKey?: string | null | undefined;
  dopplerServiceToken?: string | null | undefined;
  uplinkSubscriptionKey?: string | null | undefined;
  transcribeApiKey?: string | null | undefined;
  codexAuthJson?: string | null | undefined;
};

export const agentLoginProviderSchema = z.enum(['claude', 'codex']);
export type AgentLoginProvider = z.infer<typeof agentLoginProviderSchema>;
export const agentLoginSchema = z.object({
  sessionId: z.string().min(1),
  provider: agentLoginProviderSchema,
  status: z.enum(['starting', 'ready', 'waiting', 'complete', 'failed']),
  verificationUri: z.string().nullable(),
  userCode: z.string().nullable(),
  needsCode: z.boolean(),
  configured: z.boolean(),
  message: z.string().nullable(),
});
export type AgentLogin = z.infer<typeof agentLoginSchema>;
const agentLoginResponseSchema = z.object({ login: agentLoginSchema });

/** State of the at-rest secret store (master-password unlock). `uninitialized`
 *  = no password set yet (first-run onboarding); `sealed` = set but locked
 *  (needs /secret/unlock after a restart); `unlocked` = key loaded; `unmanaged`
 *  = the deployment does not manage a cipher. */
export const secretStatusSchema = z.object({
  status: z.enum(['unlocked', 'sealed', 'uninitialized', 'unmanaged']),
});
export type SecretStatus = z.infer<typeof secretStatusSchema>['status'];

/** The server's `GET /healthz` — a pre-auth liveness probe that also carries the
 *  server's own release version (baked into the deploy image, `-dev` on
 *  dev/PR/local builds). `version` is OPTIONAL for back-compat: an older server
 *  that predates capability reporting may return only `{ status: 'ok' }`. */
export const healthSchema = z.object({
  status: z.literal('ok'),
  version: z.string().min(1).optional(),
  /** ADR 0008 token registration is deployment-gated. Optional so a new app
   * connected to an older server safely treats push as unavailable. */
  pushEnabled: z.boolean().optional(),
  /** Temporary external sharing is deployment-gated. */
  publicPreviewsEnabled: z.boolean().optional(),
  /** Whether the server honours `forceRebuild` on recreate-container. The app
   *  ships on its own release train and can outrun the server, and the recreate
   *  body schema is non-strict — an older server silently STRIPS the flag and
   *  recreates from the cached image, so the operator waits out a "rebuild"
   *  that rebuilt nothing. Absent → treat as unsupported and hide the action. */
  imageRebuildSupported: z.boolean().optional(),
});
export type Health = z.infer<typeof healthSchema>;

/** First-run onboarding gate (#320): the server's `GET /onboarding/status`. Each
 *  flag is derived from a NON-decrypting store read, so the endpoint (and this
 *  client method) work while the secret store is still sealed — it IS the gate.
 *  `nextStep` is the first incomplete REQUIRED step (Doppler is optional and never
 *  appears), or `null` once `complete`. */
export const onboardingStatusSchema = z.object({
  sealed: z.boolean(),
  masterPasswordSet: z.boolean(),
  githubAppConfigured: z.boolean(),
  signingKeyConfigured: z.boolean(),
  hasProject: z.boolean(),
  /** INFORMATIONAL: an account-level Doppler token is present. Doppler is optional
   *  so this never appears in `nextStep` and never gates `complete`. */
  dopplerConfigured: z.boolean(),
  /** INFORMATIONAL: a Claude Code / Codex subscription login is stored. Optional
   *  (a deployment may use a config volume instead), so neither gates `complete`. */
  claudeConfigured: z.boolean(),
  codexConfigured: z.boolean(),
  complete: z.boolean(),
  nextStep: z.enum(['master-password', 'github', 'first-project']).nullable(),
});
export type OnboardingStatus = z.infer<typeof onboardingStatusSchema>;

/** Result of `POST /github/app/validate` (#320, onboarding): a live check that the
 *  stored GitHub-App creds actually mint a token. `ok` gates the wizard's GitHub
 *  step. `accountLogin` is a SAFE confirmation handle on success; `error` is a
 *  redacted failure message (`'locked'` when the store is sealed, `'not configured'`
 *  when creds are missing). The server NEVER returns the token or PEM here. */
export const githubAppValidateSchema = z.object({
  ok: z.boolean(),
  accountLogin: z.string().optional(),
  error: z.string().optional(),
});
export type GithubAppValidateResult = z.infer<typeof githubAppValidateSchema>;

/** Response of `POST /github/app/manifest/prepare`: the single-use token that
 *  authenticates the browser-opened manifest `start` flow (audit C1 follow-up). */
export const manifestPrepareSchema = z.object({ startToken: z.string().min(1) });

/** Result of `POST /doppler/validate` (#320, onboarding — OPTIONAL step): a live
 *  check that the stored Doppler Service Account token actually lists projects.
 *  `ok` confirms the token works. `projectCount` is a SAFE confirmation integer on
 *  success; `error` is a redacted failure message (`'locked'` when the store is
 *  sealed, `'not configured'` when the token is missing). The server NEVER returns
 *  the token here. */
export const dopplerValidateSchema = z.object({
  ok: z.boolean(),
  projectCount: z.number().optional(),
  error: z.string().optional(),
});
export type DopplerValidateResult = z.infer<typeof dopplerValidateSchema>;

/** A single Doppler project in the binding picker (#320, `GET /doppler/projects`).
 *  `slug` is the stable identifier the mapping PATCH uses as `dopplerProject`; `name`
 *  is the display label. NON-secret. */
export const dopplerProjectSummarySchema = z.object({
  slug: z.string(),
  name: z.string(),
});
export type DopplerProjectSummary = z.infer<typeof dopplerProjectSummarySchema>;

/** A single Doppler config in the binding picker (#320, `GET /doppler/configs`).
 *  `name` is what the mapping PATCH uses as `dopplerConfig`; `environment` / `root`
 *  let the UI group root vs branch configs (deferred). NON-secret. */
export const dopplerConfigSummarySchema = z.object({
  name: z.string(),
  environment: z.string().optional(),
  root: z.boolean().optional(),
});
export type DopplerConfigSummary = z.infer<typeof dopplerConfigSummarySchema>;

/** Result of `GET /doppler/projects` (#320, binding picker): the account's Doppler
 *  projects from the TRUSTED account token (server-side; NOT repo content), or a
 *  redacted `{ error }` envelope. `error: 'locked'` = the store is sealed;
 *  `'not configured'` = no account token. The token is NEVER on the wire. */
export const dopplerProjectsResultSchema = z.union([
  z.object({ projects: z.array(dopplerProjectSummarySchema) }),
  z.object({ error: z.string() }),
]);
export type DopplerProjectsResult = z.infer<typeof dopplerProjectsResultSchema>;

/** Result of `GET /doppler/configs?project=<project>` (#320, binding picker): the
 *  project's configs from the TRUSTED account token, or a redacted `{ error }`
 *  envelope (`'locked'` / `'not configured'` / `'project is required'`). */
export const dopplerConfigsResultSchema = z.union([
  z.object({ configs: z.array(dopplerConfigSummarySchema) }),
  z.object({ error: z.string() }),
]);
export type DopplerConfigsResult = z.infer<typeof dopplerConfigsResultSchema>;

/** Result of `POST /settings/signing-key/generate` (#320, onboarding): the server
 *  generated an ed25519 signing keypair, stored the PRIVATE key encrypted, and
 *  returns ONLY the public material. `publicKey` is the OpenSSH pubkey line the
 *  operator adds to GitHub as a Signing Key; `allowedSigners` is the derived
 *  `allowed_signers` entry. `error: 'locked'` = the store is sealed (unlock
 *  first). The PRIVATE key is NEVER on the wire. */
export const signingKeyGenerateSchema = z.object({
  ok: z.boolean(),
  publicKey: z.string().optional(),
  allowedSigners: z.string().optional(),
  error: z.string().optional(),
});
export type SigningKeyGenerateResult = z.infer<typeof signingKeyGenerateSchema>;

/** Result of `GET /settings/signing-key`: the CURRENT signing public key (public
 *  material, so it is returned even while the store is sealed) for re-display in
 *  Settings — e.g. to register it on GitHub as a Signing Key. `configured` is
 *  whether a signing private key (DB contents or a file path) is set. */
export const signingKeySchema = z.object({
  configured: z.boolean(),
  publicKey: z.string().nullable(),
});
export type SigningKeyInfo = z.infer<typeof signingKeySchema>;

export const projectDetailSchema = z.object({
  project: projectRecordSchema,
  settings: projectSettingsSchema.nullable(),
  sessions: z.array(sessionSummarySchema),
});
export type ProjectDetail = z.infer<typeof projectDetailSchema>;

const projectCreatedSchema = z.object({ project: projectRecordSchema });
export type ProjectCreated = z.infer<typeof projectCreatedSchema>;

const projectSettingsResponseSchema = z.object({ settings: projectSettingsSchema });
const veritySettingsResponseSchema = z.object({ settings: veritySettingsSchema.nullable() });
const veritySettingsSavedResponseSchema = z.object({ settings: veritySettingsSchema });
const projectDeletedSchema = z.object({ projectId: z.string().min(1) });
export type ProjectDeleted = z.infer<typeof projectDeletedSchema>;

export const projectRuntimeStartedSchema = z.object({
  projectId: z.string().min(1),
  url: z.string().nullable(),
  running: z.boolean(),
  pid: z.string().nullable(),
});
export type ProjectRuntimeStarted = z.infer<typeof projectRuntimeStartedSchema>;

export const projectRuntimeLogsSchema = z.object({
  projectId: z.string().min(1),
  logs: z.string(),
});
export type ProjectRuntimeLogs = z.infer<typeof projectRuntimeLogsSchema>;

export const projectRuntimeHealthSchema = z.object({
  projectId: z.string().min(1),
  url: z.string().nullable(),
  reachable: z.boolean(),
  status: z.number().int().nullable(),
  checkedAt: z.string(),
  error: z.string().nullable(),
});
export type ProjectRuntimeHealth = z.infer<typeof projectRuntimeHealthSchema>;

const projectRuntimeResponseSchema = z.object({ runtime: projectRuntimeStartedSchema });
const projectRuntimeLogsResponseSchema = z.object({ logs: projectRuntimeLogsSchema });
const projectRuntimeHealthResponseSchema = z.object({ health: projectRuntimeHealthSchema });
// Declared after projectRuntimeStartedSchema (const, no hoisting): the preview
// switch restarts a running server and then carries its runtime in the response.
const devServerPreviewResponseSchema = z.object({
  devServer: devServerSchema,
  runtime: projectRuntimeStartedSchema.optional(),
});
export type DevServerPreviewResult = z.infer<typeof devServerPreviewResponseSchema>;
const conciergeTokenRefreshResponseSchema = z.object({
  projectId: z.string().min(1),
  refreshedAt: z.string(),
});
export type ConciergeTokenRefresh = z.infer<typeof conciergeTokenRefreshResponseSchema>;

/** One persisted event tagged with its monotonic seq (matches the WS frame), plus
 * its real persist time `ts` (the store row's `created_at`, epoch milliseconds —
 * same unit as the WS frame, #32). `ts` is OPTIONAL on the wire for back-compat
 * with an older server that doesn't surface it; absent → the reducer falls back to
 * `seq` for `createdAt`. */
export const sequencedEventSchema = z.object({
  seq: z.number().int().nonnegative(),
  ts: z.number().int().nonnegative().optional(),
  event: agentEventSchema,
});
/** A backward page of history (from `GET /sessions/:id/events`): the newest
 * `limit` events (ascending) plus whether still-older events exist. Lets the app
 * open a long session with only its tail instead of replaying the whole log. */
export const sessionHistorySchema = z.object({
  events: z.array(sequencedEventSchema),
  hasMore: z.boolean(),
});
export type SessionHistoryPage = z.infer<typeof sessionHistorySchema>;

const turnResponseSchema = z.object({
  sessionId: z.string().min(1),
  accepted: z.literal(true),
  /** True when the turn was QUEUED behind an in-flight one (it runs when the
   * current turn settles) rather than dispatched immediately (#90). OPTIONAL on
   * the wire so an app newer than the server still parses (absent → not queued). */
  queued: z.boolean().optional(),
});
export type TurnAccepted = z.infer<typeof turnResponseSchema>;

const sessionCreatedSchema = z.object({
  sessionId: z.string().min(1),
  /** Set when the call was answered from an existing session rather than minting
   * one — the idempotent reply to a repeated {@link SpawnRequest.sessionId}. A
   * caller that follows a create with a prepared first turn uses it to know the
   * turn was already sent by the run that did mint the session. */
  existing: z.literal(true).optional(),
});
export type SessionCreated = z.infer<typeof sessionCreatedSchema>;

const sessionAwaitingProvisioningSchema = z.object({
  awaitingProvisioning: z.literal(true),
  project: projectRecordSchema,
});
export type SessionAwaitingProvisioning = z.infer<typeof sessionAwaitingProvisioningSchema>;
export type SessionCreateResult = SessionCreated | SessionAwaitingProvisioning;

/** Response of `POST /sessions/:id/cancel` (#79): `cancelled` is false when the
 * session was idle (nothing to stop) — a harmless no-op, not an error. */
const turnCancelledSchema = z.object({
  sessionId: z.string().min(1),
  cancelled: z.boolean(),
  /** Whether a `force` request actually lifted an unconfirmed-termination fence.
   * False both when none was held and — via the default — when talking to a server
   * that predates the flag, so the caller cannot mistake an old server's silence for
   * a successful override. */
  forceReleased: z.boolean().optional().default(false),
  droppedQueued: z
    .array(
      z.object({
        id: z.string().min(1),
        prompt: z.string(),
        attachments: z.array(attachmentUploadSchema).optional(),
      }),
    )
    .optional()
    .default([]),
});
export type TurnCancelled = z.infer<typeof turnCancelledSchema>;

/** Response of `POST /sessions/:id/queue/:itemId/cancel` (#80): the retracted
 * turn's prompt, so the app can put it back in the input to edit/resend. A 404
 * (the item already drained/retracted) throws a {@link VerityApiError}. */
const queuedTurnCancelledSchema = z.object({
  sessionId: z.string().min(1),
  itemId: z.string().min(1),
  prompt: z.string(),
  attachments: z.array(attachmentUploadSchema).optional(),
});
export type QueuedTurnCancelled = z.infer<typeof queuedTurnCancelledSchema>;

/** Body for `POST /sessions/:id/permissions/:toolUseId` (#149/#27): the operator's
 * mid-turn allow/deny answer for the parked tool. `allow` may carry an edited
 * `updatedInput` (the tool runs with it); `deny` may carry a `message` shown to the
 * model as the rejection reason. A per-tool RUNTIME decision, never a bypass of the
 * §5b permission invariants. Mirrors the server's `permissionDecisionBody`. */
export type PermissionDecision =
  | {
      behavior: 'allow';
      updatedInput?: Record<string, unknown>;
      /** ADR 0011 D2 (brokered secret tools): persist the allow as a scoped grant —
       * 'session', 'project' (30 days) or 'forever' auto-approves matching future
       * requests for the same (alias, tool, target). Absent = once. */
      scope?: 'once' | 'session' | 'project' | 'forever';
    }
  | { behavior: 'deny'; message?: string };

/** One standing grant from `GET /projects/:id/secret-grants`. `target` is the destination
 * host for `verity_http_request`, or an executable label plus the digest of the exact
 * approved invocation for `verity_secret_run`. `expiresAt` is null for 'session' (dies with
 * its session) and for 'forever' (ends only via {@link VerityApi.revokeSecretGrant}).
 * `appliesNow` is false when the grant names a provider binding the project has replaced:
 * dormant rather than dead, since restoring that binding revives it — so it is shown for
 * revocation instead of being hidden. */
const secretGrantSchema = z.object({
  id: z.string().min(1),
  secretAlias: z.string().min(1),
  toolName: z.enum(['verity_http_request', 'verity_secret_run']),
  target: z.string(),
  scope: z.enum(['session', 'project', 'forever']),
  sessionId: z.string().nullable(),
  appliesNow: z.boolean(),
  expiresAt: z.string().nullable(),
  createdAt: z.string(),
});
export type SecretGrant = z.infer<typeof secretGrantSchema>;
const secretGrantsResponseSchema = z.object({ grants: z.array(secretGrantSchema) });

/** Response of `POST /sessions/:id/permissions/:toolUseId`: `decided: true` when a
 * matching parked prompt was resolved. A 404 (no pending prompt under that id — the
 * turn already ended / the operator already answered / unknown id) throws a
 * {@link VerityApiError} the caller treats as "prompt already stale". */
const permissionDecidedSchema = z.object({
  sessionId: z.string().min(1),
  toolUseId: z.string().min(1),
  decided: z.literal(true),
  /** Present for scoped allows. False means the request was allowed but the
   * reusable grant could not be saved, so the request must not be retried. */
  scopeSaved: z.boolean().optional(),
});
export type PermissionDecided = z.infer<typeof permissionDecidedSchema>;

/** Response of `GET /sessions/:id/branches`: the worktree's current branch, the
 * local branches it can switch to (#91), and the pushed `origin/*` branches it can
 * PREVIEW live (#122 — incl. ones a sibling worktree is developing). `previewable`
 * is OPTIONAL on the wire so an app newer than the server still parses (absent →
 * no preview rows). */
export const branchListSchema = z.object({
  current: z.string(),
  switchable: z.array(z.string()),
  previewable: z.array(z.string()).optional(),
  // True when the session record/history still exists but its workspace was
  // intentionally cleaned up after merge/archive. Branch controls should go inert
  // without surfacing a transport error.
  workspaceMissing: z.boolean().optional(),
  // The open PR number for the CURRENT branch, looked up from GitHub (#125). `null`
  // = looked up, no open PR; ABSENT = the server is older OR GitHub isn't configured
  // (no token/remote) — both render as "no PR chip", independent of the issue chip.
  currentPr: z.number().int().positive().nullable().optional(),
  pullRequest: z
    .object({
      number: z.number().int().positive(),
      title: z.string(),
      url: z.string(),
      phase: z.enum(['open', 'merged', 'closed']),
      updatedAt: z.string().optional(),
      headSha: z.string().optional(),
      pipeline: z.enum(['pending', 'running', 'success', 'failure', 'unknown']),
      checks: z.object({
        completed: z.number().int().nonnegative(),
        total: z.number().int().nonnegative(),
        successful: z.number().int().nonnegative(),
        failed: z.number().int().nonnegative(),
        pending: z.number().int().nonnegative(),
      }),
      // Tri-state; see sessionPrSchema.mergeable. null = unknown, not "blocked".
      mergeable: z.boolean().nullable().catch(null),
      // See sessionPrSchema.mergeState — `'dirty'` drives the conflict UI.
      mergeState: mergeStateSchema,
      // The PR's base branch, so the conflict line can name it ("conflicts with main").
      baseRef: z.string().min(1).optional(),
    })
    .nullable()
    .optional(),
  // The project repo's GitHub `owner`/`repo` (#161), from the server's `origin`-remote
  // parse — lets the header build tappable Issue/PR chip URLs. Both OPTIONAL: ABSENT =
  // older server OR no GitHub remote, in which case the chips stay non-tappable rather
  // than linking to a broken URL. They travel together (the server sets both or
  // neither), but each is independently optional for forward/back-compat.
  owner: z.string().min(1).optional(),
  repo: z.string().min(1).optional(),
  // Present ONLY for a project without a GitHub repository, where there is no pull
  // request to merge: `base` names the branch this session's work can be merged into
  // locally. ABSENT = merging goes through the PR strip (or the server is older).
  localMerge: z.object({ base: z.string().min(1) }).optional(),
});
export type BranchList = z.infer<typeof branchListSchema>;

const pullRequestMergedSchema = z.object({ merged: z.literal(true) });
export type PullRequestMerged = z.infer<typeof pullRequestMergedSchema>;

const localMergedSchema = z.object({
  merged: z.literal(true),
  base: z.string().min(1),
  branch: z.string().min(1),
});
export type LocalMerged = z.infer<typeof localMergedSchema>;

/** Response of `GET /models` (#143): the currently usable model ids for the
 * picker, plus the spawn `default` when at least one model is usable. Claude and
 * Codex are present only when their subscription login is configured in Verity. */
export const modelListSchema = z.object({
  models: z.array(z.string().min(1)),
  modelOrder: z.array(z.string().min(1)).optional(),
  moreModels: z.array(z.string().min(1)).optional(),
  default: z.string().min(1).optional(),
});
export type ModelList = z.infer<typeof modelListSchema>;

/** Response of `POST /sessions/:id/branch`: the branch now checked out. */
export const branchSwitchedSchema = z.object({ branch: z.string() });
export type BranchSwitched = z.infer<typeof branchSwitchedSchema>;

export const sessionFileEntrySchema = z.object({
  name: z.string(),
  path: z.string(),
  kind: z.enum(['directory', 'file', 'symlink', 'other']),
  size: z.number().int().nonnegative().nullable(),
  modifiedAt: z.string().nullable(),
});
export type SessionFileEntry = z.infer<typeof sessionFileEntrySchema>;

export const sessionDirectorySchema = z.object({
  path: z.string(),
  entries: z.array(sessionFileEntrySchema),
  truncated: z.boolean(),
});
export type SessionDirectory = z.infer<typeof sessionDirectorySchema>;

export const sessionFileContentSchema = z.object({
  path: z.string(),
  content: z.string(),
  size: z.number().int().nonnegative(),
});
export type SessionFileContent = z.infer<typeof sessionFileContentSchema>;

export const sessionFileUploadedSchema = z.object({
  path: z.string(),
  size: z.number().int().nonnegative(),
});
export type SessionFileUploaded = z.infer<typeof sessionFileUploadedSchema>;

/** Body for `POST /sessions/:id/branch`. Exactly one of: `branch` (switch to an
 * existing local branch), `newBranch` (create one off the base), or `preview` (a
 * pushed branch checked out DETACHED at `origin/<preview>`, #122). `onDirty`
 * decides what to do with uncommitted changes (default server-side is `block`). */
export interface BranchSwitchRequest {
  newBranch?: string;
  branch?: string;
  preview?: string;
  onDirty?: 'block' | 'stash' | 'commit';
}

const sessionRenamedSchema = z.object({
  sessionId: z.string().min(1),
  name: z.string().nullable(),
});
export type SessionRenamed = z.infer<typeof sessionRenamedSchema>;

const sessionModelSwitchedSchema = z.object({
  sessionId: z.string().min(1),
  model: z.string().min(1),
  // Optional on the wire for rolling compatibility with an older server, where a
  // successful response always meant the switch was immediate.
  deferred: z.boolean().optional().default(false),
});
export type SessionModelSwitched = z.infer<typeof sessionModelSwitchedSchema>;

/** Ack for `PATCH /sessions/:id/seen` (#387): the server-resolved monotonic mark.
 * The client discards it (the synced value arrives on the next `GET /sessions`); it
 * exists so the write can surface a 404 and confirm the persisted count. */
const sessionSeenSchema = z.object({
  sessionId: z.string().min(1),
  lastSeenEventCount: z.number().int().nonnegative().nullable(),
});
export type SessionSeen = z.infer<typeof sessionSeenSchema>;

const sessionDeletedSchema = z.object({ sessionId: z.string().min(1) });
export type SessionDeleted = z.infer<typeof sessionDeletedSchema>;

/** Body for `POST /sessions` (create an empty session/worktree). `name` both seeds the worktree
 * branch (`agent/<slug>-<id>`) AND is persisted as the session's display name
 * (renamable later via {@link VerityClient.renameSession}). `prompt` is optional
 * draft/branch context; the LLM starts on the first turn, not at session create. */
export interface SpawnRequest {
  prompt?: string;
  name?: string;
  model?: string;
  permissionMode?: string;
  /**
   * The session id to create, minted by the caller (a UUID). Lets the app open the
   * chat the instant the operator asks for a session instead of waiting out the
   * worktree provisioning — it already knows the id it will get. The server treats
   * the call as idempotent on this id: repeating it returns the existing session
   * rather than provisioning a second worktree, so a retry after a timeout is
   * safe. Omit to let the server mint one.
   */
  sessionId?: string;
  /** Canonical `<owner>/<repo>` or accepted GitHub URL form for multi-repo sessions (#174). */
  project?: string;
  /** Stable fleet-registry identity; preferred when the caller already has the
   * project record and required for projects without a GitHub identity. */
  projectId?: string;
  /** Explicitly continue provisioning after the server returned confirmable project warnings. */
  confirmProvisionWarnings?: boolean;
  /** Spawn-from-issue (#137): the GitHub issue # this session works on. The server
   * names the worktree branch `feat/<issue>-…` so the new session's header shows
   * `Issue #N`. */
  issue?: number;
}

export const workflowStepSchema = z.object({
  id: z.string(),
  ordinal: z.number().int().nonnegative(),
  kind: z.string(),
  state: z.enum([
    'pending',
    'ready',
    'dispatching',
    'running',
    'result_submitted',
    'waiting_for_gate',
    'completed',
    'retryable_failed',
    'permanently_failed',
    'cancelled',
  ]),
  attempt: z.number().int().nonnegative(),
  maxAttempts: z.number().int().positive(),
  targetProjectId: z.string().nullable(),
  completionGate: z.string(),
});

export const workflowSchema = z.object({
  id: z.string(),
  version: z.number().int().positive(),
  state: z.enum([
    'draft',
    'awaiting_authorization',
    'running',
    'awaiting_decision',
    'blocked',
    'succeeded',
    'failed',
    'cancelled',
    'rolled_back',
  ]),
  objective: z.string(),
  environment: z.string(),
  serviceId: z.string(),
  steps: z.array(workflowStepSchema),
});
export type Workflow = z.infer<typeof workflowSchema>;

export interface CreateWorkflowRequest {
  idempotencyKey: string;
  controlProjectId: string;
  rootSessionId?: string;
  objective: string;
  environment: string;
  serviceId: string;
}

/** Body for `POST /projects`. Two shapes: an existing GitHub repository as
 * `owner/repo` (plus the GitHub URL forms the server canonicalises through its
 * shared project parser), or a project with NO GitHub repository behind it,
 * which {@link VerityClient.linkProjectToGitHub} can connect to one later. */
export type CreateProjectRequest =
  | { repo: string; kind?: 'github'; imageRef?: string | null }
  | { kind: 'local'; name: string; imageRef?: string | null };

/** Body for `POST /devices/:id/push-token`: registers this device's Expo push
 * token so the server can fan out notifications to it. iOS only for v1 — the
 * server rejects any other `platform` (Android/FCM is a follow-up). */
export interface DevicePushTokenRequest {
  /** An Expo push token, e.g. `ExponentPushToken[xxxxxxxx]`. */
  expoToken: string;
  platform: 'ios';
}

/** Response of `POST /devices/:id/push-token`. */
const devicePushTokenRegisteredSchema = z.object({ registered: z.literal(true) });
export type DevicePushTokenRegistered = z.infer<typeof devicePushTokenRegisteredSchema>;

/** Body for `POST /sessions/:id/turns`. */
export interface TurnRequest {
  prompt: string;
  permissionMode?: string;
  model?: string;
  timeoutMs?: number;
  allowedTools?: string[];
  disallowedTools?: string[];
  /** Backend-neutral image uploads (v1, raw base64) sent with the turn. A turn may
   * be attachments-only (empty `prompt`). The server stores them and the persisted
   * `prompt` event references them by id. */
  attachments?: AttachmentUpload[];
  /** Client-minted idempotency key (ADR 0008). Set it for a quick reply that may be
   * re-flushed from the push outbox after the app was suspended before the 202, so
   * the server dedupes the replay instead of dispatching a second turn. */
  clientReplyId?: string;
}

export interface MeetingTranscriptUpload {
  fileName: string;
  mediaType: string;
  /** File-backed Blob on mobile; string remains supported for older callers/tests. */
  data: Blob | string;
  title?: string;
  announceRequest?: boolean;
  /** Correlates the optimistic request bubble with the persisted server notice. */
  clientRequestId?: string;
}

interface BackgroundUploadBlob extends Blob {
  upload(
    url: string,
    options: {
      httpMethod: 'POST';
      headers: Record<string, string>;
      sessionType: 'background';
    },
  ): Promise<{ body: string; status: number }>;
}

const meetingTranscriptCreatedSchema = z.union([
  z.object({ path: z.string(), title: z.string(), segments: z.number().int().nonnegative() }),
  z.object({ accepted: z.literal(true) }),
]);
export type MeetingTranscriptCreated = z.infer<typeof meetingTranscriptCreatedSchema>;

export interface ProjectProvisionOptions {
  confirmWarnings?: boolean;
}

export interface RecreateProjectContainerOptions extends ProjectProvisionOptions {
  /** Rebuild the project's derived devcontainer image rather than reusing the
   *  cached tag. Only the explicit "Rebuild image" action sets this: the
   *  ordinary update recreates the container on the image it already has, which
   *  is what keeps it fast. */
  forceRebuild?: boolean;
}

/** A non-2xx response from the server. `status` lets the UI map 404→not-found,
 * 409→busy, 400→invalid, etc. The `message` is the server's sanitized `error`. */
export class VerityApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    opts: { requiresConfirmation?: boolean; warnings?: string[] } = {},
  ) {
    super(message);
    this.name = 'VerityApiError';
    this.requiresConfirmation = opts.requiresConfirmation === true;
    this.warnings = opts.warnings ?? [];
  }

  readonly requiresConfirmation: boolean;
  readonly warnings: string[];
}

export function isServerSecretSealedError(error: unknown): error is VerityApiError {
  return (
    error instanceof VerityApiError &&
    error.status === 503 &&
    (error.message === 'secret store is sealed' || error.message === 'locked')
  );
}

export interface VerityClientOptions {
  /** Base URL of the control-plane server, no trailing slash (e.g. via Tailscale). */
  baseUrl: string;
  /** Fetch implementation; defaults to the global `fetch` (tests inject a fake). */
  fetch?: typeof fetch;
  /** Fetch implementation used only for native file-backed Blob uploads. Expo apps
   *  inject `expo/fetch`, which streams `expo-file-system` File instances without
   *  coercing them through React Native's legacy fetch bridge. */
  uploadFetch?: typeof fetch;
  /** Allow platform background-upload objects to bypass `uploadFetch`. Disable
   * this when `uploadFetch` enforces transport security such as certificate pinning. */
  allowBackgroundUpload?: boolean;
  /** Supplies the current per-device bearer token for the `Authorization` header
   *  (audit C1). Called PER REQUEST so a token minted or rotated after the client
   *  was constructed is picked up without rebuilding it. Return null/undefined
   *  when there's no token yet — the request goes out unauthenticated (fine for
   *  the pre-auth routes; a gated route then answers 401 and the app re-auths). */
  getToken?: () => string | null | undefined;
  /** Invoked when a GATED route answers 401 (a missing/expired/revoked token),
   *  so the app can drop the stored token and route back to the master-password
   *  screen. NOT fired for the `/secret/*` on-ramp, whose 401 is a wrong-password
   *  signal the unlock UI handles inline. */
  onUnauthorized?: () => void;
}

function uploadBodyWithMimeType(data: Blob): Blob {
  if (data.type === 'application/octet-stream') return data;

  // expo/fetch copies the body Blob's `type` into its native Content-Type
  // header, overriding the one the caller set. Two ways that breaks an upload:
  // expo-file-system's File reports `null` when iOS cannot infer a MIME type,
  // and the native bridge accepts strings only, so the request fails before it
  // is sent; and when iOS *does* infer one, the picked file's own type (a PDF's
  // `application/pdf`, say) replaces the `application/octet-stream` the upload
  // routes are declared with. Always report the binary type both upload
  // endpoints expect — they stream raw bytes and take the real media type from
  // the file name or an explicit header. Preserve the native file object and
  // all of its file-backed methods; native methods are bound to the original
  // host object because Expo host objects can reject a Proxy as their receiver.
  return new Proxy(data, {
    get(target, property) {
      if (property === 'type') return 'application/octet-stream';
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== 'function') return value;
      const boundValue: unknown = value.bind(target);
      return boundValue;
    },
  });
}

/** Response of `POST /secret/init` and `POST /secret/unlock`. `token` +
 *  `tokenId` are present when the server's auth gate is active (a per-device
 *  bearer token to store); absent on an unmanaged/gate-off deployment. */
export const secretUnlockedSchema = z.object({
  status: z.literal('unlocked'),
  token: z.string().min(1).optional(),
  tokenId: z.string().min(1).optional(),
});
export type SecretUnlocked = z.infer<typeof secretUnlockedSchema>;

export const pairingIdentitySchema = z.object({
  serverId: z.string().min(16).max(128),
  identityKey: z.string().min(40).max(128),
  signature: z.string().min(40).max(128),
});
export type PairingIdentity = z.infer<typeof pairingIdentitySchema>;

export const pairingRedeemedSchema = z.object({
  bootstrapToken: z.string().min(32).max(128),
  expiresAt: z.string().datetime(),
});
export type PairingRedeemed = z.infer<typeof pairingRedeemedSchema>;

const streamTicketSchema = z.object({
  ticket: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
  expiresAt: z.string().datetime(),
});
export type StreamTicket = z.infer<typeof streamTicketSchema>;

export interface MobileScrollDiagnostic {
  event: string;
  seq: number;
  at: number;
  data: Record<string, unknown>;
}

export class VerityClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly uploadFetchImpl: typeof fetch;
  private readonly allowBackgroundUpload: boolean;
  private readonly getToken: () => string | null | undefined;
  private readonly onUnauthorized: (() => void) | undefined;

  constructor(opts: VerityClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.fetchImpl = opts.fetch ?? fetch;
    this.uploadFetchImpl = opts.uploadFetch ?? this.fetchImpl;
    this.allowBackgroundUpload = opts.allowBackgroundUpload ?? true;
    this.getToken = opts.getToken ?? ((): undefined => undefined);
    this.onUnauthorized = opts.onUnauthorized;
  }

  async listSessions(): Promise<SessionSummary[]> {
    const res = await this.request('/sessions', { method: 'GET' });
    return z.array(sessionSummarySchema).parse(await res.json());
  }

  /**
   * The session list AND the server-level attention signals, in one request.
   *
   * Separate from {@link listSessions} rather than replacing it: the overview is
   * the only caller that needs the signals, and asking for the envelope is what
   * changes the response shape. Callers that just want sessions (search) keep
   * the array and are unaffected by either side of the rollout.
   */
  async listSessionOverview(): Promise<SessionListEnvelope> {
    const res = await this.request('/sessions?envelope=1', { method: 'GET' });
    return sessionListEnvelopeSchema.parse(await res.json());
  }

  async searchMessages(input: {
    query: string;
    sessionId?: string;
    projectId?: string;
    cursor?: string;
    limit?: number;
  }): Promise<{ items: MessageSearchResult[]; nextCursor: string | null }> {
    const params = new URLSearchParams({ q: input.query });
    if (input.sessionId !== undefined) params.set('sessionId', input.sessionId);
    if (input.projectId !== undefined) params.set('projectId', input.projectId);
    if (input.cursor !== undefined) params.set('cursor', input.cursor);
    if (input.limit !== undefined) params.set('limit', String(input.limit));
    const res = await this.request(`/search/messages?${params.toString()}`, { method: 'GET' });
    return z
      .object({
        items: z.array(messageSearchResultSchema),
        nextCursor: z.string().nullable(),
      })
      .parse(await res.json());
  }

  async listProviderLimits(): Promise<ProviderLimitSummary[]> {
    try {
      const res = await this.request('/provider-limits', { method: 'GET' });
      return z.array(rateLimitStateSchema).parse(await res.json());
    } catch (err) {
      if (err instanceof VerityApiError && (err.status === 404 || err.status === 503)) return [];
      throw err;
    }
  }

  /** The repo's open GitHub issues for the overview backlog (#137). A `503` (GitHub
   * not configured on the server) is NOT an error here — it resolves to `[]` so the
   * overview simply hides the Issues section. Any other failure propagates. */
  async listIssues(): Promise<IssueSummary[]> {
    try {
      const res = await this.request('/issues', { method: 'GET' });
      return z.array(issueSummarySchema).parse(await res.json());
    } catch (err) {
      if (err instanceof VerityApiError && err.status === 503) return [];
      throw err;
    }
  }

  /** The task-management board (ADR 0007): items in rank order with their fields. A
   * `503` (task management not configured on the server) resolves to `null` so the
   * Plan tab hides, exactly like {@link listIssues}. The board is ALSO `null` when the
   * server reached GitHub but the board/owner didn't resolve; any other failure throws. */
  async getTasks(): Promise<TaskBoard | null> {
    try {
      const res = await this.request('/tasks', { method: 'GET' });
      return taskBoardResponseSchema.parse(await res.json()).board;
    } catch (err) {
      if (err instanceof VerityApiError && err.status === 503) return null;
      throw err;
    }
  }

  /** Capture a draft task (the inbox) onto the board. */
  async createTaskDraft(input: { title: string; body?: string }): Promise<TaskItem> {
    const res = await this.request('/tasks/drafts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
    return taskDraftCreatedSchema.parse(await res.json()).item;
  }

  /** Create a real issue and add it to the board. Target repo (the repo picker): a
   * friendly `repo` (`owner/repo`) or an explicit `repositoryId` node id; both omitted
   * defaults server-side to the origin repo. */
  async createTaskIssue(input: {
    title: string;
    body?: string;
    repo?: string;
    repositoryId?: string;
  }): Promise<TaskIssueCreated> {
    const res = await this.request('/tasks/issues', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
    return taskIssueCreatedSchema.parse(await res.json()).issue;
  }

  /** Convert a draft board item into a real issue (default target repo: origin). */
  async convertTaskDraft(
    itemId: string,
    target?: string | { repo?: string; repositoryId?: string },
  ): Promise<TaskDraftConverted> {
    const body =
      typeof target === 'string'
        ? { repositoryId: target }
        : {
            ...(target?.repo !== undefined ? { repo: target.repo } : {}),
            ...(target?.repositoryId !== undefined ? { repositoryId: target.repositoryId } : {}),
          };
    const res = await this.request(`/tasks/${encodeURIComponent(itemId)}/convert`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return taskDraftConvertedSchema.parse(await res.json()).result;
  }

  /** Edit an issue's title/body/state by its node id (`contentId`). */
  async updateTaskIssue(
    issueId: string,
    patch: { title?: string; body?: string; state?: 'OPEN' | 'CLOSED' },
  ): Promise<void> {
    await this.request(`/tasks/issues/${encodeURIComponent(issueId)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    });
  }

  /** Reorder the backlog: move `itemId` to sit right after `afterId` (null/omitted →
   * to the top of the board). */
  async reorderTask(itemId: string, afterId?: string | null): Promise<void> {
    await this.request('/tasks/reorder', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ itemId, afterId: afterId ?? null }),
    });
  }

  /** Remove a Projects v2 item from the board without deleting/closing its content. */
  async removeTaskItem(itemId: string): Promise<void> {
    await this.request(`/tasks/${encodeURIComponent(itemId)}`, { method: 'DELETE' });
  }

  /** Set a single-select field (Priority/Status) on a board item by field + option name
   *  (valid names come from `board.fields`). Throws {@link VerityApiError} (502) on an
   *  unknown field/option or a failed write. */
  async setTaskField(itemId: string, field: string, value: string): Promise<void> {
    await this.request(`/tasks/${encodeURIComponent(itemId)}/field`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ field, value }),
    });
  }

  /** Voice → Refiner (ADR 0007): turn a raw transcript into a structured blueprint via
   * one stateless model query. Throws {@link VerityApiError} (502) when the model reply
   * can't be parsed, or 503 when refinement isn't configured server-side. */
  async refineTask(transcript: string, model?: string): Promise<RefinedTask> {
    const res = await this.request('/tasks/refine', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(model !== undefined ? { transcript, model } : { transcript }),
    });
    return taskRefinedResponseSchema.parse(await res.json()).refined;
  }

  /** Verity projects for the overview. Plain absent GitHub repos are deliberately
   * excluded; paused projects remain listed with `state='absent'`. */
  async listProjects(): Promise<ProjectRecord[]> {
    try {
      const res = await this.request('/projects', { method: 'GET' });
      return z.array(projectRecordSchema).parse(await res.json());
    } catch (err) {
      if (err instanceof VerityApiError && err.status === 503) return [];
      throw err;
    }
  }

  async reorderProjects(ids: string[]): Promise<ProjectRecord[]> {
    const res = await this.request('/projects/order', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids }),
    });
    return z.array(projectRecordSchema).parse(await res.json());
  }

  /** Persist a project's overview fold state so it syncs across devices. Returns
   * the updated project record. */
  async setProjectCollapsed(id: string, collapsed: boolean): Promise<ProjectRecord> {
    const res = await this.request(`/projects/${encodeURIComponent(id)}/collapsed`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ collapsed }),
    });
    return projectRecordSchema.parse(await res.json());
  }

  async setProjectSetupStatus(
    id: string,
    status: 'pending' | 'secrets_skipped' | 'complete',
  ): Promise<ProjectRecord> {
    const res = await this.request(`/projects/${encodeURIComponent(id)}/setup-status`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status }),
    });
    return projectRecordSchema.parse(await res.json());
  }

  /** GitHub-App installation repositories available to add as Verity projects. */
  async listAvailableRepositories(): Promise<ProjectRecord[]> {
    try {
      const res = await this.request('/github/repositories', { method: 'GET' });
      return z.array(projectRecordSchema).parse(await res.json());
    } catch (err) {
      if (err instanceof VerityApiError && err.status === 503) return [];
      throw err;
    }
  }

  async getVeritySettings(): Promise<VeritySettings | null> {
    const res = await this.request('/settings', { method: 'GET' });
    return veritySettingsResponseSchema.parse(await res.json()).settings;
  }

  /** Availability of an official server release plus the live update operation. */
  async getServerUpdates(): Promise<ServerUpdateStatus> {
    const res = await this.request('/server/updates', { method: 'GET' });
    const body: unknown = await res.json();
    return {
      ...serverUpdateStatusSchema.parse(body),
      ...serverUpdateEnvelopeSchema.parse(body),
    };
  }

  /**
   * Start the update to `targetDigest` — which must be the digest the server
   * itself reported as available, so the app can never name an arbitrary image.
   * `idempotencyKey` makes a retry (or a double tap) join the existing operation
   * instead of starting a second one.
   */
  async requestServerUpdate(input: {
    idempotencyKey: string;
    targetDigest: string;
  }): Promise<ServerUpdateOperation> {
    const res = await this.request('/server/updates', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
    return serverUpdateAcceptedSchema.parse(await res.json()).operation;
  }

  async getMeetingTranscriptionBackendStatus(): Promise<MeetingTranscriptionBackendStatus> {
    const res = await this.request('/settings/transcription', { method: 'GET' });
    return meetingTranscriptionBackendStatusSchema.parse(await res.json());
  }

  async updateMeetingTranscriptionBackendMode(mode: 'local' | 'external'): Promise<void> {
    await this.request('/settings/transcription/backend', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode }),
    });
  }

  async updateVeritySettings(patch: VeritySettingsPatch): Promise<VeritySettings> {
    const res = await this.request('/settings', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    });
    return veritySettingsSavedResponseSchema.parse(await res.json()).settings;
  }

  async startAgentLogin(provider: AgentLoginProvider): Promise<AgentLogin> {
    const res = await this.request(`/settings/agent-logins/${provider}/start`, { method: 'POST' });
    return agentLoginResponseSchema.parse(await res.json()).login;
  }

  async getAgentLogin(sessionId: string): Promise<AgentLogin> {
    const res = await this.request(`/settings/agent-logins/${encodeURIComponent(sessionId)}`, {
      method: 'GET',
    });
    return agentLoginResponseSchema.parse(await res.json()).login;
  }

  async disconnectAgentLogin(provider: AgentLoginProvider): Promise<VeritySettings> {
    const res = await this.request('/settings/agent-logins/' + provider, { method: 'DELETE' });
    return veritySettingsSavedResponseSchema.parse(await res.json()).settings;
  }

  /** Browse a Google Drive folder or search the connected Drive (ADR 0009).
   *  Omit `parentId` for My Drive root; pass `query` for a global name search. */
  async listGoogleDriveFiles(params?: {
    parentId?: string;
    query?: string;
    sharedWithMe?: boolean;
    pageToken?: string;
  }): Promise<DriveFileList> {
    const search = new URLSearchParams();
    if (params?.parentId) search.set('parentId', params.parentId);
    if (params?.query) search.set('query', params.query);
    if (params?.sharedWithMe) search.set('sharedWithMe', 'true');
    if (params?.pageToken) search.set('pageToken', params.pageToken);
    const qs = search.toString();
    const res = await this.request(`/google-drive/files${qs.length > 0 ? `?${qs}` : ''}`, {
      method: 'GET',
    });
    return driveFileListSchema.parse(await res.json());
  }

  /** Complete the native OAuth (PKCE) connect: hand the server the one-time code
   *  + verifier + redirect uri; it exchanges them and stores the refresh token. */
  async connectGoogleDrive(input: {
    code: string;
    codeVerifier: string;
    redirectUri: string;
  }): Promise<{ accountEmail: string | null }> {
    const res = await this.request('/google-drive/connect', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
    const parsed = googleDriveConnectResultSchema.parse(await res.json());
    return { accountEmail: parsed.accountEmail };
  }

  async disconnectGoogleDrive(): Promise<void> {
    await this.request('/google-drive/disconnect', { method: 'POST' });
  }

  /** Import a Drive file into the session worktree under docs/reference/. */
  async importGoogleDriveFile(sessionId: string, fileId: string): Promise<GoogleDriveImportResult> {
    const res = await this.request(
      `/sessions/${encodeURIComponent(sessionId)}/google-drive/import`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fileId }),
      },
    );
    return googleDriveImportResultSchema.parse(await res.json());
  }

  async submitAgentLoginCode(sessionId: string, code: string): Promise<AgentLogin> {
    const res = await this.request(
      `/settings/agent-logins/${encodeURIComponent(sessionId)}/submit-code`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code }),
      },
    );
    return agentLoginResponseSchema.parse(await res.json()).login;
  }

  /** Current state of the at-rest secret store (drives the unlock/onboarding UI). */
  async getSecretStatus(): Promise<SecretStatus> {
    const res = await this.request('/secret/status', { method: 'GET' });
    return secretStatusSchema.parse(await res.json()).status;
  }

  /** Pre-auth liveness probe carrying the server's own release version — used to
   *  show which server build the app is talking to. Re-read whenever the settings
   *  screen gains focus so a server update (restart) is reflected without polling. */
  async getHealth(): Promise<Health> {
    const res = await this.request('/healthz', { method: 'GET' });
    return healthSchema.parse(await res.json());
  }

  /** First-run onboarding gate (#320): whether setup is complete and, if not, the
   *  next required step. Sealed-safe on the server, so the app can poll this on
   *  launch before the operator has unlocked/created the master password. */
  async fetchOnboardingStatus(): Promise<OnboardingStatus> {
    const res = await this.request('/onboarding/status', { method: 'GET' });
    return onboardingStatusSchema.parse(await res.json());
  }

  /** Challenge the stable server identity through the already pinned transport. */
  async fetchPairingIdentity(challenge: string): Promise<PairingIdentity> {
    const res = await this.request(`/pair/identity?challenge=${encodeURIComponent(challenge)}`, {
      method: 'GET',
    });
    return pairingIdentitySchema.parse(await res.json());
  }

  /** Exchange the installer secret for the short-lived, one-use password bootstrap. */
  async redeemPairingCode(code: string): Promise<PairingRedeemed> {
    const res = await this.request('/pair/redeem', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    return pairingRedeemedSchema.parse(await res.json());
  }

  /** First-run: set the master password (derives + stores the key, unlocks) and
   *  enroll this device — the response carries a per-device bearer token to store
   *  (audit C1). `deviceLabel` names the device in the server's token registry.
   *  Throws {@link VerityApiError} with status 409 if already set/unlocked. */
  async initSecretPassword(
    password: string,
    deviceLabel?: string,
    pairingBootstrap?: string,
  ): Promise<SecretUnlocked> {
    const res = await this.request('/secret/init', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(pairingBootstrap ? { 'x-verity-pairing': pairingBootstrap } : {}),
      },
      body: JSON.stringify({ password, ...(deviceLabel ? { deviceLabel } : {}) }),
    });
    return secretUnlockedSchema.parse(await res.json());
  }

  /** Unlock the secret store with the master password after a restart and enroll
   *  this device — the response carries a per-device bearer token to store. Throws
   *  {@link VerityApiError} with status 401 on an incorrect password, or 429 when
   *  rate-limited after repeated wrong attempts. */
  async unlockSecret(
    password: string,
    deviceLabel?: string,
    pairingBootstrap?: string,
  ): Promise<SecretUnlocked> {
    const res = await this.request('/secret/unlock', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(pairingBootstrap ? { 'x-verity-pairing': pairingBootstrap } : {}),
      },
      body: JSON.stringify({ password, ...(deviceLabel ? { deviceLabel } : {}) }),
    });
    return secretUnlockedSchema.parse(await res.json());
  }

  /** First-run (#320): live-validate the stored GitHub-App creds by test-minting an
   *  installation token server-side. Requires the secret store unlocked (the PEM
   *  must decrypt). Never carries the token/PEM — `{ ok, accountLogin?, error? }`
   *  only. `error: 'locked'` = store sealed; `'not configured'` = creds missing. */
  async validateGithubApp(): Promise<GithubAppValidateResult> {
    const res = await this.request('/github/app/validate', { method: 'POST' });
    return githubAppValidateSchema.parse(await res.json());
  }

  /** Mint the single-use token that authenticates the browser-opened manifest
   *  `start` flow (audit C1 follow-up). Call this authenticated endpoint first,
   *  then hang the returned `startToken` on the start URL as `?ott=`. */
  async prepareGithubManifest(baseUrl: string): Promise<string> {
    const res = await this.request('/github/app/manifest/prepare', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ baseUrl }),
    });
    return manifestPrepareSchema.parse(await res.json()).startToken;
  }

  /** Disconnect the connected GitHub App: clears the stored app id, installation
   *  id, and PEM, reopening onboarding so a different App can be connected / keys
   *  rotated. Authenticated + requires the store unlocked (503 while sealed). */
  async disconnectGithub(): Promise<void> {
    await this.request('/settings/github/disconnect', { method: 'POST' });
  }

  /** First-run (#320, OPTIONAL): live-validate the stored Doppler Service Account
   *  token by listing the account's projects server-side. Requires the secret
   *  store unlocked (the token must decrypt). Never carries the token —
   *  `{ ok, projectCount?, error? }` only. `error: 'locked'` = store sealed;
   *  `'not configured'` = token missing. */
  async validateDoppler(): Promise<DopplerValidateResult> {
    const res = await this.request('/doppler/validate', { method: 'POST' });
    return dopplerValidateSchema.parse(await res.json());
  }

  /** Binding picker (#320): list the account's Doppler projects, server-side, from
   *  the TRUSTED account token (NOT repo content). Requires the secret store
   *  unlocked (the account token must decrypt). Returns `{ projects }` on success
   *  or `{ error }` (`'locked'` = sealed; `'not configured'` = no account token).
   *  The token is NEVER returned. */
  async listDopplerProjects(): Promise<DopplerProjectsResult> {
    const res = await this.request('/doppler/projects', { method: 'GET' });
    return dopplerProjectsResultSchema.parse(await res.json());
  }

  /** Binding picker (#320): list a Doppler project's configs, server-side, from the
   *  TRUSTED account token. `project` is the slug from {@link listDopplerProjects}.
   *  Returns `{ configs }` or `{ error }` (`'locked'` / `'not configured'` /
   *  `'project is required'`). The token is NEVER returned. */
  async listDopplerConfigs(project: string): Promise<DopplerConfigsResult> {
    const res = await this.request(`/doppler/configs?project=${encodeURIComponent(project)}`, {
      method: 'GET',
    });
    return dopplerConfigsResultSchema.parse(await res.json());
  }

  /** First-run (#320): generate an ed25519 signing keypair server-side. The private
   *  key is stored encrypted at rest and NEVER returned — only the public key +
   *  derived allowed_signers come back. Requires the secret store unlocked (it must
   *  encrypt the private key to store it); `error: 'locked'` = store sealed.
   *
   *  Pass `identity` to set the committer name/email explicitly — required when the
   *  GitHub App is an ORG installation (it can't yield a signing identity), so the
   *  operator supplies their personal, account-verified email instead. */
  async generateSigningKey(identity?: {
    gitUserName?: string;
    gitUserEmail?: string;
  }): Promise<SigningKeyGenerateResult> {
    const body: { gitUserName?: string; gitUserEmail?: string } = {};
    if (identity?.gitUserName !== undefined && identity.gitUserName.trim().length > 0) {
      body.gitUserName = identity.gitUserName.trim();
    }
    if (identity?.gitUserEmail !== undefined && identity.gitUserEmail.trim().length > 0) {
      body.gitUserEmail = identity.gitUserEmail.trim();
    }
    const res = await this.request('/settings/signing-key/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return signingKeyGenerateSchema.parse(await res.json());
  }

  /** The current signing PUBLIC key for re-display in Settings (add to GitHub as a
   *  Signing Key). Public material — available even while the store is sealed. */
  async getSigningKey(): Promise<SigningKeyInfo> {
    const res = await this.request('/settings/signing-key', { method: 'GET' });
    return signingKeySchema.parse(await res.json());
  }

  async getProject(id: string): Promise<ProjectDetail> {
    const res = await this.request(`/projects/${encodeURIComponent(id)}`, { method: 'GET' });
    return projectDetailSchema.parse(await res.json());
  }

  async updateProjectSettings(id: string, patch: ProjectSettingsPatch): Promise<ProjectSettings> {
    const res = await this.request(`/projects/${encodeURIComponent(id)}/settings`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    });
    return projectSettingsResponseSchema.parse(await res.json()).settings;
  }

  async startDevServer(devServerId: string): Promise<ProjectRuntimeStarted> {
    const res = await this.request(`/dev-servers/${encodeURIComponent(devServerId)}/runtime`, {
      method: 'POST',
    });
    return projectRuntimeResponseSchema.parse(await res.json()).runtime;
  }

  async getDevServerStatus(devServerId: string): Promise<ProjectRuntimeStarted> {
    const res = await this.request(`/dev-servers/${encodeURIComponent(devServerId)}/runtime`, {
      method: 'GET',
    });
    return projectRuntimeResponseSchema.parse(await res.json()).runtime;
  }

  async stopDevServer(devServerId: string): Promise<ProjectRuntimeStarted> {
    const res = await this.request(`/dev-servers/${encodeURIComponent(devServerId)}/runtime/stop`, {
      method: 'POST',
    });
    return projectRuntimeResponseSchema.parse(await res.json()).runtime;
  }

  /** Point the dev server at a session's worktree (preview before merge), or
   *  back at the main checkout (`sessionId: null`). A running server is
   *  restarted in the new checkout; the response then carries its runtime. */
  async setDevServerPreviewSession(
    devServerId: string,
    sessionId: string | null,
  ): Promise<DevServerPreviewResult> {
    const res = await this.request(
      `/dev-servers/${encodeURIComponent(devServerId)}/preview-session`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      },
    );
    return devServerPreviewResponseSchema.parse(await res.json());
  }

  async getDevServerLogs(devServerId: string): Promise<ProjectRuntimeLogs> {
    const res = await this.request(`/dev-servers/${encodeURIComponent(devServerId)}/runtime/logs`, {
      method: 'GET',
    });
    return projectRuntimeLogsResponseSchema.parse(await res.json()).logs;
  }

  async getDevServerHealth(devServerId: string): Promise<ProjectRuntimeHealth> {
    const res = await this.request(
      `/dev-servers/${encodeURIComponent(devServerId)}/runtime/health`,
      { method: 'GET' },
    );
    return projectRuntimeHealthResponseSchema.parse(await res.json()).health;
  }

  async createProject(body: CreateProjectRequest): Promise<ProjectRecord> {
    const res = await this.request('/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return projectCreatedSchema.parse(await res.json()).project;
  }

  /** Connect a project created without GitHub (`kind: 'local'`) to an EXISTING
   * GitHub repository and rewrite the project's identity. An empty repository takes
   * the project's history directly; one that already has history gets an import
   * branch plus a pull request the operator still has to merge — so callers must
   * surface {@link LinkedProject.pullRequest}. The sandbox is recreated as part of
   * this, so callers should warn that running sessions restart. */
  async linkProjectToGitHub(id: string, repo: string): Promise<LinkedProject> {
    const res = await this.request(`/projects/${encodeURIComponent(id)}/link-github`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo }),
    });
    return linkedProjectSchema.parse(await res.json());
  }

  async deprovisionProject(id: string, opts: { purge?: boolean } = {}): Promise<ProjectRecord> {
    const qs = opts.purge === true ? '?purge=true' : '';
    const res = await this.request(`/projects/${encodeURIComponent(id)}/deprovision${qs}`, {
      method: 'POST',
    });
    return z.object({ project: projectRecordSchema }).parse(await res.json()).project;
  }

  async deleteProject(id: string): Promise<ProjectDeleted> {
    const res = await this.request(`/projects/${encodeURIComponent(id)}`, { method: 'DELETE' });
    return projectDeletedSchema.parse(await res.json());
  }

  // ─── Standing brokered-secret grants (ADR 0011 D2) ─────────────────────────

  /** Grants that currently auto-approve a brokered-secret prompt for this project.
   *  Expired ones are already filtered server-side, so everything listed is live. */
  async listSecretGrants(projectId: string): Promise<SecretGrant[]> {
    const res = await this.request(`/projects/${encodeURIComponent(projectId)}/secret-grants`, {
      method: 'GET',
    });
    return secretGrantsResponseSchema.parse(await res.json()).grants;
  }

  /** End one standing grant. The only way a 'forever' grant ever stops applying. */
  async revokeSecretGrant(projectId: string, grantId: string): Promise<void> {
    await this.request(
      `/projects/${encodeURIComponent(projectId)}/secret-grants/${encodeURIComponent(grantId)}`,
      { method: 'DELETE' },
    );
  }

  // ─── Agent Loops (ADR 0008) ────────────────────────────────────────────────

  async listAgentLoops(projectId: string): Promise<AgentLoop[]> {
    const res = await this.request(`/projects/${encodeURIComponent(projectId)}/agent-loops`, {
      method: 'GET',
    });
    return agentLoopsResponseSchema.parse(await res.json()).loops;
  }

  async getAgentLoop(loopId: string): Promise<AgentLoop> {
    const res = await this.request(`/agent-loops/${encodeURIComponent(loopId)}`, {
      method: 'GET',
    });
    return agentLoopResponseSchema.parse(await res.json()).loop;
  }

  async createAgentLoop(projectId: string, body: AgentLoopCreateRequest): Promise<AgentLoop> {
    const res = await this.request(`/projects/${encodeURIComponent(projectId)}/agent-loops`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return agentLoopResponseSchema.parse(await res.json()).loop;
  }

  async updateAgentLoop(loopId: string, patch: AgentLoopPatchRequest): Promise<AgentLoop> {
    const res = await this.request(`/agent-loops/${encodeURIComponent(loopId)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    });
    return agentLoopResponseSchema.parse(await res.json()).loop;
  }

  async ensureAgentLoopSession(loopId: string): Promise<AgentLoop> {
    const res = await this.request(`/agent-loops/${encodeURIComponent(loopId)}/session`, {
      method: 'POST',
    });
    return agentLoopResponseSchema.parse(await res.json()).loop;
  }

  async testAgentLoop(loopId: string): Promise<AgentLoopTestResult> {
    const res = await this.request(`/agent-loops/${encodeURIComponent(loopId)}/test`, {
      method: 'POST',
    });
    return agentLoopTestResponseSchema.parse(await res.json());
  }

  async runAgentLoop(loopId: string): Promise<AgentLoopRunResult> {
    const res = await this.request(`/agent-loops/${encodeURIComponent(loopId)}/run`, {
      method: 'POST',
    });
    return agentLoopRunResponseSchema.parse(await res.json());
  }

  async deleteAgentLoop(loopId: string, opts: { deleteSession?: boolean } = {}): Promise<void> {
    const query = opts.deleteSession ? '?deleteSession=true' : '';
    await this.request(`/agent-loops/${encodeURIComponent(loopId)}${query}`, { method: 'DELETE' });
  }

  async listDevServers(projectId: string): Promise<DevServer[]> {
    const res = await this.request(`/projects/${encodeURIComponent(projectId)}/dev-servers`, {
      method: 'GET',
    });
    return devServersResponseSchema.parse(await res.json()).devServers;
  }

  async listPublicPreviewShares(projectId: string): Promise<PublicPreviewShare[]> {
    const res = await this.request(`/projects/${encodeURIComponent(projectId)}/public-shares`, {
      method: 'GET',
    });
    return publicPreviewSharesResponseSchema.parse(await res.json()).shares;
  }

  async createPublicPreviewShare(
    devServerId: string,
    body: PublicPreviewShareCreateRequest,
  ): Promise<PublicPreviewShare> {
    const res = await this.request(
      `/dev-servers/${encodeURIComponent(devServerId)}/public-shares`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
    );
    return publicPreviewShareResponseSchema.parse(await res.json()).share;
  }

  async stopPublicPreviewShare(shareId: string): Promise<void> {
    await this.request(`/public-shares/${encodeURIComponent(shareId)}`, { method: 'DELETE' });
  }

  async createStaticPublicPreviewShare(
    projectId: string,
    body: PublicPreviewShareCreateRequest & { staticPath: string },
  ): Promise<PublicPreviewShare> {
    const res = await this.request(
      `/projects/${encodeURIComponent(projectId)}/public-static-shares`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
    );
    return publicPreviewShareResponseSchema.parse(await res.json()).share;
  }

  async detectDevServers(projectId: string): Promise<DevServerSuggestion[]> {
    return (await this.getDevServerDetection(projectId)).suggestions;
  }

  async getDevServerDetection(projectId: string): Promise<DevServerDetection> {
    const res = await this.request(
      `/projects/${encodeURIComponent(projectId)}/dev-server-suggestions`,
      { method: 'GET' },
    );
    const parsed = devServerSuggestionsResponseSchema.parse(await res.json());
    return {
      fingerprint: parsed.fingerprint ?? null,
      detectedAt: parsed.detectedAt ?? null,
      reviewedFingerprint: parsed.reviewedFingerprint ?? null,
      reviewedAt: parsed.reviewedAt ?? null,
      suggestions: parsed.suggestions,
    };
  }

  async reviewDevServerDetection(
    projectId: string,
    fingerprint: string,
  ): Promise<DevServerDetectionState> {
    const res = await this.request(
      `/projects/${encodeURIComponent(projectId)}/dev-server-suggestions/reviewed`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fingerprint }),
      },
    );
    return z.object({ detection: devServerDetectionStateSchema }).parse(await res.json()).detection;
  }

  async getDevServer(devServerId: string): Promise<DevServer> {
    const res = await this.request(`/dev-servers/${encodeURIComponent(devServerId)}`, {
      method: 'GET',
    });
    return devServerResponseSchema.parse(await res.json()).devServer;
  }

  async createDevServer(projectId: string, body: DevServerCreateRequest = {}): Promise<DevServer> {
    const res = await this.request(`/projects/${encodeURIComponent(projectId)}/dev-servers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return devServerResponseSchema.parse(await res.json()).devServer;
  }

  async setupDetectedDevServers(
    projectId: string,
    body: DetectedDevServerSetupRequest,
  ): Promise<ProjectRecord> {
    const res = await this.request(`/projects/${encodeURIComponent(projectId)}/setup-dev-servers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return z.object({ project: projectRecordSchema }).parse(await res.json()).project;
  }

  async updateDevServer(devServerId: string, patch: DevServerPatchRequest): Promise<DevServer> {
    const res = await this.request(`/dev-servers/${encodeURIComponent(devServerId)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    });
    return devServerResponseSchema.parse(await res.json()).devServer;
  }

  async deleteDevServer(devServerId: string): Promise<void> {
    await this.request(`/dev-servers/${encodeURIComponent(devServerId)}`, { method: 'DELETE' });
  }

  async listAgentLoopRuns(loopId: string): Promise<AgentLoopRun[]> {
    const res = await this.request(`/agent-loops/${encodeURIComponent(loopId)}/runs`, {
      method: 'GET',
    });
    return agentLoopRunsResponseSchema.parse(await res.json()).runs;
  }

  async repairProject(id: string, opts: ProjectProvisionOptions = {}): Promise<ProjectRecord> {
    const res = await this.request(`/projects/${encodeURIComponent(id)}/repair`, {
      method: 'POST',
      ...(opts.confirmWarnings === true
        ? {
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ confirmWarnings: true }),
          }
        : {}),
    });
    return z.object({ project: projectRecordSchema }).parse(await res.json()).project;
  }

  async refreshProjectToken(id: string): Promise<ConciergeTokenRefresh> {
    const res = await this.request(`/concierge/projects/${encodeURIComponent(id)}/refresh-token`, {
      method: 'POST',
    });
    return conciergeTokenRefreshResponseSchema.parse(await res.json());
  }

  async recreateProjectContainer(
    id: string,
    opts: RecreateProjectContainerOptions = {},
  ): Promise<ProjectRecord> {
    // Send only the flags that are set, and no body at all when neither is, so
    // the no-flag request stays byte-identical to what it sent before
    // `forceRebuild` existed. Note this is NOT a compatibility guard for the
    // flag itself: the server's body schema is non-strict, so an older server
    // strips an unknown `forceRebuild` and recreates from the cached image
    // without complaining. `healthSchema.imageRebuildSupported` is what gates
    // the action — see there.
    const body: { confirmWarnings?: boolean; forceRebuild?: boolean } = {};
    if (opts.confirmWarnings === true) body.confirmWarnings = true;
    if (opts.forceRebuild === true) body.forceRebuild = true;
    const res = await this.request(
      `/concierge/projects/${encodeURIComponent(id)}/recreate-container`,
      {
        method: 'POST',
        ...(Object.keys(body).length > 0
          ? {
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(body),
            }
          : {}),
      },
    );
    return z.object({ project: projectRecordSchema }).parse(await res.json()).project;
  }

  async openConciergeSession(): Promise<SessionCreated> {
    const res = await this.request('/concierge/session', { method: 'POST' });
    return sessionCreatedSchema.parse(await res.json());
  }

  async getSession(id: string): Promise<SessionDetail> {
    const res = await this.request(`/sessions/${encodeURIComponent(id)}`, { method: 'GET' });
    return sessionDetailSchema.parse(await res.json());
  }

  async createStreamTicket(id: string): Promise<StreamTicket> {
    const res = await this.request(`/sessions/${encodeURIComponent(id)}/stream-ticket`, {
      method: 'POST',
    });
    return streamTicketSchema.parse(await res.json());
  }

  /** Lightweight live activity for a session (cheap to poll): whether a turn is
   * in flight (`busy`) and the prompts of any queued turns. Server-authoritative
   * so the "working" indicator + "waiting" messages survive navigation. */
  async getActivity(id: string): Promise<SessionActivity> {
    const res = await this.request(`/sessions/${encodeURIComponent(id)}/activity`, {
      method: 'GET',
    });
    return sessionActivitySchema.parse(await res.json());
  }

  /** A backward page of a session's history: the newest `limit` events (ascending),
   * or those just before `beforeSeq`, plus `hasMore`. Used to open a long session
   * from its tail and to load older turns on scroll-up. */
  async getHistory(
    id: string,
    opts: { beforeSeq?: number; limit?: number } = {},
  ): Promise<SessionHistoryPage> {
    const params = new URLSearchParams();
    if (opts.beforeSeq !== undefined) params.set('beforeSeq', String(opts.beforeSeq));
    if (opts.limit !== undefined) params.set('limit', String(opts.limit));
    const qs = params.toString();
    const res = await this.request(
      `/sessions/${encodeURIComponent(id)}/events${qs ? `?${qs}` : ''}`,
      { method: 'GET' },
    );
    return sessionHistorySchema.parse(await res.json());
  }

  /** Fire-and-forget mobile scroll diagnostics. The app catches/reporting failures;
   * this endpoint is intentionally observability-only and must never affect UI flow. */
  async reportScrollDiagnostic(id: string, diagnostic: MobileScrollDiagnostic): Promise<void> {
    await this.request(`/sessions/${encodeURIComponent(id)}/debug/scroll`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(diagnostic),
    });
  }

  /** Register this device's Expo push token (§push). `deviceId` is this device's
   * OWN auth-token id — the `tokenId` returned by `/secret/unlock|init` — which the
   * server matches against the bearer (403 on mismatch). Throws a
   * {@link VerityApiError} with status 503 when push is disabled server-side;
   * callers treat that as "degrade silently to in-app only". */
  async registerPushToken(
    deviceId: string,
    body: DevicePushTokenRequest,
  ): Promise<DevicePushTokenRegistered> {
    const res = await this.request(`/devices/${encodeURIComponent(deviceId)}/push-token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return devicePushTokenRegisteredSchema.parse(await res.json());
  }

  async sendTurn(id: string, body: TurnRequest): Promise<TurnAccepted> {
    const res = await this.request(`/sessions/${encodeURIComponent(id)}/turns`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return turnResponseSchema.parse(await res.json());
  }

  /** Stop the in-flight turn of a session (#79). Resolves with `cancelled`: false
   * when the session was idle (no-op). 404 (unknown session) throws a
   * {@link VerityApiError}.
   *
   * `force` additionally releases a session fenced because the previous agent
   * process could not be proven dead — the operator's override for a barrier that has
   * no automatic exit while the old worker stays unreachable. It does not prove
   * anything died, so ask before sending it. Harmless on an unfenced session:
   * `forceReleased` comes back false. */
  async cancelTurn(id: string, opts?: { force?: boolean }): Promise<TurnCancelled> {
    const res = await this.request(`/sessions/${encodeURIComponent(id)}/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ force: opts?.force === true }),
    });
    return turnCancelledSchema.parse(await res.json());
  }

  /** Retract a queued turn before it runs (#80), returning its prompt so the app
   * can put it back in the input to edit/resend. A 404 (`itemId` already drained or
   * retracted) throws a {@link VerityApiError} the caller can treat as "already
   * gone". */
  async cancelQueued(id: string, itemId: string): Promise<QueuedTurnCancelled> {
    const res = await this.request(
      `/sessions/${encodeURIComponent(id)}/queue/${encodeURIComponent(itemId)}/cancel`,
      { method: 'POST' },
    );
    return queuedTurnCancelledSchema.parse(await res.json());
  }

  /** Upload meeting audio to the server for local transcription + speaker
   * diarization. The mobile app only sends bytes; Verity Server writes the
   * markdown transcript into the session worktree under `docs/meetings`. */
  async uploadMeetingAudio(
    id: string,
    body: MeetingTranscriptUpload,
  ): Promise<MeetingTranscriptCreated> {
    if (typeof body.data === 'string') {
      const res = await this.request(`/sessions/${encodeURIComponent(id)}/meetings/transcripts`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return meetingTranscriptCreatedSchema.parse(await res.json());
    }
    const url = `${this.baseUrl}/sessions/${encodeURIComponent(id)}/meetings/transcripts/stream`;
    const metadataHeaders = {
      'x-verity-meeting-file-name': encodeURIComponent(body.fileName),
      'x-verity-meeting-media-type': encodeURIComponent(body.mediaType),
      ...(body.title ? { 'x-verity-meeting-title': encodeURIComponent(body.title) } : {}),
      ...(body.announceRequest === false ? { 'x-verity-meeting-announce': 'false' } : {}),
      ...(body.clientRequestId
        ? { 'x-verity-meeting-client-request-id': encodeURIComponent(body.clientRequestId) }
        : {}),
    };
    if (
      this.allowBackgroundUpload &&
      typeof body.data === 'object' &&
      body.data !== null &&
      'upload' in body.data &&
      typeof body.data.upload === 'function'
    ) {
      const token = this.getToken();
      const result = await (body.data as BackgroundUploadBlob).upload(url, {
        httpMethod: 'POST',
        headers: {
          'content-type': 'application/octet-stream',
          ...metadataHeaders,
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        sessionType: 'background',
      });
      let responseBody: unknown;
      try {
        responseBody = JSON.parse(result.body) as unknown;
      } catch {
        responseBody = undefined;
      }
      if (result.status < 200 || result.status >= 300) {
        if (result.status === 401 && token) this.onUnauthorized?.();
        const message = z.object({ error: z.string() }).safeParse(responseBody);
        throw new VerityApiError(
          result.status,
          message.success ? message.data.error : `request failed (${result.status})`,
        );
      }
      return meetingTranscriptCreatedSchema.parse(responseBody);
    }
    const res = await this.request(
      `/sessions/${encodeURIComponent(id)}/meetings/transcripts/stream`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream', ...metadataHeaders },
        body: uploadBodyWithMimeType(body.data),
      },
      this.uploadFetchImpl,
    );
    return meetingTranscriptCreatedSchema.parse(await res.json());
  }

  async listWorkflows(): Promise<Workflow[]> {
    const res = await this.request('/workflows', { method: 'GET' });
    return z.array(workflowSchema).parse(await res.json());
  }

  async getWorkflow(id: string): Promise<Workflow> {
    const res = await this.request(`/workflows/${encodeURIComponent(id)}`, { method: 'GET' });
    return workflowSchema.parse(await res.json());
  }

  async createWorkflow(body: CreateWorkflowRequest): Promise<Workflow> {
    const res = await this.request('/workflows', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return workflowSchema.parse(await res.json());
  }

  async authorizeWorkflow(id: string, version: number): Promise<Workflow> {
    const res = await this.request(`/workflows/${encodeURIComponent(id)}/authorize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version }),
    });
    return workflowSchema.parse(await res.json());
  }

  async dispatchWorkflowStep(id: string, stepId: string, version: number): Promise<void> {
    await this.request(
      `/workflows/${encodeURIComponent(id)}/steps/${encodeURIComponent(stepId)}/dispatch`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ version }),
      },
    );
  }

  async cancelWorkflow(id: string): Promise<Workflow> {
    const res = await this.request(`/workflows/${encodeURIComponent(id)}/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    return workflowSchema.parse(await res.json());
  }

  async approveWorkflowDecision(id: string, stepId: string, version: number): Promise<Workflow> {
    const res = await this.request(`/workflows/${encodeURIComponent(id)}/decisions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stepId, version, approved: true }),
    });
    return workflowSchema.parse(await res.json());
  }

  async recordWorkflowImage(id: string, digest: string, version: number): Promise<Workflow> {
    const res = await this.request(`/workflows/${encodeURIComponent(id)}/image-candidate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        digest,
        version,
        idempotencyKey: `image-${version}-${digest}`,
      }),
    });
    return workflowSchema.parse(await res.json());
  }

  /** Spawn a NEW agent: provision a worktree + start a fresh session, returning
   * the claude-minted session id (subscribe to it via the stream). */
  async createSession(body: SpawnRequest): Promise<SessionCreateResult> {
    const res = await this.request('/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return z
      .union([sessionCreatedSchema, sessionAwaitingProvisioningSchema])
      .parse(await res.json());
  }

  /** Rename a session (set its display name), or clear it by passing `null`.
   * Returns the session id + the stored (trimmed) name the server echoes back. */
  async renameSession(id: string, name: string | null): Promise<SessionRenamed> {
    const res = await this.request(`/sessions/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    return sessionRenamedSchema.parse(await res.json());
  }

  /** Switch the engine/model a session uses (the operator's pick is persisted, not a
   * one-turn override). The model string routes to a backend per ADR 0001 (`codex/…`
   * → Codex, `claude-*` → Claude).
   *
   * A switch INTERRUPTS a turn that is running: the old agent process has to be gone
   * before the new one may touch the worktree, so the server cancels it, waits for the
   * termination to be confirmed, and only then persists the new model. That holds for
   * every switch, including Claude→Claude. A resolved call therefore means the switch
   * is fully applied and `deferred` is always false; the field is kept for wire
   * compatibility with servers that deferred the backend close to the next turn
   * boundary, and the pending-notice path it drives stays for those.
   *
   * Sending the model the session already runs is a no-op: it skips the handover
   * entirely rather than interrupting the turn, so a settings save that re-sends the
   * current model is safe.
   *
   * 400 if the session belongs to a project and the model isn't Claude/Codex; 404
   * (unknown session), 409 (the session is held by another operation — ordinary
   * contention) and 503 (the old backend's termination could not be confirmed) throw a
   * {@link VerityApiError}. On both 409 and 503 the session is left on its old backend
   * and the call is safe to retry — they carry `Retry-After` — and a rename sent in the
   * same request is applied regardless. */
  async setSessionModel(id: string, model: string): Promise<SessionModelSwitched> {
    const res = await this.request(`/sessions/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model }),
    });
    return sessionModelSwitchedSchema.parse(await res.json());
  }

  /** Advance a session's "last seen" mark for the overview unread dot (#387) to the
   * `eventCount` observed when the operator opened it. Persisted server-side and
   * monotonic, so clearing the dot on one device clears it on every device. Returns a
   * lightweight ack with the resolved mark; the synced value itself arrives on the
   * next `GET /sessions`. 404 (unknown session) throws a {@link VerityApiError}. */
  async setSessionSeen(id: string, eventCount: number): Promise<SessionSeen> {
    const res = await this.request(`/sessions/${encodeURIComponent(id)}/seen`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ eventCount }),
    });
    return sessionSeenSchema.parse(await res.json());
  }

  /** Permanently delete a session: drops its history and removes its worktree on
   * the server. Non-2xx (404 unknown, 409 busy) throws a {@link VerityApiError}
   * carrying the server's status + message. `force` bypasses the busy guard after
   * an explicit destructive confirmation. Returns the deleted session id. */
  async deleteSession(id: string, opts: { force?: boolean } = {}): Promise<SessionDeleted> {
    const query = opts.force ? '?force=true' : '';
    const res = await this.request(`/sessions/${encodeURIComponent(id)}${query}`, {
      method: 'DELETE',
    });
    return sessionDeletedSchema.parse(await res.json());
  }

  /** The routable models for the new-session picker (#143): the Claude ids plus any
   * OpenCode provider-qualified ids the server enumerates, and the spawn default. */
  async listModels(): Promise<ModelList> {
    const res = await this.request('/models', { method: 'GET' });
    return modelListSchema.parse(await res.json());
  }

  /** The current + switchable branches of a session's worktree (#91). */
  async getBranches(id: string): Promise<BranchList> {
    const res = await this.request(`/sessions/${encodeURIComponent(id)}/branches`, {
      method: 'GET',
    });
    return branchListSchema.parse(await res.json());
  }

  /** Browse a session's local worktree. Includes uncommitted and generated files,
   * but the server blocks path escapes and `.git` internals. */
  async listSessionFiles(id: string, path = ''): Promise<SessionDirectory> {
    const qs = path ? `?path=${encodeURIComponent(path)}` : '';
    const res = await this.request(`/sessions/${encodeURIComponent(id)}/files${qs}`, {
      method: 'GET',
    });
    return sessionDirectorySchema.parse(await res.json());
  }

  /** Fetch a small text file from a session worktree for inline preview. Binary or
   * oversized files throw {@link VerityApiError}; use {@link sessionFileDownloadUrl}
   * for those. */
  async getSessionFileContent(id: string, path: string): Promise<SessionFileContent> {
    const res = await this.request(
      `/sessions/${encodeURIComponent(id)}/files/content?path=${encodeURIComponent(path)}`,
      { method: 'GET' },
    );
    return sessionFileContentSchema.parse(await res.json());
  }

  /** Direct URL for opening/downloading a session worktree file. */
  sessionFileDownloadUrl(id: string, path: string): string {
    return `${this.baseUrl}/sessions/${encodeURIComponent(id)}/files/download?path=${encodeURIComponent(path)}`;
  }

  /** Fetch a session worktree file as bytes through the configured fetch
   * implementation. UI code can instead use {@link sessionFileDownloadUrl} for a
   * native browser/app download. */
  async downloadSessionFile(id: string, path: string): Promise<Blob> {
    const res = await this.request(
      `/sessions/${encodeURIComponent(id)}/files/download?path=${encodeURIComponent(path)}`,
      { method: 'GET' },
    );
    return res.blob();
  }

  /** Copy a picked file into a session worktree directory. Existing files are
   * never overwritten. */
  async uploadSessionFile(
    id: string,
    upload: { path: string; fileName: string; data: Blob },
  ): Promise<SessionFileUploaded> {
    // Percent-encode explicitly (as every other call here does) instead of relying
    // on `URLSearchParams.toString()`: the app runs on React Native's polyfill, and
    // a name with an umlaut must not depend on whether that polyfill escapes.
    const query = `path=${encodeURIComponent(upload.path)}&fileName=${encodeURIComponent(upload.fileName)}`;
    const res = await this.request(
      `/sessions/${encodeURIComponent(id)}/files?${query}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: uploadBodyWithMimeType(upload.data),
      },
      this.uploadFetchImpl,
    );
    return sessionFileUploadedSchema.parse(await res.json());
  }

  /** Switch the session worktree's branch, keeping the chat (#91). Returns the
   * branch now checked out. Non-2xx (busy/dirty/in-use/name-exists → 409, no
   * such branch → 404, invalid name → 400, unconfigured → 503) throws a
   * {@link VerityApiError} carrying the server's `error` message. */
  async switchBranch(id: string, body: BranchSwitchRequest): Promise<BranchSwitched> {
    const res = await this.request(`/sessions/${encodeURIComponent(id)}/branch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return branchSwitchedSchema.parse(await res.json());
  }

  async mergePullRequest(id: string, number: number): Promise<PullRequestMerged> {
    const res = await this.request(`/sessions/${encodeURIComponent(id)}/pull-request/merge`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ number }),
    });
    return pullRequestMergedSchema.parse(await res.json());
  }

  /** Merge this session's branch into the base branch of a project that has NO
   * GitHub repository (see {@link BranchList.localMerge}). Everything happens in the
   * project's local clone; the server rejects the call for GitHub-backed projects,
   * which merge through their pull request instead. */
  async mergeSessionBranch(id: string): Promise<LocalMerged> {
    const res = await this.request(`/sessions/${encodeURIComponent(id)}/merge`, {
      method: 'POST',
    });
    return localMergedSchema.parse(await res.json());
  }

  /** Answer a live mid-turn permission prompt (#149): allow (optionally with edited
   * input) or deny the tool `toolUseId` the in-flight turn paused on. Resolves when
   * the server confirms the decision. A 404 (no pending prompt under that id — the
   * turn already ended, the operator already answered, or it's unknown) throws a
   * {@link VerityApiError} the caller treats as "already stale, drop the prompt". The
   * decision is a per-tool runtime answer, never a bypass of the §5b invariants. */
  async decidePermission(
    id: string,
    toolUseId: string,
    decision: PermissionDecision,
  ): Promise<PermissionDecided> {
    const res = await this.request(
      `/sessions/${encodeURIComponent(id)}/permissions/${encodeURIComponent(toolUseId)}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(decision),
      },
    );
    return permissionDecidedSchema.parse(await res.json());
  }

  private async request(
    path: string,
    init: RequestInit,
    fetchImpl: typeof fetch = this.fetchImpl,
  ): Promise<Response> {
    // Attach the per-device bearer token (audit C1) when we have one. Callers
    // pass plain-object headers, so a record spread is safe; an explicit
    // Authorization in `init` (none today) would win by being spread last.
    const token = this.getToken();
    const sentToken = token != null && token.length > 0;
    if (sentToken) {
      init = {
        ...init,
        headers: { authorization: `Bearer ${token}`, ...(init.headers as Record<string, string>) },
      };
    }
    const res = await fetchImpl(`${this.baseUrl}${path}`, init);
    if (!res.ok) {
      // A 401 on a GATED route AFTER we sent a token means that token is
      // expired/revoked → tell the app to drop it and re-authenticate. Only fire
      // when a token was ACTUALLY sent: a 401 with no token attached (e.g. the
      // biometric unlock was cancelled at launch, so none is loaded yet) must NOT
      // wipe the still-valid stored credential — that would turn one cancelled
      // Face ID prompt into a forced master-password re-entry. The `/secret/*`
      // on-ramp is always exempt (its 401 is a wrong-password shown inline).
      if (res.status === 401 && sentToken && !path.startsWith('/secret/')) this.onUnauthorized?.();
      const payload = await errorPayload(res);
      throw new VerityApiError(res.status, payload.message, {
        requiresConfirmation: payload.requiresConfirmation,
        warnings: payload.warnings,
      });
    }
    return res;
  }
}

/** Pull the server's sanitized `{ error }` out of a non-2xx body, falling back
 * to a status-derived message when there's no JSON. */
async function errorPayload(
  res: Response,
): Promise<{ message: string; requiresConfirmation: boolean; warnings: string[] }> {
  try {
    const body: unknown = await res.json();
    if (body && typeof body === 'object' && 'error' in body) {
      const { error } = body;
      if (typeof error === 'string') {
        return { message: error, requiresConfirmation: false, warnings: [] };
      }
    }
    if (body && typeof body === 'object' && 'requiresConfirmation' in body && 'warnings' in body) {
      const { requiresConfirmation, warnings } = body;
      if (
        requiresConfirmation === true &&
        Array.isArray(warnings) &&
        warnings.every((warning) => typeof warning === 'string')
      ) {
        return {
          message: warnings.join('\n\n') || 'Confirmation required',
          requiresConfirmation: true,
          warnings,
        };
      }
    }
  } catch {
    // no/!JSON body — fall through to the status-based message
  }
  return {
    message: res.statusText || `HTTP ${String(res.status)}`,
    requiresConfirmation: false,
    warnings: [],
  };
}
