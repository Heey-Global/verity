/**
 * Server-level conditions the operator has to be told about, delivered on the
 * poll they are already making.
 *
 * WHY HERE AND NOT AS AN ALERT
 * ----------------------------
 * The incident this module comes from ran for hours with nothing said. A
 * Postgres restart under a live Server killed it; it came back SEALED, and
 * every project sandbox lost `/internal/git/sign` and `/internal/github/token`.
 * `GET /secret/status` knew. `GET /server/updates` knew. Nothing asked either
 * one unless the operator navigated to a screen that did, and the screen they
 * were on — the session list — kept rendering as if the Server were fine.
 *
 * So this rides the session list's existing 2 s poll rather than adding a
 * channel of its own: no new timer, no new failure mode, and it reaches the
 * screen the operator is actually looking at. A SEALED Server can still serve
 * `/sessions`, which is exactly the case that matters — the one where nothing
 * else looks wrong.
 *
 * Everything below is a pure function of an already-computed snapshot. The
 * probing lives at the call site so this file stays trivially testable and can
 * never itself become a reason `/sessions` fails.
 */

import type { CodexUsageHealth } from './codexUsage.js';
import { isTerminalOperationState, type UpdateOperation } from './self-update/update-operation.js';

/**
 * Codes are grouped by WHERE the signal rides, because that is the difference
 * the operator sees:
 *
 * - `secret_sealed`, `updater_unhealthy` are properties of the SERVER. One
 *   Server, one banner, and every session is equally affected — so they ride the
 *   `?envelope=1` list envelope and render once above the list.
 * - `usage_probe_unhealthy` is likewise one Server's account-wide quota probe.
 * - `sandbox_disconnected` is a property of ONE session. A fleet-wide banner
 *   would be the wrong shape for it: with two projects and one broken sandbox a
 *   banner either says nothing about which session is affected or says something
 *   untrue about the other. It rides the session summary instead, next to the
 *   session it is about.
 *
 * Both use this one type so the client has one renderer for both placements.
 */
export type AttentionCode =
  'secret_sealed' | 'updater_unhealthy' | 'sandbox_disconnected' | 'usage_probe_unhealthy';

/**
 * A remedy the client can offer as a tap, for the signals that have exactly one.
 *
 * Named as an INTENT rather than a route: which screen fixes a Codex sign-in is
 * the client's business and differs per client, and a server that shipped URLs
 * would break the moment one of them moved. Older clients ignore the field and
 * still render the sentence, which stands on its own — the action is an
 * accelerator, never the only way to learn what to do.
 */
export type AttentionAction = 'codex-login';

export interface AttentionSignal {
  readonly code: AttentionCode;
  /** One line, already operator-facing. The client renders it verbatim. */
  readonly message: string;
  /** Present only where a single, unambiguous remedy exists. */
  readonly action?: AttentionAction;
}

/** The shape `GET /secret/status` already computes. */
export type SecretStatus = 'unlocked' | 'sealed' | 'uninitialized' | 'unmanaged';

/**
 * What the Server could learn about the Updater over its control socket.
 *
 * `unreachable` is deliberately its own case rather than a null operation:
 * "the Updater is not answering" and "the Updater says there is nothing going
 * on" are opposite facts, and `/server/updates` already refuses to conflate
 * them (it answers 503 rather than a reassuring empty state).
 */
export type UpdaterProbe =
  | { readonly kind: 'unmanaged' }
  | { readonly kind: 'reachable'; readonly operation: UpdateOperation | null }
  | { readonly kind: 'unreachable' };

/**
 * How long an update may sit in one non-terminal state before it is stuck.
 *
 * Every non-terminal state advances on its own — `prepared` is not an operator
 * gate; the Updater's runner goes straight from `standby` into the cutover
 * ("prepared …; starting cutover", `self-update/update-runner.ts`). So any
 * non-terminal state that stops moving is a stall, and the only question is how
 * long is too long. 30 minutes is far above the slowest legitimate step (an
 * image pull on a slow link) and far below the hours the incident ran unseen.
 */
export const UPDATER_STALL_MS = 30 * 60 * 1000;

/**
 * How long the Codex quota probe may keep failing before it is worth a banner.
 *
 * The probe backs off exponentially and serves its last good reading meanwhile,
 * so a refused or garbled response costs nothing for a while — the meter is
 * merely a few minutes stale, which it always is between refreshes. What has to
 * be said is the state where the last good reading is now hours old and the
 * meter is silently showing a number nobody's account matches. 30 minutes is
 * past the probe's default backoff ladder (which tops out at 5 minutes, so no
 * single retry gap can trip this) and far short of that.
 *
 * It bounds the verdict's age as well as the failure's: see
 * {@link usageProbeSignal}.
 */
