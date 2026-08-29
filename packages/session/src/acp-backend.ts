import * as acp from '@agentclientprotocol/sdk';
import type {
  ContentBlock,
  McpServer,
  NewSessionResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionUpdate,
} from '@agentclientprotocol/sdk';
import type { AgentEvent, Usage } from '@verity/events';
import type { PermissionDecision, PermissionRequest } from './index.js';
import type {
  RunResult,
  RunTurnOptions,
  SpawnedProcess,
  SteerMessage,
} from './backend-contract.js';
import { isExplicitPreExecutionRejection } from './backend-contract.js';
import {
  AcpEventAdapter,
  AcpTextStream,
  parentToolId,
  toolName,
  type AcpEventAdapterOptions,
} from './acp-adapter.js';
import { SessionWriter } from './ingest.js';
import { assertSafeArgs, nodeSpawner } from './runner.js';

const ZERO_USAGE: Usage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
};

/**
 * SIGTERM → SIGKILL grace for the AGENT process. Every kill in this file used to be a
 * bare SIGTERM with no escalation anywhere behind it, so an adapter wedged past its own
 * signal handler kept the turn's process — and everything it had spawned — alive until
 * some outer teardown happened to reach it. Deliberately longer than the escaped-subtree
 * grace in `process-tree.ts`: the agent still has a transcript to flush, a tool tree
 * whose turn is already over does not.
 */
const AGENT_KILL_ESCALATION_MS = 5_000;

/**
 * How long a cooperative `session/cancel` is given before the process boundary is used
 * instead. A different clock from {@link AGENT_KILL_ESCALATION_MS} — this one waits on
 * an adapter that is still answering JSON-RPC, that one on a process that has been
 * signalled — which currently happen to be the same length. They move independently.
 */
const COOPERATIVE_CANCEL_TIMEOUT_MS = 5_000;

/**
 * Agents already signalled, so the second call for one turn is a no-op. A cancel kills
 * the adapter and the `finally` kills it again on the way out; without this the wedged
 * adapter the escalation exists for would collect one escalation timer per call.
 */
const killedAgents = new WeakSet<SpawnedProcess>();

/**
 * SIGTERM the agent (which {@link nodeSpawner} widens to its process group and its
 * escaped `setsid` subtrees), then SIGKILL it if it is still there. The escalation timer
 * is unref'd and cleared on exit, so a normally-settling turn neither waits on it nor
 * holds the event loop open. Single-shot per child: the first call's escalation stands.
 */
function killAgent(child: SpawnedProcess): void {
  if (killedAgents.has(child)) return;
  killedAgents.add(child);
  try {
    child.kill('SIGTERM');
  } catch {
    // A pluggable/remote spawner can lose its channel while the process remains alive.
    // Keep scheduling the independent hard-kill attempt below.
  }
  // Guarded: `Spawner` is a pluggable seam, and this call is the one that runs detached
  // in a timer. A throwing `kill` — a remote runner client whose channel has closed, a
  // test double — would otherwise leave the process with an uncaught exception rather
  // than a failed teardown.
  const escalation = setTimeout(() => {
    try {
      child.kill('SIGKILL');
    } catch {
      // Nothing left to escalate to.
    }
  }, AGENT_KILL_ESCALATION_MS);
  escalation.unref?.();
  // Cleared on a SETTLED exit only. A rejected `exited` is a statement about the channel
  // — a runner client that lost its socket — not about the process, which may well still
  // be running: exactly the case the escalation exists for. The rejection is still
  // observed so it never surfaces as an unhandled one.
  void child.exited.then(
    () => clearTimeout(escalation),
    () => undefined,
  );
}

/**
 * ACP's `resourceNotFound` JSON-RPC code — the one answer to `session/load` that
 * is a statement about the conversation rather than about the agent's current
 * condition. Spelled out here because the SDK exports the constructors
 * (`RequestError.resourceNotFound()`) but not the numbers.
 */
const RESOURCE_NOT_FOUND = -32002;

/** The live agent session, handed to a profile once `session/new` or
 *  `session/load` has answered and before the first prompt is sent. */
export interface AcpSessionSetup {
  readonly sessionId: string;
  /** The agent's own answer, including its `modes` and (codex-acp) `models`. */
  readonly session: NewSessionResponse;
  /** JSON-RPC escape hatch — ACP extension methods are agent-specific and carry
   *  no SDK types (`session/set_model`, `_session/steering`). */
  request(method: string, params: Record<string, unknown>): Promise<unknown>;
  /** Persist an operator-facing transcript note without failing the turn. */
  notice(text: string): Promise<void>;
}

/** Everything that differs between the ACP agents Verity drives. The turn loop
 *  itself — streaming, permissions, persist-before-publish ordering, steering,
 *  cancellation and the abort-vs-crash status rules — is shared. */
