import type { SandboxUpdate } from '../api.js';

/**
 * The pure part of how the app reports a stale project sandbox.
 *
 * The subtlety this module exists for: `state: 'available'` is NOT, on its own,
 * something to tell the operator about. Verity repairs its own sandboxes — the
 * relay reconciler rebuilds every one of them onto the current default image
 * after each Server restart, and on a released Server that image is pinned to the
 * Server's own version. So the minute after every Server update, every project in
 * the fleet legitimately reads `available` and then fixes itself. An indicator
 * bound to `state` alone therefore fires on every update, on every project, for
 * something nobody needs to do anything about — which is exactly how an operator
 * learns to ignore it on the one occasion it means something.
 *
 * `selfRepair` is that occasion: `stalled` means the sandbox will stay on the old
 * image until someone intervenes — either the automatic recreate has tried and
 * failed repeatedly, or the reconciler has looked at this sandbox and has nothing
 * to do about it. The latter is the case the "Verity repairs its own sandboxes"
 * premise does not cover: the reconciler decides from relay topology, not from
 * image staleness, so it only rebuilds a sandbox as a side effect of a Server
 * restart. On a deployment whose target image moves without one, nothing recreates
 * anything, and the Server reports `stalled` rather than a `converging` that would
 * never converge.
 *
 * `turnBlocked` is the third way the premise fails, and the only one where Verity
 * is working exactly as designed: the recreate is ready and refuses to interrupt a
 * live turn, so a project running an agent loop waits for as long as the loop
 * runs. Nothing on the Verity side will ever end that wait, which puts it on the
 * same footing as `stalled` for whether it is worth a glyph — and on a different
 * one entirely for what it should say, because here there IS something to do.
 */
export function sandboxUpdateNeedsAttention(
  update: SandboxUpdate | undefined,
): update is SandboxUpdate {
  if (update === undefined || update.state === 'current') return false;
  // Narrows away `undefined` only. It used to also promise `selfRepair: 'stalled'`,
  // which callers do read — and which is now one of two reasons to draw attention,
  // so a caller branching on that narrowing would silently take the `stalled` path
  // for a blocked update and describe a failure that did not happen.
  return update.selfRepair === 'stalled' || update.turnBlocked;
}

/** Whether the missed update carries a security fix — the one distinction that
 *  still changes how loudly a stuck sandbox should be reported.
 *
 *  `category` is the checker's verdict and wins outright where it exists; `kind`
 *  is the older, coarser field, read ONLY when `category` is absent, i.e. against
 *  a Server one release behind this app. Reading both as an `||` would let a
 *  stale `kind` re-flag an update the newer field explicitly classified as
 *  `software` or `configuration`. */
export function isSecuritySandboxUpdate(update: SandboxUpdate | undefined): boolean {
  return update?.category == null ? update?.kind === 'security' : update.category === 'security';
}

/**
 * What a project's sandbox update state means for the operator, as words.
 *
 * Four cases, because the honest answer differs by more than wording:
 * - `current`     — nothing to say.
 * - `converging`  — behind, and Verity is handling it. Reportable where there is
 *   room for a sentence (the project detail screen), never as an alert.
 * - `turnBlocked` — behind, and Verity is waiting for a turn that has been running
 *   long enough that it may not end on its own. The only case whose sentence names
 *   an action, because it is the only one the operator can resolve directly.
 * - `stalled`     — behind, and Verity has given up retrying.
 */
export function sandboxUpdateSummary(update: SandboxUpdate | undefined): string | null {
  if (update?.selfRepair === 'stalled' && update.state === 'unknown') {
    return 'Sandbox repair stuck — the sandbox could not be rebuilt';
  }
  if (update === undefined || update.state !== 'available') return null;
  const security = isSecuritySandboxUpdate(update);
  // Ahead of `stalled`: the Server raises both flags for a blocked update, and of
  // the two sentences only this one says what would actually move it.
  if (update.turnBlocked) {
    return security
      ? 'Security update waiting for a turn to finish — cancel it to update now'
      : 'Update waiting for a turn to finish — cancel it to update now';
  }
  return update.selfRepair === 'stalled'
    ? security
      ? 'Security update stuck — the sandbox is still on the old image'
      : 'Sandbox update stuck — the sandbox is still on the old image'
    : security
      ? 'Security update pending — Verity is rebuilding this sandbox'
      : 'Update pending — Verity is rebuilding this sandbox';
}

/**
 * The body of the overview's confirmation dialog for a sandbox that stopped
 * updating itself.
 *
 * Here rather than in the screen because the two sentences are a decision, not
 * presentation: whether Verity failed at something or is deliberately waiting is
 * the same distinction {@link sandboxUpdateSummary} draws, and keeping them apart
 * is how they drift. The caller supplies the buttons — a blocked update is
 * dismiss-only, since the Server refuses the recreate for as long as the turn
 * runs.
 */
export function sandboxUpdateAlertMessage(
  project: { owner: string; repo: string },
  update: SandboxUpdate,
): string {
  const security = isSecuritySandboxUpdate(update);
  const image = `it is still running the old image${security ? ', which is missing a security fix' : ''}`;
  // A blocked update is not a failure and must not be described as one: Verity is
  // holding the recreate off on purpose because recreating the container kills the
  // turn inside it. Saying so is also what makes the outcome predictable — the
  // Server refuses this request while the turn runs, so an operator told "retry"
  // would just collect a 409 without learning why.
  if (update.turnBlocked) {
    return (
      `${project.owner}/${project.repo} has a turn in flight, so Verity is not replacing its ` +
      `sandbox — ${image}. Cancel the turn first; recreating the container now would end it.`
    );
  }
  return (
    `Verity could not update ${project.owner}/${project.repo}'s sandbox on its own — ` +
    `${image}. This will recreate its container and retry.`
  );
}

/** The overview glyph for a sandbox that will not update itself. `tone` is
 *  semantic, resolved to a theme color by the RN layer, matching how
 *  {@link AttentionFlag} and {@link projectBadge} hand off. */
export interface SandboxUpdateIndicator {
  label: string;
  /** Feather icon name. */
  icon: 'shield' | 'alert-triangle' | 'clock';
  tone: 'danger' | 'attention';
}

/**
 * What, if anything, the project overview should draw next to a project.
 *
 * `undefined` for everything except an update that has stopped moving on its own —
 * never for a merely pending one, which is the whole point (see the module doc).
 * Deliberately NOT a download glyph: nothing here is an offer to update, it is a
 * report that an update did not happen. The security case gets a shield in
 * `danger` rather than the same triangle in a louder color, so the two are
 * distinguishable at glyph size.
 *
 * A turn-blocked update draws a clock rather than the triangle: the sandbox is
 * healthy and the update is queued behind work the operator owns, so a fault glyph
 * would send them looking for a fault. The security variant keeps the shield —
 * what is urgent about it does not become less urgent because a turn is why.
 */
export function sandboxUpdateIndicator(
  update: SandboxUpdate | undefined,
): SandboxUpdateIndicator | undefined {
  if (!sandboxUpdateNeedsAttention(update)) return undefined;
  const security = isSecuritySandboxUpdate(update);
  if (update.turnBlocked) {
    return security
      ? { label: 'Security update waiting for a turn', icon: 'shield', tone: 'danger' }
      : { label: 'Update waiting for a turn', icon: 'clock', tone: 'attention' };
  }
  return security
    ? { label: 'Security update stuck', icon: 'shield', tone: 'danger' }
    : { label: 'Sandbox update stuck', icon: 'alert-triangle', tone: 'attention' };
}