export const USAGE_PROBE_STALL_MS = 30 * 60 * 1000;

/**
 * The same patience, spent faster, for a sign-in the gateway REFUSED.
 *
 * Every other failure this file reports is an absence of an answer — a timeout, a
 * 429, a shape nobody could parse — and might be gone by the next attempt, which
 * is what {@link USAGE_PROBE_STALL_MS} buys. A refusal is a verdict: the gateway
 * looked at the stored Codex login and declined to serve it, and it will decline
 * the next one identically until somebody signs in again. Waiting half an hour to
 * say so is half an hour of Codex sessions failing their model calls for a reason
 * the Server already knows.
 *
 * Not zero, because a gateway restarting mid-rotation can refuse briefly. Five
 * minutes is past the probe's backoff ceiling, so as long as anything is reading
 * the meter, a second attempt has been made and refused before the banner appears
 * — and if nothing is, the freshness cut below withdraws the verdict anyway.
 */
export const SIGN_IN_REJECTED_STALL_MS = 5 * 60 * 1000;

export interface AttentionInputs {
  readonly secretStatus: SecretStatus;
  readonly updater: UpdaterProbe;
  /** Last outcome of the account-wide Codex quota probe; absent on a Server that
   *  does not run one, which is not a fault and says nothing. */
  readonly codexUsage?: CodexUsageHealth | undefined;
  readonly now: number;
}

/**
 * The signals worth interrupting the operator for, or an empty array.
 *
 * Empty is the healthy answer and the caller omits the field entirely, so a
 * healthy Server's `/sessions` payload is byte-identical to what it was before
 * this existed.
 */
export function attentionSignals(inputs: AttentionInputs): AttentionSignal[] {
  const signals: AttentionSignal[] = [];

  // `uninitialized` is deliberately NOT included: a Server that has never been
  // given a master password is mid-onboarding, not degraded, and onboarding has
  // its own screen. Only a Server that HAD a key and no longer has it in memory
  // is losing sandboxes work they expect to be able to do.
  if (inputs.secretStatus === 'sealed')
    signals.push({
      code: 'secret_sealed',
      message: 'Server is sealed — sessions cannot sign commits or use GitHub until you unlock it',
    });

  const stalled = stalledUpdate(inputs);
  if (inputs.updater.kind === 'unreachable')
    signals.push({
      code: 'updater_unhealthy',
      message: 'Updater is not answering — server updates cannot be started or reported',
    });
  else if (stalled !== null)
    signals.push({
      code: 'updater_unhealthy',
      message: `Server update stuck in "${stalled.phase}" since ${stalled.updatedAt} — it is not progressing`,
    });

  // Last, and the client shows only the first — so a refused Codex sign-in loses
  // its "sign in again" button while the store is sealed or the Updater is down.
  // That is the right way round: a sealed store cannot accept the new login the
  // button would fetch, so offering it there sends the operator through an OAuth
  // flow whose result is dropped on save. Fix what is above it and the button is
  // there on the next poll.
  const usage = usageProbeSignal(inputs);
  if (usage !== null) signals.push(usage);

  return signals;
}

/**
 * The signal for a Codex quota probe that has stopped working, or null.
 *
 * WHY THIS IS WORTH A BANNER AT ALL. The usage meter is the one number in Verity
 * that is read as ground truth and cannot be sanity-checked from inside the app:
 * a stale percentage is indistinguishable from a fresh one. When the probe dies,
 * `/provider-limits` still answers, the meter still renders, and it quietly
 * serves whatever percentage some session's last `rate_limit` event happened to
 * carry — which drifts arbitrarily far from the account as work continues
 * elsewhere. The failure mode is not a blank meter, it is a confident wrong one.
 *
 * WHAT IS DELIBERATELY NOT SAID:
 * - `unconfigured`/absent — a Claude-only Server has no Codex probe to lose, and
 *   a banner there would be permanent noise about a feature nobody asked for.
 * - `no-credential` with `everWorked: false` — no Codex login was ever installed.
 *   That is a setup state with its own screen, not a fault. A login that WAS
 *   working and stopped resolving is the opposite case and is reported: the meter
 *   froze at that moment and nothing else says so. A refusal needs no such flag —
 *   it is only ever raised for a login that exists and cannot be used.
 * - `idle` — the account has no window running. A true and unremarkable answer.
 * - `pending`/`ok` — nothing to say.
 * - Anything under {@link USAGE_PROBE_STALL_MS}, because the probe backs off and
 *   serves last-good, so a brief 429 is invisible to the operator anyway. A
 *   refusal gets {@link SIGN_IN_REJECTED_STALL_MS} instead — it is a verdict, not
 *   a missing answer, so there is far less to wait out.
 *
 * Worded by consequence: the operator cannot act on "HTTP 401 from the usage
 * endpoint", but they can act on "the meter is not your account's number".
 */