export interface AcpBackendProfile {
  /** Executable the spawn broker launches when the caller names none. */
  readonly defaultCommand: string;
  /** `telemetry.backend` on the turn's `result` event. */
  readonly telemetryBackend: string;
  /** Raised when a resume is asked for but the agent cannot load sessions. */
  readonly loadSessionUnsupported: string;
  readonly clientCapabilitiesMeta?: Record<string, unknown> | undefined;
  readonly adapter?: AcpEventAdapterOptions | undefined;
  /** `_meta` sent with `session/new` and `session/load`. */
  sessionMeta(opts: RunTurnOptions): Record<string, unknown>;
  /** Model recorded on the `session` event when the turn names none. */
  defaultModelLabel(opts: RunTurnOptions): string;
  /** The turn's prompt text — the hook for agents with no system-prompt field. */
  promptText(opts: RunTurnOptions): string;
  /** The permission posture this turn runs in, when the profile pins one. The
   *  shared turn loop applies it once the session answers, keeps the session in
   *  it when the agent switches modes mid-turn, and prefers it when a
   *  mode-carrying permission request asks which posture an approval implies.
   *  Agents that do not advertise the mode keep their own clamped current mode. */
  sessionMode?(opts: RunTurnOptions): string | undefined;
  /** The one tool whose approval legitimately also picks a permission posture
   *  (Claude's `ExitPlanMode`). Profiles that name none never have a permission
   *  request read as a posture, whatever its options look like. */
  readonly modePickerTool?: string | undefined;
  /** Every permission posture this profile may be spawned in — the §5b invariant,
   *  scoped to one agent's vocabulary. ACP modes are per-agent (Claude's `plan`
   *  means nothing to Codex, Codex's workspace modes mean nothing to Claude), so
   *  the shared turn loop cannot hold one list for all of them. A profile that
   *  declares none is not checked here, exactly as before ADR 0012.
   *
   *  REQUIRED of any profile whose {@link sessionMode} reads `opts.permissionMode`:
   *  that is the path by which a caller-supplied string becomes the session's mode,
   *  and this list is the only thing bounding it. Declaring none is safe only while
   *  the profile pins its mode itself — as the Codex one does, ignoring the option
   *  and returning a constant — because then no caller value reaches `session/set_mode`
   *  at all. `acp-codex-backend.test.ts` pins that, so a profile that starts honoring
   *  the option without stating a vocabulary fails a test rather than opening a hole.
   *
   *  Required PROPERTY (`| undefined`, not `?:`), for the same reason the matching
   *  parameter of {@link assertSafeArgs} is: optional here would let a new profile
   *  opt out of the mode check by saying nothing, which is indistinguishable from
   *  having thought about it. Spelling `undefined` is a claim — "this profile pins
   *  its own mode" — and the compiler makes every author state one. */
  readonly permissionModes: readonly string[] | undefined;
  configureSession?(setup: AcpSessionSetup, opts: RunTurnOptions): Promise<void>;
}

function processStream(process: SpawnedProcess): acp.Stream {
  if (process.writeStdin === undefined) throw new Error('ACP agent requires writable stdin');
  const encoder = new TextEncoder();
  const iterator = process.stdout[Symbol.asyncIterator]();
  return acp.ndJsonStream(
    new WritableStream<Uint8Array>({
      write(chunk) {
        if (!process.writeStdin?.(new TextDecoder().decode(chunk))) {
          throw new Error('ACP agent stdin closed');
        }
      },
      close() {
        process.closeStdin?.();
      },
    }),
    new ReadableStream<Uint8Array>({
      async pull(controller) {
        const next = await iterator.next();
        if (next.done) controller.close();
        else controller.enqueue(encoder.encode(next.value));
      },
      async cancel() {
        await iterator.return?.();
      },
    }),
  );
}

/** Turn and steer attachments share one shape, so one signature serves both. */
function imageBlocks(attachments: RunTurnOptions['attachments']): ContentBlock[] {
  return (attachments ?? [])
    .filter((attachment) => attachment.kind === 'image')
    .map((attachment): ContentBlock => ({
      type: 'image',
      mimeType: attachment.mediaType,
      data: attachment.data,
    }));
}

/** Verity's system directives, prefixed onto the prompt. The ACP agents other than
 *  Claude expose no system-prompt channel at all, so this is the only way their
 *  turns receive the directives — hence a shared helper rather than one per
 *  profile. Claude does have the channel and must NOT use this. */
export function promptWithSystemDirectives(opts: RunTurnOptions): string {
  const prompt = opts.prompt ?? '';
  if (opts.appendSystemPrompt === undefined || opts.appendSystemPrompt.trim().length === 0) {
    return prompt;
  }
  return `${opts.appendSystemPrompt}\n\n${prompt}`;
}

/** What a turn is told when it was entitled to brokered Verity tools but the
 * adapter could not be handed them. Exported so both profile tests can assert
 * the exact text delivered through their different system-prompt channels. */
export const GATEWAY_UNAVAILABLE_DIRECTIVE = `## Brokered Verity tools unavailable

This turn started without the Verity MCP gateway because this agent adapter does not advertise HTTP MCP support. Tools such as \`verity_http_request\`, \`verity_secret_run\`, and the control-plane session tools are absent for this turn only. Report this reason when a request needs one of them; do not look for a substitute credential, socket, or CLI, and do not claim only that a tool is missing.`;

/** Fold a Verity directive into the caller's existing system prompt rather than
 * replacing it and trading one silent loss for another. */
function withSystemDirective(opts: RunTurnOptions, directive: string): RunTurnOptions {
  const existing = opts.appendSystemPrompt;
  return {
    ...opts,
    appendSystemPrompt:
      existing === undefined || existing.trim().length === 0
        ? directive
        : `${existing}\n\n${directive}`,
  };
}

function promptBlocks(opts: RunTurnOptions, profile: AcpBackendProfile): ContentBlock[] {
  return [{ type: 'text', text: profile.promptText(opts) }, ...imageBlocks(opts.attachments)];
}

function usage(value: acp.Usage | null | undefined): Usage {
  if (value === null || value === undefined) return ZERO_USAGE;
  return {
    inputTokens: value.inputTokens,
    outputTokens: value.outputTokens,
    cacheReadTokens: value.cachedReadTokens ?? 0,
    cacheCreationTokens: value.cachedWriteTokens ?? 0,
  };
}

