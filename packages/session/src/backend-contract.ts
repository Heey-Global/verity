import { type PermissionDecision, type PermissionRequest } from '@verity/adapter-claude';
import type { AttachmentUpload } from '@verity/events';
import type { EventSink, TranscriptStore } from '@verity/store';
import type { EventBus } from './bus.js';

/**
 * The agent-neutral turn contract (ADR 0006). This leaf module holds the
 * options/result shapes and the spawn seam a backend runs a single turn against,
 * imported by {@link Backend} and every backend implementation. It deliberately
 * imports NOTHING from `./runner.ts` (the Claude runner) so the contract does not
 * depend on any one backend's implementation — the runner and the other backends
 * depend on this, not the reverse.
 */

export interface SpawnOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  /**
   * If set, the child gets a piped stdin; this string is written immediately. By
   * default the pipe is then closed (EOF) — the one-shot path, for an agent that
   * reads its whole input and exits. When omitted, stdin is `/dev/null` (the
   * argv-prompt path), preserving the original zero-stdin behaviour.
   */
  stdin?: string;
  /**
   * Keep the child's stdin OPEN after writing {@link stdin} instead of closing it
   * (EOF). This is what a bidirectional agent protocol needs — ACP's JSON-RPC
   * channel (ADR 0012) runs over the held-open pipe, and mid-turn steering (#101)
   * rides it: the caller streams further messages via
   * {@link SpawnedProcess.writeStdin} and closes it with
   * {@link SpawnedProcess.closeStdin} once the turn's terminal `result` lands (an
   * agent reading a stream waits for EOF before it exits). When false/omitted,
   * stdin is closed right after the initial write.
   */
  keepStdinOpen?: boolean;
}

export interface SpawnedProcess {
  /** Decoded stdout as a chunk stream. */
  stdout: AsyncIterable<string>;
  pid: number | undefined;
  /**
   * Resolves with an exit code once the process and its stdio have closed. A
   * signal termination maps to `128 + signum` (POSIX convention) so a killed or
   * crashed agent is never reported as a clean `0`.
   */
  exited: Promise<number>;
  /** The retained tail of stderr (diagnostics). */
  stderr: () => string;
  kill: (signal?: NodeJS.Signals) => void;
  /**
   * Write a chunk to the child's still-open stdin (steering input, #101). Returns
   * false when stdin is unavailable or already closed, so the caller can fall back
   * to queueing the message. Only meaningful when spawned with
   * {@link SpawnOptions.keepStdinOpen}; absent on a fake that doesn't model stdin.
   */
  writeStdin?: (data: string) => boolean;
  /**
   * Close the child's stdin (EOF), letting a streaming-input agent finish and
   * exit. Idempotent and safe to call on an already-dead child.
   */
  closeStdin?: () => void;
}

export interface Spawner {
  (command: string, args: readonly string[], options: SpawnOptions): SpawnedProcess;
}