function usageProbeSignal(inputs: AttentionInputs): AttentionSignal | null {
  const health = inputs.codexUsage;
  if (health === undefined || !('since' in health)) return null;
  // Both timestamps are compared, and a comparison against NaN is false — which
  // for the withdrawal guard below means "not stale", i.e. it would assert a
  // verdict instead of withdrawing it. `server.ts` shape-checks an injected probe
  // rather than trusting it; this is the same care one field deeper.
  if (!Number.isFinite(health.since) || !Number.isFinite(health.at)) return null;
  if (health.state === 'no-credential' && !health.everWorked) return null;
  const stall =
    health.state === 'sign-in-rejected' ? SIGN_IN_REJECTED_STALL_MS : USAGE_PROBE_STALL_MS;
  if (inputs.now - health.since <= stall) return null;
  // The probe only attempts on demand, so a verdict can outlive the evidence for
  // it: with nobody reading the meter, `since` keeps growing against an attempt
  // made hours ago, and the endpoint may well have recovered since. Say nothing
  // rather than assert a failure nothing has checked recently — the next attempt
  // either clears it or renews it.
  //
  // This cannot silence a live failure for long: the client fetches
  // `/provider-limits` in the same `Promise.all` as the session list it renders
  // this banner on — `SessionListModel.refresh`, pinned by "merges account-global
  // provider limits into overview meters" in `mobile/src/models/sessionList.test.ts`
  // — and the probe's backoff tops out at CODEX_USAGE_MAX_BACKOFF_MS, so anyone
  // who can SEE the banner is also keeping `at` fresh. The cost is bounded and
  // one-sided: after a long unwatched gap the first poll suppresses the line and
  // the next one — two seconds later — carries it.
  //
  // One window for every state, refusals included, even though they blow their
  // fuse in a fifth of the time. The two numbers answer different questions: the
  // fuse asks how long a failure must persist before it is worth saying, and a
  // refusal earns a shorter one because it is a verdict rather than a missing
  // answer. This asks how stale the evidence may be, and a refusal does not decay
  // faster than anything else here — nothing but a new sign-in changes it, so a
  // reading from twenty minutes ago is as true as one from two.
  if (inputs.now - health.at > USAGE_PROBE_STALL_MS) return null;
  // Said on its own terms, because it is not really a story about a meter. The
  // gateway serves ONE Codex credential to every sandbox, so a login it refuses
  // for the quota probe is a login it refuses for model calls: Codex sessions get
  // 503 on every turn, and a line about a stale percentage would send the reader
  // looking for a display bug while their sessions are dead. Returning here also
  // keeps `unreachable(health)` below a compile-time proof — the state is narrowed
  // out of the union by the time the ternary sees it.
  if (health.state === 'sign-in-rejected')
    return {
      code: 'usage_probe_unhealthy',
      message:
        'Codex sign-in was refused — Codex sessions cannot run and the meter is frozen on its ' +
        'last reading; sign in to Codex again',
      action: 'codex-login',
    };
  // Every arm named, `failed` included: a future health state that carries `since`
  // would otherwise inherit whichever sentence sits in the fallback and say
  // something confidently wrong. `never` here makes that a compile error instead.
  const cause =
    health.state === 'http-error'
      ? `was refused${health.status === undefined ? '' : ` (HTTP ${health.status})`}`
      : health.state === 'unreadable'
        ? 'came back in a shape Verity does not understand'
        : health.state === 'no-credential'
          ? 'found no Codex sign-in to use'
          : health.state === 'failed'
            ? 'could not be reached'
            : unreachable(health);
  // An answer Verity half-read is a different situation from one it got nothing
  // out of, and the difference is exactly what the reader would do about it. At
  // zero windows the probe contributes nothing new — the meter runs on the last
  // good reading until those rows reach their reset, and on whatever percentage a
  // session's `rate_limit` event last carried after that. Which of the two is on
  // screen is not worth a sentence; that neither is current is. Above zero the
  // meter IS the account's, freshly read, and what the moved shape costs is a row
  // — or nothing at all if the backend merely added a field. Claiming a stale
  // meter there would send someone hunting a number that is already correct.
  const consequence =
    health.state === 'unreadable' && health.windows > 0
      ? 'the Codex meter may be missing a window'
      : "the Codex meter is showing an older number, not your account's now";
  // No action on any of these. A refusal is the only cause that PROVES signing in
  // again is the remedy; every other one either survives a re-login (a 429, a moved
  // response shape, an unreachable host) or has a remedy that is not this button —
  // `no-credential` reads the same whether the login was removed, the secret store
  // is sealed, or the gateway has not been configured yet, and only the first of
  // those is fixed by a sign-in. A button that is right a third of the time teaches
  // the operator to distrust the one place it is always right.
  return {
    code: 'usage_probe_unhealthy',
    message: `Codex usage check ${cause} — ${consequence}`,
  };
}