function recordInput(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Whether this request picks a permission posture rather than approving a
 *  single tool call. Two conditions, both required. It has to come from the
 *  profile's mode-picking tool — the name the approval card showed, so the
 *  request Verity reads as a posture is the one the operator answered as a
 *  plan. And EVERY option has to name one of the session's own modes: an
 *  ordinary request offers opaque ids (`allow`, `allow_always`, `reject`) that
 *  no mode answers to, so it is never read as a posture however its ids are
 *  spelled.
 *
 *  Neither condition authenticates anything — over ACP the agent writes both
 *  the option ids and the tool name. What they buy is that an approval can only
 *  carry a posture (and with it the durable `allow_always` a plan approval
 *  offers) when the card the operator saw named the plan tool. An approval for
 *  `Bash` cannot become one. */
function isModePicker(
  request: RequestPermissionRequest,
  sessionModes: ReadonlySet<string>,
  tool: string,
  pickerTool: string | undefined,
): boolean {
  return (
    pickerTool !== undefined &&
    tool === pickerTool &&
    request.options.length > 0 &&
    request.options.every((candidate) => sessionModes.has(candidate.optionId))
  );
}

function permissionOption(
  request: RequestPermissionRequest,
  decision: PermissionDecision,
  preferredMode: string | undefined,
  modePicker: boolean,
): RequestPermissionResponse {
  // ACP v1 permission outcomes cannot carry Claude's edited tool input. Never
  // turn an edited approval into execution of the original, now-rejected input.
  if (decision.behavior !== 'allow' || decision.updatedInput !== undefined) {
    const reject = request.options.find((candidate) => candidate.kind === 'reject_once');
    if (reject === undefined) return { outcome: { outcome: 'cancelled' } };
    return { outcome: { outcome: 'selected', optionId: reject.optionId } };
  }
  // A mode-carrying request — Claude's `ExitPlanMode` — offers one allow option
  // per permission posture, so approving the plan also PICKS the mode the rest
  // of the turn runs in. Verity's card is a plain allow/deny, and its plain
  // `allow_once` there is "yes, and approve every edit by hand": it silently
  // drops the session out of the configured mode and turns the rest of the turn
  // into a prompt per edit. Prefer the option that keeps the posture Verity set.
  // A posture Verity cannot approve INTO — `plan` is offered as the "no, keep
  // planning" reject — has no allow option here; fall back to `allow_once`,
  // which is the agent's own default for the choice.
  //
  // Only a mode picker is read that way, so an ordinary request's
  // `allow_always` — a durable grant Verity deliberately keeps for itself —
  // stays out of reach.
  const preferred =
    preferredMode === undefined || !modePicker
      ? undefined
      : request.options.find(
          (candidate) =>
            candidate.optionId === preferredMode &&
            (candidate.kind === 'allow_once' || candidate.kind === 'allow_always'),
        );
  const option = preferred ?? request.options.find((candidate) => candidate.kind === 'allow_once');
  if (option === undefined) return { outcome: { outcome: 'cancelled' } };
  return { outcome: { outcome: 'selected', optionId: option.optionId } };
}

/** How long a turn whose prompt has answered waits for an in-flight
 *  `session/set_mode` to settle before finishing without it. */
const MODE_SETTLE_MS = 2_000;

/** How many times that wait re-samples the restore chain. A drift announced
 *  while the previous pull-back was settling queues another one behind it, and
 *  the tail sampled before it is already stale — but an agent that keeps
 *  switching modes must not hold the turn open by the pass. */
const MODE_SETTLE_PASSES = 3;

/** Wait for `work` to settle, but never longer than {@link MODE_SETTLE_MS}.
 *  Answers whether it settled — giving up on it is itself worth reporting. The
 *  timer is unref'd so a turn that gives up does not hold the process. */
async function settled(work: Promise<unknown>): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work.then(
        () => true,
        () => true,
      ),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), MODE_SETTLE_MS);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function permissionRequest(request: RequestPermissionRequest, name: string): PermissionRequest {
  return {
    requestId: request.toolCall.toolCallId,
    toolUseId: request.toolCall.toolCallId,
    toolName: name,
    input: recordInput(request.toolCall.rawInput),
  };
}

async function writeAll(writer: SessionWriter, events: readonly AgentEvent[]): Promise<void> {
  for (const event of events) await writer.write(event);
}

/** Session updates that mean the AGENT has produced something for the running
 *  turn — prose, reasoning, a plan, or a tool call. Anything else (a replayed or
 *  echoed `user_message_chunk`, a mode announcement) leaves the turn still
 *  holding no assistant message, which is exactly the state steering must not
 *  inject into. Used to arm the steering channel; see `turnHasAgentContent`.
 *
 *  All three `plan*` variants count: a turn that mutates or clears a plan
 *  carried over from an earlier turn has done agent work just as much as one
 *  that emits a fresh `plan`, and arming on only the first would leave such a
 *  turn permanently unsteerable. */
function isAgentContent(update: SessionUpdate): boolean {
  return (
    update.sessionUpdate === 'agent_message_chunk' ||
    update.sessionUpdate === 'agent_thought_chunk' ||
    update.sessionUpdate === 'tool_call' ||
    update.sessionUpdate === 'tool_call_update' ||
    update.sessionUpdate === 'plan' ||
    update.sessionUpdate === 'plan_update' ||
    update.sessionUpdate === 'plan_removed'
  );
}