export interface RunTurnOptions {
  /**
   * The persistence seam the runner's ingest drives (ADR 0006 D2). Typed as the
   * narrow {@link EventSink} rather than the concrete `EventStore` so a Runner can
   * be handed a substitute sink (the Stage 2 file-sink writing to the event
   * stream file) without gaining DB access. Every existing caller passes the real
   * `EventStore`, which implements `EventSink`, so nothing changes.
   */
  store: EventSink;
  /** Orchestrator-allocated worktree the agent runs in (§5a). */
  worktree: string;
  /** Working directory for the spawned process. */
  cwd: string;
  prompt?: string;
  /**
   * Backend-neutral attachments (v1: images) for this turn. Each backend
   * translates them into its own input: an ACP turn carries one image content
   * block per attachment alongside the prompt text in the `session/prompt`
   * request. Attachments never travel through argv, which is text-only.
   */
  attachments?: readonly AttachmentUpload[];
  model?: string;
  /**
   * Text appended to the agent's own system prompt (additive, never replacing
   * it). The conductor uses this when a backend
   * context is initialized to install Verity runtime directives such as the
   * end-of-turn Quick-Action `choices` contract (issue #97).
   */
  appendSystemPrompt?: string;
  /** Verity session id to persist events under when it differs from the backend resume id. */
  storeSessionId?: string;
  /** Backend session id to resume; omit to start a fresh backend session. */
  resumeSessionId?: string;
  /**
   * ADR 0006 Stage 4: the Server-allocated turn identity for this attempt. The
   * Conductor mints `turnId` + `startCommandId` before launch and persists them on
   * the in-flight marker (D2), then passes them here so the Runner stamps the SAME
   * `turnId` on every frame envelope — recovery keys turn discovery/idempotent
   * StartTurn on it. The loopback path ignores both; a runner that mints frames
   * (the file-tail/remote client) uses `turnId` instead of self-minting one.
   */
  turnId?: string;
  startCommandId?: string;
  /**
   * Enable mid-turn steering (#101): keep the turn's input channel open for the
   * whole run and surface an injection fn via {@link onSteer}. The channel is
   * closed automatically the moment the turn's terminal `result` is ingested, so
   * the agent exits. When false/omitted, the turn is delivered one-shot and
   * nothing can be folded into it once it is running.
   */
  steerable?: boolean;
  /**
   * Called once, synchronously after spawn, with a fn that folds an additional
   * operator message into the RUNNING turn — the agent injects it at its next step
   * boundary (verified mid-turn, not only at turn end). Returns false once the
   * turn has ended (stdin closed), so the caller falls back to queueing. Only
   * invoked when {@link steerable} is set.
   */
  onSteer?: (inject: (message: SteerMessage) => boolean) => void;
  /**
   * Enable the mid-turn permission approve/deny control loop (#27). Each backend
   * translates this into its own posture — an ACP turn runs in a permission mode
   * that raises `session/request_permission` — and surfaces every prompt to
   * {@link onPermissionRequest}. When false/omitted the agent follows its own
   * default permission posture and Verity never sees the prompts.
   */
  permissionControl?: boolean;
  /**
   * Called for each mid-turn permission prompt (#27) when {@link permissionControl}
   * is on. Handed the neutral request plus a `respond(decision)` fn that returns the
   * verdict over the backend's own control channel (allow with optional edited
   * input, or deny with a reason). The turn is PAUSED inside the agent until
   * `respond` is called exactly once; the conductor parks the decision until the
   * operator answers.
   *
   * A prompt still outstanding at turn end / abort / timeout MUST NOT hang the turn
   * or silently auto-allow. On ACP that holds by construction: the prompt is a
   * `session/request_permission` request over the agent connection, and settling the
   * turn tears that connection and the process down, so an unanswered prompt can only
   * end unanswered. A backend whose channel does NOT have that property — the retired
   * native stream-json transport was one, where a bare stdin EOF left a prompt
   * pending rather than denying it — owes an explicit fail-safe deny before it closes.
   */
  onPermissionRequest?: (
    request: PermissionRequest,
    respond: (decision: PermissionDecision) => void,
  ) => void;
  /**
   * The loopback MCP gateway an ACP turn reaches the brokered Verity tools through
   * (ADR 0014 D1). An ACP agent has no native tool relay, so the tools are offered
   * to it as an MCP server: `url` is the Server's project-bound broker endpoint as
   * seen from inside the Sandbox, `token` the bearer minted for THIS turn, which is
   * what lets the Server attribute an out-of-band call back to session and turn.
   * Omitted for every non-ACP backend, and for an ACP agent that does not advertise
   * HTTP MCP support — the tools are then simply absent rather than half-wired.
   */
  mcpGateway?: { url: string; token: string };
  /** Permission mode; defaults to `auto` (fleet operator default, §5b). */
  permissionMode?: string;
  /**
   * Per-turn tool allowlist (§5b). Each entry is a tool name or scoped pattern
   * (e.g. `Bash(git *)`); passed comma-joined to `--allowedTools`. Patterns may
   * contain spaces, so they're joined by comma (not space) to stay one argv arg.
   * Assumes patterns contain no commas (true for the agents' tool syntax today).
   */
  allowedTools?: readonly string[];
  /** Per-turn tool denylist; passed comma-joined to `--disallowedTools` (§5b). */
  disallowedTools?: readonly string[];
  command?: string;
  extraArgs?: readonly string[];
  /** Wall-clock ceiling for the whole session; on expiry the process is killed. */
  timeoutMs?: number;
  /**
   * Operator-cancel signal (issue #79). When it aborts, the spawned agent is
   * killed with SIGTERM; the run then settles normally (partial output already
   * persisted), so the caller distinguishes a cancel from a crash by checking
   * `signal.aborted`, not the exit code. The transcript-tail abort is separate.
   */
  signal?: AbortSignal;
  spawner?: Spawner;
  /**
   * If set, sync the agent's on-disk `.jsonl` transcript verbatim into this store
   * (live-tailed during the session), and restore it from the store before a
   * resume (so the file the agent reads survives a container rebuild, §5a).
   */
  transcript?: TranscriptStore;
  /** Claude home for transcript-path resolution; defaults to `~/.claude`. */
  claudeHome?: string;
  /** Fan-out seam: publish each persisted event to live subscribers (M3-2). */
  bus?: EventBus;
  /**
   * Called once with the agent-minted session id the moment it first binds
   * (the first `session` event). Lets a caller learn the id of a FRESH run
   * (no `resumeSessionId`) without awaiting the whole run — used by
   * `Conductor.startSession` to return the new id while the run continues.
   */
  onSession?: (sessionId: string) => void | Promise<void>;
  /**
   * Environment for the child. Defaults to the full `process.env`. NOTE (§16):
   * this also hands the host env to the agent's tool-bash. A per-agent
   * allowlist/scrub is a deliberate future hardening; pass a scrubbed env here
   * to opt in early.
   */
  env?: NodeJS.ProcessEnv;
  /** Advertise the native Secret Job tool only when its server backend is wired. */
  secretJobToolAvailable?: boolean;
  /** Advertise brokered HTTP only when its server backend is wired. */
  brokeredHttpToolAvailable?: boolean;
  /** ADR 0011 D4: expose the trusted CLI secret-injection tool for this turn. */
  trustedCliToolAvailable?: boolean;
}

