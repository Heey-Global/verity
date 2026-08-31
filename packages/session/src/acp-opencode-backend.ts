import type { Backend } from './backend.js';
import type { RunResult, RunTurnOptions } from './backend-contract.js';
import {
  promptWithSystemDirectives,
  runAcpTurn,
  type AcpBackendProfile,
  type AcpSessionSetup,
} from './acp-backend.js';
import { toolNameFromKind } from './acp-adapter.js';
import { applySelectOption } from './acp-session-config.js';

/** opencode-acp exposes BOTH the model and the session mode as ACP session config
 *  options on the `session/new` answer — it advertises no ACP `modes` block, so the
 *  shared turn loop's `session/set_mode` path does not apply to it and the profile
 *  states no {@link AcpBackendProfile.sessionMode}. */
const MODEL_CONFIG_ID = 'model';
const MODE_CONFIG_ID = 'mode';

/** OpenCode's two session modes. `build` executes tools under the permissions its
 *  own config declares; `plan` disallows every edit tool. Verity maps its own
 *  posture onto these two and nothing else — see {@link openCodeMode}. */
const BUILD_MODE = 'build';
const PLAN_MODE = 'plan';

/** The label recorded on the `session` event when a turn names no model. The
 *  conductor only routes provider-qualified ids here, so in practice a model is
 *  always named; when one is not, the session keeps whatever model OpenCode's own
 *  config selected and this is the honest name for it.
 *
 *  Provider-qualified on purpose, mirroring Codex's `codex/default`: this string is
 *  persisted on the `session` event and read back as a model id, and ADR 0001 routes
 *  on the format. A bare `opencode` contains no `/`, so a session labelled with it
 *  would route its next turn to Claude and die on an unknown model. `opencode/…`
 *  routes back here, where `configureSession` recognizes it and leaves the account's
 *  own model alone — which is exactly what the label means. */
const OPENCODE_DEFAULT_MODEL_LABEL = 'opencode/default';

/**
 * Verity's permission posture, translated into OpenCode's session-mode vocabulary.
 *
 * This READS `opts.permissionMode` but never forwards it: the result is one of two
 * literals, so no caller-supplied string reaches the agent. That is what lets the
 * profile declare no {@link AcpBackendProfile.permissionModes} vocabulary — there is
 * no path by which an arbitrary mode could become this session's mode, which is the
 * §5b invariant that list exists to enforce. The day this function starts passing a
 * caller value through, it needs a vocabulary declared with it.
 *
 * Everything that is not planning maps to `build`, including Claude's `auto` and
 * `dontAsk`: OpenCode has no third posture to express a finer distinction in, and
 * inventing one by refusing the turn would make an unattended meta query fail on a
 * backend that can serve it perfectly well.
 *
 * What that costs is worth naming, because `dontAsk` means "do not stop to ask" and
 * `build` cannot promise it: whether a tool raises `session/request_permission` is
 * decided by OpenCode's own config, so an unattended turn can still meet a card. It
 * does not stall on one — the shared loop refuses every request when no approval UI
 * is wired (`acp-backend.ts`) — so the turn completes with that tool declined. An
 * unattended OpenCode turn therefore gets fewer tools than the same turn on Claude,
 * never more, which is the direction to be wrong in.
 */
export function openCodeMode(permissionMode: string | undefined): string {
  return permissionMode === PLAN_MODE ? PLAN_MODE : BUILD_MODE;
}

