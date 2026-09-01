import * as acp from '@agentclientprotocol/sdk';
import type { SessionConfigOption } from '@agentclientprotocol/sdk';
import type { AcpSessionSetup } from './acp-backend.js';

/**
 * ACP session config options, as the profiles that drive them need them.
 *
 * Both agents Verity configures this way — codex-acp and opencode-acp — expose
 * their per-session knobs as `select` options on the `session/new` answer rather
 * than as `session/new` parameters, and both are set with the same round trip. The
 * helpers live here so a third profile inherits the shape checks instead of
 * re-deriving them, and so the "an option the session does not offer is not worth
 * failing a turn over" rule is written once.
 */

/** The `select` option with this id, or undefined when the session offers none.
 *  A non-select option of the same id is deliberately NOT returned: the caller's
 *  only vocabulary is a value list, which a non-select does not have. */
function selectOption(
  options: readonly SessionConfigOption[] | null | undefined,
  id: string,
): (SessionConfigOption & { type: 'select' }) | undefined {
  return options?.find(
    (option): option is SessionConfigOption & { type: 'select' } =>
      option.id === id && option.type === 'select',
  );
}

/** ACP allows a select's values to arrive flat or grouped; both agents Verity
 *  drives send them flat. Flatten either shape so callers only see values. */
function selectValues(option: SessionConfigOption & { type: 'select' }): string[] {
  return option.options.flatMap((entry) =>
    'value' in entry ? [entry.value] : entry.options.map((grouped) => grouped.value),
  );
}

/**
 * What {@link applySelectOption} did.
 *
 * Returned rather than swallowed because the two kinds of option Verity sets this
 * way answer to different rules. A model is a preference: any of these outcomes
 * leaves a turn that still runs, just not on the requested model. A permission
 * posture is a constraint the operator asked for, and a caller enforcing one has to
 * be able to tell `set` from the four ways of not setting it.
 */
export type SelectOutcome =
  /** The agent's answer shows the option holding `value`. */
  | 'set'
  /** The option already held `value`; skipped (never returned under `reassert`). */
  | 'unchanged'
  /** The session offers no `select` option with this id. */
  | 'absent'
  /** The option exists but does not offer `value`. */
  | 'unavailable'
  /** The write was answered, and the options it echoed back show the option
   *  somewhere other than `value`. Distinct from `unavailable` because the agent
   *  accepted a value it advertised and then did not apply it — nothing the caller
   *  could have avoided by asking for something else. */
  | 'rejected';

/**
 * Move a session `select` option to `value`, or explain in the transcript why it
 * stayed where it was, and report which of those happened.
 *
 * Every skip is a no-op rather than a thrown failure, because none of them is worth
 * losing a turn over on its own: the option may be absent (an agent version that
 * does not offer it), already correct (the common resume case), or name a value this
 * account cannot serve — the catalogue behind Verity's model picker refreshes on its
 * own schedule and can legitimately run ahead of what one session sees. A caller for
 * which one of those IS worth a turn acts on the returned outcome.
 *
 * `unavailable` is the operator-facing note for that last case, and for a write the
 * agent answered without applying (`rejected`) — from the turn's side those are one
 * fact: the option is not at the requested value and the turn goes on without it.
 * The other two skips say nothing: an option the agent never offered is not something
 * the operator asked for, and a value already in place is not news. It may return
 * `undefined` to stay silent, which is what a caller that turns this outcome into a
 * failed turn wants: a note reading "keeping the session's mode" immediately above an
 * error that ends the turn describes something that did not happen.
 *
 * It receives the option's `currentValue` alongside the refused one, so a note can
 * name what the turn actually runs with rather than only what it does not. Quote it
 * only for the FIRST option a caller sets: it is the same pre-write snapshot
 * `reassert` exists to distrust, so for a later option it can name a value the
 * session has since moved off.
 *
 * `reassert` drops the already-correct skip, for an option whose value must be true
 * of the turn rather than merely requested. `currentValue` is a snapshot of the
 * `session/new` (or `session/load`) answer, taken before any other option was set,
 * and setting one option can move another — Codex clamps its approval mode to what
 * the selected model supports. For a permission posture that stale read fails in the
 * dangerous direction: the snapshot says `plan`, the write is skipped, and the turn
 * runs in whatever mode the session actually drifted to. One extra round trip is the
 * cheaper side of that trade. An option that is only a preference should leave it
 * off, since a no-op write is still a round trip on every resumed turn.
 */
export async function applySelectOption(
  setup: AcpSessionSetup,
  configId: string,
  value: string,
  unavailable: (value: string, currentValue: string) => string | undefined,
  { reassert = false }: { reassert?: boolean } = {},
): Promise<SelectOutcome> {
  const option = selectOption(setup.session.configOptions, configId);
  if (option === undefined) return 'absent';
  if (!reassert && option.currentValue === value) return 'unchanged';
  if (!selectValues(option).includes(value)) {
    const note = unavailable(value, option.currentValue);
    if (note !== undefined) await setup.notice(note);
    return 'unavailable';
  }
  const answer = await setup.request(acp.methods.agent.session.setConfigOption, {
    sessionId: setup.sessionId,
    configId,
    value,
  });
  // Read the write back rather than trusting the ack. ACP's answer to this method is
  // the full option set with its resulting values (`SetSessionConfigOptionResponse`),
  // and opencode 1.18.21 does send it: a `mode` write comes back with the mode option
  // already reading `plan`. Since the plan gate is the whole of Verity's edit-tool
  // restriction on that backend, "the agent did not raise an error" is a weaker fact
  // than the one available for free in the same response.
  //
  // Missing options cannot prove the requested security posture. Fail closed.
  const echoed = selectOption(
    (answer as { configOptions?: readonly SessionConfigOption[] } | null | undefined)
      ?.configOptions,
    configId,
  );
  if (echoed === undefined) {
    const note = unavailable(value, option.currentValue);
    if (note !== undefined) await setup.notice(note);
    return 'rejected';
  }
  if (echoed !== undefined && echoed.currentValue !== value) {
    const note = unavailable(value, echoed.currentValue);
    if (note !== undefined) await setup.notice(note);
    return 'rejected';
  }
  return 'set';
}