export interface RunResult {
  sessionId: string | undefined;
  exitCode: number;
  /** Retained tail of the process's stderr (diagnostics). */
  stderr: string;
  /**
   * True iff THIS run was terminated by its operator-cancel {@link
   * RunTurnOptions.signal} (issue #79) — the abort handler fired and SIGTERMed
   * the process. Captured at kill time, so a signal that aborts AFTER the run has
   * already settled (a cancel racing a natural finish) does NOT set it. Callers
   * key the `interrupted` marker off this, never off the live `signal.aborted`.
   */
  aborted: boolean;
  /**
   * True only when the backend can positively confirm that the agent protocol
   * never began executing the submitted prompt. This is deliberately optional:
   * an absent value means "unknown", not "safe to retry". Orchestrators may use
   * this signal to replay a prompt, so backends must never infer it merely from
   * missing persisted transcript events.
   */
  failedBeforeExecution?: true;
  /**
   * True only when the backend was asked to resume a conversation and the AGENT
   * ANSWERED that request with an error — the session this turn is bound to is not
   * one this agent can restore. Set only on an answered refusal, never on a
   * transport failure, and never inferred: an absent value means "unknown".
   *
   * Orchestrators read this to escape a permanent wedge. A binding row outlives the
   * conversation it names in several ordinary ways — the agent pruned its own
   * history, the operator's data volume was replaced, or (ADR 0012 Amendment 4) the
   * id was minted by a transport that has since been retired — and a session that
   * only ever retries the same refused resume fails identically forever. Retrying
   * cold is safe on exactly this signal because a refused resume means no prompt was
   * ever submitted, so no side effect can be repeated.
   */
  staleResume?: true;
}

/**
 * Conservative provider rejection classifier. These failures are authoritative
 * because authentication/quota gates reject the request before an agent turn can
 * execute; an empty protocol stream without one of these messages stays unknown.
 */
export function isExplicitPreExecutionRejection(message: string): boolean {
  return (
    /\b(?:login required|not logged in|authentication failed|unauthorized|invalid api key|token expired)\b/i.test(
      message,
    ) ||
    /\b(?:rate limit|too many requests|quota exceeded)\b/i.test(message) ||
    /\b(?:limit|quota)\b.{0,40}\b(?:reached|exceeded)\b/i.test(message)
  );
}

/** A single operator message to fold into a running turn (#101): the prompt text
 * plus any backend-neutral attachments (v1: images). */
export interface SteerMessage {
  text: string;
  attachments?: readonly AttachmentUpload[];
}

/**
 * Input to {@link Backend.query}: a stateless one-shot model call for meta tasks
 * that must run the SAME engine a turn would (e.g. auto-titling a session) but must
 * NOT be a turn — no store, transcript, session context, or live process is
 * touched. The backend is chosen by the session's model exactly as a turn is, so
 * the query always uses the operator's selected LLM. Returns the model's raw text,
 * or `undefined` when the backend can't do a one-shot / it failed (the caller then
 * just skips).
 */
export interface QueryInput {
  /** The full prompt to send (already framed by the caller). */
  prompt: string;
  /** The session's model, routed by the backend (Claude id, `codex/…`, or
   * `providerID/modelID`). Omit for a backend's headless default. */
  model?: string | undefined;
  /** Working directory for a CLI-based backend. */
  cwd: string;
  /** Child env for CLI backends; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv | undefined;
  /** Spawn seam for CLI backends (the Docker wrapper injects a container-exec spawner). */
  spawner?: Spawner | undefined;
  /** Binary override for CLI backends. */
  command?: string | undefined;
  /** Cancel/timeout signal. */
  signal?: AbortSignal | undefined;
}