function assertProfilePermissionMode(profile: AcpBackendProfile, value: string | undefined): void {
  if (value === undefined || profile.permissionModes === undefined) return;
  if (!profile.permissionModes.includes(value)) {
    throw new Error(
      `refusing to spawn ${profile.telemetryBackend} with permission mode '${value}' (§5b invariant)`,
    );
  }
}

/** One Verity turn over stable ACP v1. The ACP agent is still launched through
 * Verity's Spawner, so the sandbox spawn broker remains the credential and
 * process boundary regardless of which agent the profile selects. */
export async function runAcpTurn(
  opts: RunTurnOptions,
  profile: AcpBackendProfile,
): Promise<RunResult> {
  const spawner = opts.spawner ?? nodeSpawner;
  const args = opts.extraArgs ?? [];
  // The §5b permission-posture invariant used to be asserted by the native Claude
  // runner on the whole argv it built, which included the resolved `--permission-mode`.
  // That runner is gone (ADR 0012) and ACP splits the same posture across two inputs,
  // so both are checked here rather than only the one that still looks like argv:
  // `extraArgs` is the only argv a caller can put in front of an ACP agent, and
  // `permissionMode` is what the profile turns into the session's mode.
  //
  // The upstream bounds — `ALLOWED_PERMISSION_MODES` on the turns API (`server.ts`)
  // and on project config (`embedded.ts`) — do not make this redundant. A turn also
  // reaches a backend from inside the Sandbox, where `runner-worker-entry.ts` builds
  // `RunTurnOptions` from a supervisor start-turn request and forwards
  // `permissionMode` as a bare string. This is the spawn-time seam every one of those
  // paths passes through, which is exactly where §5b wants the invariant.
  //
  // Both are checked against the PROFILE's vocabulary, not the turns API's. That
  // allowlist is what an operator may ask for, while a mode can also be set internally
  // for a turn no operator drives — `Conductor.query` pins `dontAsk` so a meta query
  // cannot stall on a prompt nobody is there to answer. Holding the API list here would
  // reject that turn, and would impose Claude's modes on every other ACP agent besides:
  // this is the SHARED loop, so a Codex turn passing a Codex mode comes through here too.
  // What stays agent-agnostic is the flag scan inside `assertSafeArgs`, which every
  // profile gets whether or not it states a vocabulary — `--dangerously-*` is the same
  // request in any agent.
  assertSafeArgs(args, profile.permissionModes);
  assertProfilePermissionMode(profile, opts.permissionMode);
  const child = spawner(opts.command ?? profile.defaultCommand, args, {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    keepStdinOpen: true,
  });
  const writer = new SessionWriter(
    opts.store,
    {
      ...(opts.bus !== undefined ? { bus: opts.bus } : {}),
      ...(opts.onSession !== undefined ? { onSession: opts.onSession } : {}),
    },
    opts.storeSessionId,
  );
  const metaNamespace = profile.adapter?.metaNamespace;
  const adapter = new AcpEventAdapter(profile.adapter ?? {});
  // A store-visible transcript exists for this turn from the start when we are
  // resuming one, and from `session/new` onwards otherwise. Gates whether a
  // failure is worth an `error` row — NOT what this run reports as its bind.
  let sessionId = opts.resumeSessionId;
  // The conversation the adapter actually opened, and the only id this run
  // reports back. Set once `session/new` or `session/load` has ANSWERED, never
  // optimistically from `opts.resumeSessionId`: a load the adapter refused must
  // report NO id, because reporting the one we tried would invite the conductor
  // to re-pin the session to the dead pointer that just failed.
  let boundSessionId: string | undefined;
  // The agent answered `session/load` with an error: it does not have the
  // conversation this session is bound to. Reported as {@link RunResult.staleResume}
  // so the conductor can drop the binding and start cold instead of re-resuming a
  // pointer that will be refused again on every future turn.
  let loadRefused = false;
  const topLevelText = new AcpTextStream();
  let updateTail: Promise<void> = Promise.resolve();
  let updateError: unknown;
  let aborted = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let cancelKillTimer: ReturnType<typeof setTimeout> | undefined;
  let cancelSession: (() => void) | undefined;
  let loadingSession = false;
  // The permission posture this turn should run in (`auto` for Claude): the
  // opening `session/set_mode`, which allow option a mode-carrying permission
  // request takes, and what a mid-turn mode switch is pulled back to. An
  // approval that itself names a posture moves it — the operator picked that
  // one, so the pull-back must not undo their own choice.
  let activeMode = profile.sessionMode?.(opts);
  // Both set only once the session has answered AND advertises the pinned mode
  // — the ACP adapter omits `auto` for models that cannot run it, and re-arming
  // a mode the session never offered is an error, not a correction.
  let restoreMode: (() => void) | undefined;
  let sessionModes: ReadonlySet<string> = new Set();
  // Serializes the pull-backs so a burst of mode updates cannot leave two
  // `session/set_mode` requests racing for the last word.
  let restoreTail: Promise<void> = Promise.resolve();
  // How many pull-backs are queued or on the wire. Serialization orders them
  // against each OTHER; it says nothing about a permission answer, which the
  // agent applies on its own. One already sent carries the posture that was
  // configured when it left, so the agent can apply it after the answer and
  // land the session in a mode the operator did not pick.
  let restoresPending = 0;
  // Set once the turn has drained: a pull-back that answers after that answers
  // into a transcript nobody is reading in order any more, and its note would
  // land behind the turn's own closing rows — or after `writer.finish()`.
  let closedOut = false;
  let acceptingSteering = true;
  let sendSteering: ((message: SteerMessage) => void) | undefined;
  // True once THIS turn has produced agent output (see {@link isAgentContent}).
  // Steering is refused until then: `_session/steering` appends a user message to
  // the running turn, and an agent engine whose turn holds no assistant message
  // yet ends that turn on a user message, which it treats as a broken turn and
  // aborts the whole process over (`[ede_diagnostic] result_type=user
  // last_content_type=n/a`) — the session badges as crashed and the turn is lost.
  // Refusing is not dropping: `onSteer` reporting false is the documented "not
  // steerable" answer, and the Conductor then queues the message as its own
  // `--resume` turn (conductor.ts `dispatchTurnInner`), which runs the moment
  // this one settles. So an operator who types a follow-up in the seconds
  // between accepting a prompt and the agent's first token gets it answered a
  // turn later instead of killing the session.
  let turnHasAgentContent = false;
  opts.onSteer?.((message) => {
    if (!acceptingSteering || !turnHasAgentContent || sendSteering === undefined) return false;
    sendSteering(message);
    return true;
  });
  const stop = (operatorCancel: boolean): void => {
    if (operatorCancel) aborted = true;
    if (cancelSession === undefined) {
      killAgent(child);
      return;
    }
    cancelSession();
    // ACP cancellation is cooperative. Keep the process boundary as a hard
    // backstop if a broken adapter never settles its prompt request.
    cancelKillTimer ??= setTimeout(() => killAgent(child), COOPERATIVE_CANCEL_TIMEOUT_MS);
  };
  const cancel = (): void => stop(true);
  if (opts.signal?.aborted === true) cancel();
  else opts.signal?.addEventListener('abort', cancel, { once: true });
  if (opts.timeoutMs !== undefined) timeout = setTimeout(() => stop(false), opts.timeoutMs);

  const onPermission = async (
    request: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> => {
    // The ACP agent emits the referenced `tool_call` notification before it
    // asks for approval, but its permission payload carries
    // `_meta.<namespace>.toolName` only for a subagent's tool. Let the queued
    // updates land first so the approval card can name the tool from the
    // adapter's own snapshot ("Bash") and agrees with the `tool_call` events
    // for the same id. Without it the card falls back to ACP's `title`, which
    // for Bash is the raw command line. Drained even with no card to write: the
    // tool name is also how a mode picker is told apart from an ordinary
    // request, and BOTH answers can move the session.
    await drainUpdates().catch(() => undefined);
    const id = request.toolCall.toolCallId;
    const name = adapter.knownToolName(id) ?? toolName(request.toolCall, metaNamespace);
    // Decided once, from the tool name the card carried, so the answer and the
    // posture it may move cannot be judged by different rules.
    const modePicker = isModePicker(request, sessionModes, name, profile.modePickerTool);
    // Answering a mode picker moved the session, whichever option it picked, so
    // adopt that as the posture to hold for the rest of the turn — otherwise the
    // drift pull-back undoes the answer one update later. An ordinary approval
    // never moves the session, however its option ids happen to be spelled.
    const adopt = (response: RequestPermissionResponse): RequestPermissionResponse => {
      if (modePicker && response.outcome.outcome === 'selected') {
        // A pull-back queued before this answer names the posture that was
        // configured when it was queued, and the agent applies it whenever it
        // gets to it — possibly after this answer has already moved the
        // session. That would leave the turn in a mode nobody picked, and in
        // the refusal case a permissive one where the operator said "keep
        // planning". Assert the adopted posture once more BEHIND the
        // outstanding pull-back, which is the only ordering the agent honours.
        const contested = restoresPending > 0 && response.outcome.optionId !== activeMode;
        activeMode = response.outcome.optionId;
        // `pin` reads `activeMode` when it runs, so this re-asserts the mode
        // adopted just above, not the one being pulled back to.
        if (contested) restoreMode?.();
      }
      return response;
    };
    if (opts.permissionControl !== true || opts.onPermissionRequest === undefined) {
      // No approval UI is wired, so every request is refused. On a mode picker
      // the refusal IS "no, keep planning" and lands the session in `plan`;
      // pulling it back to the configured posture would turn a turn Verity
      // declined to approve into one that runs unattended.
      const reject = request.options.find((option) => option.kind === 'reject_once');
      return adopt(
        reject === undefined
          ? { outcome: { outcome: 'cancelled' } }
          : { outcome: { outcome: 'selected', optionId: reject.optionId } },
      );
    }
    const neutral = permissionRequest(request, name);
    // Every prompt through the ACP adapter is on the ACP channel, whichever agent is
    // behind it: that is the transport whose calls cannot be attested (ADR 0014 D3).
    await writer.writePermission(neutral, 'acp');
    return await new Promise<RequestPermissionResponse>((resolve) => {
      opts.onPermissionRequest?.(neutral, (decision) => {
        resolve(adopt(permissionOption(request, decision, activeMode, modePicker)));
      });
    });
  };

  const onUpdate = async (update: SessionUpdate): Promise<void> => {
    // The agent switches modes on its own — a model switch that clamps a mode
    // the new model cannot run, an approval Verity answered generically. Its
    // posture is the operator's, not the turn's, so pull it back rather than
    // finishing the turn in a mode nobody chose. Deliberately not awaited: this
    // runs inside the ordered update queue, which the ACP connection awaits
    // before decoding the next line, so waiting here for a response that has to
    // arrive on that same line stream would deadlock the turn. A pull-back that
    // fails is reported as a `notice` instead of failing the turn — which is why
    // a switch announced after the turn closed out is left alone: there is no
    // longer a transcript to report its outcome into, so it would move the
    // agent's persisted session behind the operator's back, and the next turn
    // pins the mode at `session/new` anyway.
    if (
      update.sessionUpdate === 'current_mode_update' &&
      update.currentModeId !== activeMode &&
      !closedOut
    ) {
      restoreMode?.();
    }
    if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
      if (parentToolId(update._meta, metaNamespace) === undefined) {
        await writeAll(writer, topLevelText.push(update.content.text));
        return;
      }
    }
    await writeAll(writer, adapter.consume(update));
  };
  const queueUpdate = (update: SessionUpdate): Promise<void> => {
    const queued = updateTail.then(() => onUpdate(update));
    updateTail = queued.catch((error: unknown) => {
      updateError ??= error;
    });
    return queued;
  };
  const drainUpdates = async (): Promise<void> => {
    // Let notification callbacks already decoded ahead of PromptResponse join
    // the queue, then wait for their persist-before-publish work in wire order.
    await new Promise<void>((resolve) => setImmediate(resolve));
    await updateTail;
    if (updateError !== undefined) {
      throw updateError instanceof Error
        ? updateError
        : new Error('ACP session update persistence failed', { cause: updateError });
    }
  };

  try {
    const result = await acp
      .client({ name: 'verity' })
      .onRequest(acp.methods.client.session.requestPermission, ({ params }) => onPermission(params))
      .onNotification(acp.methods.client.session.update, ({ params }) => {
        // Suppressed history replay is NOT this turn's content, so it must not
        // arm steering. Arm on decode rather than inside `onUpdate`, so the
        // channel opens as soon as the agent has spoken instead of trailing the
        // persist queue.
        if (loadingSession) return Promise.resolve();
        if (isAgentContent(params.update)) turnHasAgentContent = true;
        return queueUpdate(params.update);
      })
      .connectWith(processStream(child), async (agent) => {
        const initialized = await agent.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          ...(profile.clientCapabilitiesMeta !== undefined
            ? { clientCapabilities: { _meta: profile.clientCapabilitiesMeta } }
            : { clientCapabilities: {} }),
        });
        // ADR 0014 D1: an ACP agent has no attested native tool channel, so the
        // brokered Verity tools are offered to it as an HTTP MCP server on the
        // Server's project-bound broker endpoint, authenticated with this turn's
        // bearer. Offered only when the agent advertises HTTP MCP support — an
        // agent that cannot reach the server would otherwise be handed tools it
        // can never call. Every call is still approval-gated server-side; the
        // bearer identifies the turn, it does not authorize anything.
        const gateway = opts.mcpGateway;
        const agentSpeaksHttpMcp = initialized.agentCapabilities?.mcpCapabilities?.http === true;
        const mcpServers: McpServer[] =
          gateway !== undefined && agentSpeaksHttpMcp
            ? [
                {
                  type: 'http',
                  name: 'verity',
                  url: gateway.url,
                  headers: [{ name: 'Authorization', value: `Bearer ${gateway.token}` }],
                },
              ]
            : [];
        // A bearer was minted but no server was offered, so tell the turn through the
        // channel its profile supports. Claude carries this in `sessionMeta`; Codex and
        // OpenCode have no native system-prompt slot and receive it in `promptBlocks`.
        const turnOpts =
          gateway !== undefined && !agentSpeaksHttpMcp
            ? withSystemDirective(opts, GATEWAY_UNAVAILABLE_DIRECTIVE)
            : opts;
        const request = {
          cwd: opts.cwd,
          mcpServers,
          _meta: profile.sessionMeta(turnOpts),
        };
        let session: NewSessionResponse;
        if (opts.resumeSessionId !== undefined) {
          if (initialized.agentCapabilities?.loadSession !== true) {
            throw new Error(profile.loadSessionUnsupported);
          }
          // Each Verity turn starts a fresh ACP adapter process. `session/resume`
          // addresses a live resource in one adapter process, whereas
          // `session/load` restores the agent's persisted conversation in a new
          // process. Loading replays history through session/update; Verity's
          // canonical event store already contains it, so discard only those
          // replay notifications.
          loadingSession = true;
          const loaded = await agent
            .request(acp.methods.agent.session.load, {
              ...request,
              sessionId: opts.resumeSessionId,
            })
            .catch((error: unknown) => {
              // An ANSWERED "that conversation does not exist" only, and nothing
              // else. Two narrowings, each load-bearing:
              //
              // A JSON-RPC error object means the agent received the load and
              // answered it. A transport failure (the adapter died, the pipe broke)
              // says nothing about the conversation, so it must not disarm the
              // binding: the next turn should resume the same id against a healthy
              // adapter.
              //
              // And of the answers, only `resourceNotFound` is about the
              // conversation. An agent may equally refuse a load because it is not
              // authenticated (-32000), because its own state store failed
              // (-32603), or because the request was malformed — every one of those
              // is a condition of the moment, and dropping a live binding on one
              // would discard a conversation the agent still has, permanently.
              if (error instanceof acp.RequestError && error.code === RESOURCE_NOT_FOUND) {
                loadRefused = true;
              }
              throw error;
            });
          session = { sessionId: opts.resumeSessionId, ...loaded };
        } else {
          session = await agent.request(acp.methods.agent.session.new, request);
        }
        sessionId = session.sessionId;
        boundSessionId = session.sessionId;
        cancelSession = () => {
          void agent
            .notify(acp.methods.agent.session.cancel, { sessionId: session.sessionId })
            .catch(() => killAgent(child));
        };
        // `model` is the REQUESTED id, not necessarily the one that serves the turn.
        // This event has to be written here — it carries the agent's session id, which
        // downstream state binds to, and it precedes `configureSession`, which is where
        // a profile learns whether the session's vocabulary even contains the requested
        // model. A profile that cannot select it says so with a notice naming the model
        // that does run (see `acp-codex-backend.ts` and `acp-opencode-backend.ts`); the
        // event, and the usage attribution derived from it, keep the requested id.
        // Correcting them would mean a second, later `session` event or a mutable
        // model field on the session record — worth doing when attribution has to be
        // exact, and deliberately not part of the OpenCode migration.
        await writer.write({
          t: 'session',
          id: session.sessionId,
          model: opts.model ?? profile.defaultModelLabel(opts),
          worktree: opts.worktree,
        });
        await writer.write({ t: 'status', state: 'running' });
        sessionModes = new Set(session.modes?.availableModes.map((mode) => mode.id) ?? []);
        let setMode: (() => Promise<unknown>) | undefined;
        if (activeMode !== undefined && sessionModes.has(activeMode)) {
          const pin = (): Promise<unknown> =>
            agent.request(acp.methods.agent.session.setMode, {
              sessionId: session.sessionId,
              modeId: activeMode,
            });
          setMode = pin;
          restoreMode = () => {
            restoresPending += 1;
            restoreTail = restoreTail
              .then(pin)
              .then(() => undefined)
              .catch(() => {
                // A refused pull-back is not worth failing the turn over, but it
                // must not pass silently either: the rest of the turn then runs
                // in a posture nobody chose, and the transcript is the only
                // place the operator can see that. Queued with the session's
                // other events so the note lands in wire order — and only while
                // there is still a turn to write it into.
                if (closedOut) return;
                const mode = activeMode;
                updateTail = updateTail
                  .then(() =>
                    writer.write({
                      t: 'notice',
                      text: `Could not restore the "${mode ?? 'configured'}" permission mode; this turn continues in the mode the agent switched to.`,
                    }),
                  )
                  .catch(() => undefined);
              })
              .finally(() => {
                restoresPending -= 1;
              });
          };
        } else {
          // A mode the session never offered stays unarmed: the adapter omits
          // `auto` for models that cannot run it, and its own clamped mode is
          // the safe one to keep.
          activeMode = undefined;
        }
        await profile.configureSession?.(
          {
            sessionId: session.sessionId,
            session,
            request: (method, params) => agent.request(method, params),
            notice: async (text) => {
              await writer.write({ t: 'notice', text });
            },
          },
          opts,
        );
        // Pinned after the profile's own setup, and unconditionally: selecting a
        // model can clamp the session into a mode that model supports, and on a
        // loaded session the `current_mode_update` announcing it is suppressed
        // along with the replayed history. The mode the session reported at
        // creation is therefore not evidence of the mode it is in now — assert
        // it rather than trust it. Awaited, unlike the drift pull-back: the mode
        // has to hold before the prompt goes out, or the turn's first tool call
        // runs in a posture nobody chose.
        if (setMode !== undefined) {
          try {
            await setMode();
          } catch {
            // The mode catalogue is reported once, at session creation, and ACP
            // offers no way to re-read it: `session/set_config_option` answers
            // with config options only. So a model selected just above can have
            // narrowed the modes out from under the pin — the adapter drops
            // `auto` for models that cannot run it — and the assertion is the
            // first place that shows. The agent's clamped mode is the safe one
            // to keep, and a posture Verity never got is not worth failing a
            // turn over. Disarm rather than retry: a pull-back to a mode this
            // session refuses would fail identically for the rest of the turn,
            // and with no posture of our own an `ExitPlanMode` picker falls
            // back to the agent's default choice.
            const wanted = activeMode;
            activeMode = undefined;
            restoreMode = undefined;
            await writer.write({
              t: 'notice',
              text: `The agent refused the "${wanted ?? 'configured'}" permission mode; this turn runs in the mode it chose instead.`,
            });
          }
        }
        sendSteering = (message) => {
          void agent
            .request('_session/steering', {
              sessionId: session.sessionId,
              prompt: [{ type: 'text', text: message.text }, ...imageBlocks(message.attachments)],
              _meta: { steering: { idleBehavior: 'promptRequired' } },
            })
            .catch(() => undefined);
        };
        // Keep load-history suppression active through all session setup. The
        // new prompt is the first point after which an agent_message_chunk can
        // belong to this turn rather than ACP's replay of canonical history.
        loadingSession = false;
        const prompt = await agent.request(acp.methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: promptBlocks(turnOpts, profile),
        });
        acceptingSteering = false;
        // Drain first: a `current_mode_update` decoded alongside the prompt
        // response only fires its pull-back once the queue admits it, so a tail
        // sampled before the drain would miss the restore the drain itself
        // starts. Then wait for that pull-back — its failure note is queued only
        // once it settles, and it belongs in THIS turn's transcript — bounded,
        // because an agent that never answers `session/set_mode` must not hold a
        // turn whose prompt has already returned. The second drain flushes a
        // note the restore queued while settling.
        //
        // Re-sampled rather than awaited once: a drift announced while the
        // pull-back was settling queues another one behind it, and the tail
        // sampled before that is already stale — the turn would close out with
        // the newest restore still in flight and `closedOut` swallowing its
        // note. Settled means a pull-back finished with nothing new behind it.
        let modeSettled = false;
        let modeAnswered = true;
        for (let pass = 0; pass < MODE_SETTLE_PASSES; pass += 1) {
          await drainUpdates();
          const tail = restoreTail;
          if (!(await settled(tail))) {
            modeAnswered = false;
            break;
          }
          if (tail === restoreTail) {
            modeSettled = true;
            break;
          }
        }
        await drainUpdates();
        closedOut = true;
        await writeAll(writer, adapter.flush());
        await writeAll(writer, topLevelText.flush());
        if (!modeSettled) {
          // Giving up on the pull-back leaves the same blind spot a refused one
          // would: the turn ran on in a posture nobody chose. Unknown rather
          // than failed, and said so either way — separating the agent that
          // never answered from the one that answered and switched away again,
          // because only the second is still changing modes as the turn ends.
          await writer.write({
            t: 'notice',
            text: modeAnswered
              ? `The agent kept switching away from the "${activeMode ?? 'configured'}" permission mode; this turn may have continued in another one.`
              : `The agent never answered the change back to the "${activeMode ?? 'configured'}" permission mode; this turn may have continued in another one.`,
          });
        }
        await writer.write({
          t: 'result',
          usage: usage(prompt.usage),
          stopReason: prompt.stopReason,
          telemetry: {
            backend: profile.telemetryBackend,
            mode: opts.resumeSessionId === undefined ? 'new' : 'resume',
            resumed: opts.resumeSessionId !== undefined,
          },
        });
        // An operator cancel is not a crash. A settled-by-cancel turn carries NO
        // terminal `status`; the conductor appends the canonical `interrupted`
        // marker instead. Writing `crashed` here badges every stopped turn as
        // failed: the mobile reducer keeps the last `status` and never
        // revisits it on `interrupted`, so client and server would disagree
        // (`deriveSessionStatus` settles on the later `interrupted`). A
        // cancellation Verity did not ask for — the turn timeout, which stops
        // the session without setting `aborted` — stays a crash.
        if (prompt.stopReason !== 'cancelled') {
          await writer.write({ t: 'status', state: 'completed' });
        } else if (!aborted) {
          await writer.write({ t: 'status', state: 'crashed' });
        }
        await writer.finish();
        return prompt;
      });
    return {
      sessionId: boundSessionId,
      exitCode: result.stopReason === 'cancelled' && !aborted ? 1 : 0,
      stderr: child.stderr(),
      aborted,
    };
  } catch (error) {
    acceptingSteering = false;
    const message = error instanceof Error ? error.message : String(error);
    await drainUpdates().catch(() => undefined);
    closedOut = true;
    // Preserve already-streamed prose and any completed Verity contract even
    // when the ACP process disconnects before returning PromptResponse.
    await writeAll(writer, adapter.flush()).catch(() => undefined);
    await writeAll(writer, topLevelText.flush()).catch(() => undefined);
    const stderr = `${child.stderr()}\n${message}`;
    // The ACP analogue of Codex's `thread.started` gate. `session/prompt` is
    // dispatched only after `session/new` or `session/load` has ANSWERED, and
    // that answer is the only thing that assigns `boundSessionId` — so an
    // unbound session is positive protocol evidence that this turn's prompt
    // never reached the agent, not the forbidden inference from missing
    // transcript events. Paired with an explicit rejection it is the one
    // failure class the conductor may replay (`maybeAutoResume`).
    //
    // Read off the adapter's stderr as well as the thrown message, the way the
    // retired native runner read `RunResult.stderr`: an agent that dies over a
    // rejected login prints the reason on stderr and leaves JSON-RPC with a
    // bare transport error, so the message alone would classify almost nothing.
    const failedBeforeExecution =
      !aborted && boundSessionId === undefined && isExplicitPreExecutionRejection(stderr);
    // An operator cancel reaches this path whenever the adapter dies before
    // answering `session/prompt` — cooperative `session/cancel` is ignored, or
    // the 5s backstop SIGTERMs the process — and `aborted` is set ONLY by the
    // operator signal (the turn timeout stops via `stop(false)`). The
    // disconnect is then self-inflicted, so record it exactly like the
    // cooperative cancel above and like the native backend: no `error` row for
    // a stop the operator asked for, and no terminal `status`, which the
    // mobile reducer would keep as `crashed` even after the conductor appends
    // `interrupted`. The message stays in the returned `stderr`.
    //
    // A replayable pre-execution failure is held out for the other reason: the
    // retry has to stay ONE logical transcript turn, and the conductor's own
    // defense-in-depth guard drops any attempt that persisted an event. Belt
    // and braces as the code stands — an unbound session means the writer never
    // bound either, so these two would buffer and then be discarded by
    // {@link SessionWriter.finish} — but the invariant is the point, and it
    // should not rest on where the writer happens to drop events today.
    if (sessionId !== undefined && !aborted && !failedBeforeExecution) {
      await writer.write({ t: 'error', kind: 'acp', message }).catch(() => undefined);
      await writer.write({ t: 'status', state: 'crashed' }).catch(() => undefined);
    }
    await writer.finish().catch(() => undefined);
    return {
      sessionId: boundSessionId,
      exitCode: aborted ? 143 : 1,
      stderr,
      aborted,
      ...(failedBeforeExecution ? { failedBeforeExecution: true as const } : {}),
      ...(loadRefused && !aborted ? { staleResume: true as const } : {}),
    };
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    if (cancelKillTimer !== undefined) clearTimeout(cancelKillTimer);
    opts.signal?.removeEventListener('abort', cancel);
    child.closeStdin?.();
    killAgent(child);
    void child.exited.catch(() => 1);
  }
}
