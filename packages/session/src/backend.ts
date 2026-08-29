import type { BrokeredGrantChannel } from '@verity/events';
import { type QueryInput, type RunResult, type RunTurnOptions } from './backend-contract.js';

export type { QueryInput } from './backend-contract.js';

/**
 * Backends whose process the runner supervisor can spawn on the operator's behalf.
 * Each key maps to a fixed executable in the sandbox spawn broker, so the set is
 * deliberately closed: a backend that is not listed here never runs behind the
 * broker's credential boundary. Keep it in sync with `WORKER_BACKENDS` in
 * `features/verity-sandbox-toolkit/bin/verity-runner-supervisor.mjs`.
 */
export const RUNNER_SUPERVISOR_BACKENDS = Object.freeze([
  'claude-acp',
  'codex-acp',
  'opencode-acp',
] as const);

export type RunnerSupervisorBackend = (typeof RUNNER_SUPERVISOR_BACKENDS)[number];

export function isRunnerSupervisorBackend(value: unknown): value is RunnerSupervisorBackend {
  return RUNNER_SUPERVISOR_BACKENDS.includes(value as RunnerSupervisorBackend);
}

/**
 * Which transport a brokered-secret decision was made on, or is being redeemed on
 * (ADR 0014 D3). Defined with the `permission` event that carries it to the approval
 * card (`@verity/events`), so the backend, the card, and the grant store all key on
 * one enum rather than three copies of it.
 */
export type { BrokeredGrantChannel } from '@verity/events';

/**
 * The channel a turn running through `backend` redeems grants on.
 *
 * Derived from the backend object the Conductor resolved for the turn, which is
 * server-side state: no part of it is reachable from the sandbox, the agent, or the
 * MCP request. ADR 0014 D3 requires exactly that. A caller-supplied channel would
 * let any workspace process that reached the loopback endpoint declare itself
 * `native` and inherit the stronger channel's grants — which is the whole exposure
 * the ceiling exists to bound.
 *
 * Every supervised backend uses ACP. Backends without a declared supervisor protocol
 * also fail closed to the restricted ACP channel.
 *
 * `opencode-acp` answers `acp` like the rest, and that answer is currently moot: it
 * is absent from `ACP_WORKER_BACKENDS`, so no gateway bearer is minted for its turns
 * and it raises no brokered prompt to redeem a grant against. Answering here anyway
 * keeps the two independent — the day OpenCode is admitted to the gateway, the
 * channel it redeems on is already the restricted one rather than a `default:` throw.
 *
 * The absent case is the one worth spelling out. `runnerSupervisorBackend` is
 * optional, so "no attested transport" and "this object lost the field" are the same
 * value here, and the second is easy to reach by accident: the field is re-spread
 * conditionally where the Server rebuilds a backend for a Sandbox turn, so a wrapper
 * that forgets it produces a backend that looks native to this function. Reading
 * absence as `native` would hand that wrapper the attested channel's unbounded
 * grants; reading it as `acp` costs a real backend nothing, because a backend that
 * omits it has no permission bridging, so it raises no brokered prompt to redeem a
 * grant against. No backend Verity ships omits it any more — OpenCode moved to
 * `opencode-acp` with the transport migration — so the case is now purely the
 * dropped-field one it always guarded against. `AcpClaudeBackend` declares
 * `claude-acp` and is therefore `acp` — a Claude turn now redeems on the restricted
 * channel, which is a tightening, not a regression.
 *
 * Every member of the union is still listed explicitly, so a protocol added to it
 * without a decision here fails the build rather than silently inheriting whichever
 * branch the fall-through happens to be.
 */
export function brokeredGrantChannel(backend: Backend): BrokeredGrantChannel {
  switch (backend.runnerSupervisorBackend) {
    case 'claude-acp':
    case 'codex-acp':
    case 'opencode-acp':
    case undefined:
      return 'acp';
    default:
      return assertUnreachableBackend(backend.runnerSupervisorBackend);
  }
}

/** Compile-time exhaustiveness for {@link brokeredGrantChannel}, with a runtime
 *  answer that fails closed if the types are ever bypassed (a value crossing a
 *  process boundary, a cast). */
function assertUnreachableBackend(backend: never): BrokeredGrantChannel {
  void backend;
  return 'acp';
}

/**
 * A model backend: runs ONE steering turn and resolves when it settles.
 *
 * The {@link Conductor} owns all turn orchestration (per-session serialization,
 * the queue, and the cancel/steer wiring) and delegates only the actual run to a
 * Backend. That seam lets a non-Claude backend (e.g. OpenCode — ADR 0001 / #143)
 * be slotted in without touching the conductor's call sites. Cancel (#79) and
 * mid-turn steer (#101) ride through `opts` (`signal` / `onSteer`), so they stay
 * backend-agnostic at this boundary.
 *
 * The contract (options/result/spawn seam) is agent-neutral and lives in the
 * leaf module {@link RunTurnOptions} / {@link RunResult} (`./backend-contract.ts`,
 * ADR 0006 Stage 0) — it deliberately does NOT import from `./runner.ts`, so the
 * Claude runner and every other backend depend on the contract, not the reverse.
 * Some field-level doc-comments still describe the Claude backend's concrete
 * handling (e.g. `--input-format stream-json`); those document one implementation,
 * not the contract.
 */
export interface Backend {
  /** Native runner-supervisor protocol supported by this backend, if any. */
  readonly runnerSupervisorBackend?: RunnerSupervisorBackend | undefined;
  run(opts: RunTurnOptions): Promise<RunResult>;
  closeSession?(sessionId: string): void;
  /** Optional stateless one-shot model query (see {@link QueryInput}). A backend
   * that omits it simply can't be used for meta tasks — the caller falls back. */
  query?(input: QueryInput): Promise<string | undefined>;
}