async function configureSession(setup: AcpSessionSetup, opts: RunTurnOptions): Promise<void> {
  // The default label is not a model — it is the name for "whatever OpenCode's own
  // config selected". Handing it back to the select would be asking for a value the
  // agent's option can never contain, and the miss is not silent: it posts the
  // "model is unavailable" notice into the chat, once per turn, describing a
  // preference nobody expressed. Codex gets this for free because `parseCodexModel`
  // resolves `codex/default` to undefined; here the label has to be named.
  if (opts.model !== undefined && opts.model !== OPENCODE_DEFAULT_MODEL_LABEL) {
    await applySelectOption(
      setup,
      MODEL_CONFIG_ID,
      opts.model,
      // Names the model that DOES run, because nothing else in the transcript will:
      // the `session` event is written before this runs and records the requested id
      // (see the comment on that write in `acp-backend.ts`), so a turn that fell back
      // is attributed to a model it never used. Codex has the same shape and the same
      // note. Safe to quote here: the model is the first option this profile sets, so
      // the snapshot behind `current` is still fresh.
      //
      // "was not applied" rather than "is unavailable": this note also carries the
      // read-back refusal, where the session offered the model, took the write, and
      // came back on another one. Both cases are true of the wording, and only one is
      // true of "unavailable".
      (value, current) =>
        `OpenCode model "${value}" was not applied; this turn runs on "${current}".`,
    );
  }
  // The mode is set LAST and unconditionally. Both knobs are independent options in
  // OpenCode's own model, but the `currentValue` this reads was reported before the
  // model was selected, and a posture is the wrong thing to infer from a stale read:
  // a skipped `plan` write would run an edit-free turn's tools for real. Asserting it
  // after the model also matches the order the Codex profile settled on.
  const mode = openCodeMode(opts.permissionMode);
  const outcome = await applySelectOption(
    setup,
    MODE_CONFIG_ID,
    mode,
    // Silent for `plan`, because that outcome ends the turn a few lines below and the
    // note would describe the opposite of what happens: the session does not keep its
    // mode, it stops. The error carries the explanation instead.
    // Deliberately does NOT quote `current`, unlike the model note above: the mode is
    // the second option this profile sets, so the snapshot it comes from was taken
    // before the model write and could name a mode the session has since left.
    (value) =>
      value === PLAN_MODE
        ? undefined
        : `OpenCode mode "${value}" was not applied; keeping the session's mode.`,
    { reassert: true },
  );
  // `set` here is the read-back one: `applySelectOption` compares the options the
  // agent echoes with its answer against what was asked for, so plan mode rests on
  // OpenCode reporting the session in `plan`, not merely on it not raising an error.
  if (outcome === 'set') return;
  // Not set, and the two postures part ways here. `plan` is a restriction the
  // operator asked for, and the only thing OpenCode offers to express it with is this
  // option — so a session that cannot take it cannot run the turn as asked, and the
  // failure mode of carrying on is precisely the one `plan` exists to prevent: an
  // edit-capable turn nobody authorised. Fail it. `build` asserts nothing the agent
  // does not already do by default, so a session that will not take it is at worst
  // stuck planning, which is visible in the transcript and harms nothing.
  if (mode !== PLAN_MODE) return;
  const why = {
    absent:
      'This OpenCode version exposes no session "mode" option, so plan mode cannot be enforced.',
    unavailable: 'This OpenCode session does not offer "plan" mode.',
    // Worth its own sentence: the session advertised `plan`, took the write without
    // complaint, and came back in another mode. Nothing the turn asked for was wrong,
    // so the next thing to look at is the agent, not the request.
    rejected: 'This OpenCode session accepted "plan" mode and then reported another.',
  }[outcome === 'absent' || outcome === 'unavailable' ? outcome : 'rejected'];
  throw new Error(`${why} Refusing the turn rather than running it with edit tools live.`);
}

const OPENCODE_ACP_PROFILE: AcpBackendProfile = {
  // A root-owned wrapper around `opencode acp`, not the `opencode` binary itself:
  // the sandbox spawn broker maps one command name to one fixed executable, and a
  // name that reached the multi-purpose CLI would let the caller's argv pick the
  // mode it starts in. The wrapper is installed by verity-sandbox-toolkit.
  defaultCommand: 'opencode-acp',
  telemetryBackend: 'opencode-acp',
  // Unreachable in practice — opencode-acp advertises `loadSession: true`, so the
  // shared loop resumes through `session/load` rather than raising this. Kept
  // because the contract requires a message for the agent versions that do not.
  loadSessionUnsupported: 'This OpenCode version does not support persistent session loading',
  // opencode-acp sets no tool `name`, only ACP's `kind` and a `title` that is the
  // command line for an execution and the file path once a read resolves.
  adapter: { resolveToolName: toolNameFromKind },
  // No session-level options: both knobs Verity sets are session config options,
  // applied once the session has answered with what this account can serve.
  sessionMeta: () => ({}),
  defaultModelLabel: () => OPENCODE_DEFAULT_MODEL_LABEL,
  // OpenCode has no system-prompt channel, so the directives prefix the prompt.
  promptText: (opts) => promptWithSystemDirectives(opts),
  // Deliberately no `sessionMode`: OpenCode's mode is a config option, not an ACP
  // mode, so arming the shared loop's `session/set_mode` path would send a request
  // this agent does not implement. `configureSession` sets it instead.
  //
  // No vocabulary, stated rather than omitted: `openCodeMode` collapses every
  // caller posture into one of two literals, so no caller-supplied string can become
  // this session's mode and there is nothing for a §5b allowlist to bound.
  permissionModes: undefined,
  configureSession,
};

/**
 * OpenCode behind the stable ACP-v1 client protocol (ADR 0001, ADR 0012 Amendment 4).
 *
 * This replaces the native HTTP transport — a client of a long-lived shared
 * `opencode serve` reached over `OPENCODE_BASE_URL`. That server was a second
 * process boundary Verity did not own, sat outside the Sandbox, and could not carry
 * a permission bridge; the adapter it needed was ~1.5k lines of Verity-maintained
 * SSE plumbing. `opencode acp` is a per-session child process launched through the
 * sandbox spawn broker like every other ACP agent, so the isolation boundary,
 * permission cards, cancellation, steering and persist-before-publish ordering all
 * come from the shared turn loop instead.
 *
 * Brokered secret tools are deliberately NOT on this transport yet. opencode-acp
 * does advertise `mcpCapabilities.http`, which is the hook ADR 0014's approval-gated
 * gateway uses, but enabling it is a decision about which agents may spend the
 * operator's secrets — not a side effect of changing transport. Until that decision
 * is taken, `opencode-acp` is absent from `ACP_WORKER_BACKENDS` and no gateway bearer
 * is minted for its turns, which is exactly the posture the native path had.
 */
export class AcpOpenCodeBackend implements Backend {
  readonly runnerSupervisorBackend = 'opencode-acp' as const;

  run(opts: RunTurnOptions): Promise<RunResult> {
    return runAcpTurn(opts, OPENCODE_ACP_PROFILE);
  }
}