/**
 * Compile-time proof that every unhealthy state above has its own sentence, with
 * a bland one at runtime rather than a throw: this file's promise is that nothing
 * about attention can take the session list down.
 */
function unreachable(state: never): string {
  void state;
  return 'did not succeed';
}

/**
 * The one line an operator gets instead of an SSH session.
 *
 * The incident: a project session could not run anything that needed a secret.
 * The broker answered "Verity could not serve this call" for even a trivial
 * test, `DOPPLER_TOKEN` was missing from the agent's environment, and the agent
 * — having no way to see why — guessed, wrongly, at `$HOME`. Finding the cause
 * took an operator with SSH correlating `/proc/<pid>/environ`, a Postgres row,
 * and `docker inspect` labels: the sandbox had been recreated, and what the
 * session was still talking to belonged to the generation before it.
 *
 * The Server had already worked that out. `classifyProjectSandbox` calls such a
 * sandbox `orphaned` on every reconcile tick — a sandbox that is running and
 * intact but cut off from the broker, so it has no signing, no GitHub token, no
 * secrets and no egress. It then repairs it by recreating it, EXCEPT while a
 * turn is in flight; and a session whose brokered calls keep failing keeps
 * retrying, which keeps the project busy, which defers the repair. So the one
 * state that most needs explaining is exactly the state that persists, and
 * nothing said it.
 *
 * WORDED BY CONSEQUENCE, NOT BY CAUSE. `orphaned` has two causes and the message
 * must not pick one: the sandbox's generation is no longer the one this process
 * serves (recreated sandbox, restarted Server), OR that generation's relay
 * container has exited under a sandbox whose generation is still current. The
 * operator sees the same failure either way and takes the same action either
 * way, and a message naming the wrong one of the two is worse than a message
 * naming neither.
 */
export const SANDBOX_DISCONNECTED_MESSAGE =
  "This session's sandbox lost its connection to Verity — signing, GitHub and secrets are " +
  'refused until it is rebuilt; end the turn to let Verity rebuild it';

export interface SessionAttentionInputs {
  /** The project this session runs in, or null/absent for a project-less session. */
  readonly projectId: string | null | undefined;
  /**
   * Projects whose sandbox the last relay reconcile found cut off from the
   * broker. A set the Server already maintains off the request path, so deciding
   * this per session costs one lookup and no I/O.
   */
  readonly disconnectedSandboxProjects: ReadonlySet<string>;
}

/** Signals about ONE session, or an empty array. Empty is the healthy answer and
 *  the caller omits the field, so a healthy session's summary is unchanged. */
export function sessionAttentionSignals(inputs: SessionAttentionInputs): AttentionSignal[] {
  const projectId = inputs.projectId;
  // A session with no project has no sandbox to be disconnected from.
  if (projectId === null || projectId === undefined) return [];
  if (!inputs.disconnectedSandboxProjects.has(projectId)) return [];
  return [{ code: 'sandbox_disconnected', message: SANDBOX_DISCONNECTED_MESSAGE }];
}

function stalledUpdate(inputs: AttentionInputs): UpdateOperation | null {
  if (inputs.updater.kind !== 'reachable') return null;
  const operation = inputs.updater.operation;
  if (operation === null || isTerminalOperationState(operation.state)) return null;
  const updatedAt = Date.parse(operation.updatedAt);
  // An unparsable timestamp is not evidence of a stall; the journal is the
  // Updater's own record and a malformed value is a different bug.
  if (Number.isNaN(updatedAt)) return null;
  return inputs.now - updatedAt > UPDATER_STALL_MS ? operation : null;
}
