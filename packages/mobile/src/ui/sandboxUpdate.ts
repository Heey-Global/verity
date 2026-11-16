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
 * What holds a blocked update off. `activity` is the honest answer when the
 * Server did not say — an older Server, or a probe that only answered "busy" —
 * and it names no remedy rather than guessing one. A turn wins over the others
 * because it is the one a recreate would kill outright.
 */
export type SandboxUpdateBlocker = 'turn' | 'dev_server' | 'preview' | 'activity';

export function sandboxUpdateBlocker(update: SandboxUpdate): SandboxUpdateBlocker {
  const by = update.blockedBy;
  if (by.includes('turn')) return 'turn';
  if (by.includes('dev_server')) return 'dev_server';
  if (by.includes('preview')) return 'preview';
  return 'activity';
}

const WAITING_FOR: Record<SandboxUpdateBlocker, string> = {
  turn: ' for a turn',
  dev_server: ' for a dev server',
  preview: ' for a preview',
  activity: '',
};

/** The short name of a blocked update: the overview glyph's label and the
 *  title of the dialogs it opens. */
export function sandboxUpdateWaitingLabel(update: SandboxUpdate): string {
  const subject = isSecuritySandboxUpdate(update) ? 'Security update' : 'Update';
  return `${subject} waiting${WAITING_FOR[sandboxUpdateBlocker(update)]}`;
}

/** Why a blocked update cannot be applied now, and what would let it — for the
 *  dialog behind the project's Update button. */
export function sandboxUpdateBlockedDetail(update: SandboxUpdate): string {
  switch (sandboxUpdateBlocker(update)) {
    case 'turn':
      return 'A turn is running in this project. Recreating the sandbox now would end it — cancel the turn first, then update.';
    case 'dev_server':
      return 'A dev server is running in this project. Recreating the sandbox now would stop it — stop the dev server first, then update.';
    case 'preview':
      return 'This project is shared as a preview. Recreating the sandbox now would interrupt it — stop sharing first, then update.';
    case 'activity':
      return 'This project is in use. Verity updates the sandbox once the activity ends.';
  }
}

/** One line for the inbox item of a blocked update. */
export function sandboxUpdateBlockedInboxMessage(update: SandboxUpdate): string {
  switch (sandboxUpdateBlocker(update)) {
    case 'turn':
      return 'A sandbox update waits for the running turn to finish.';
    case 'dev_server':
      return 'A sandbox update waits for a running dev server to stop.';
    case 'preview':
      return 'A sandbox update waits for a shared preview to stop.';
    case 'activity':
      return 'A sandbox update waits for project activity to finish.';
  }
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
    const subject = security ? 'Security update' : 'Update';
    switch (sandboxUpdateBlocker(update)) {
      case 'turn':
        return `${subject} waiting for a turn to finish — cancel it to update now`;
      case 'dev_server':
        return `${subject} waiting for a running dev server — stop it to update now`;
      case 'preview':
        return `${subject} waiting for a shared preview — stop sharing to update now`;
      case 'activity':
        return `${subject} waiting for project activity to finish`;
    }
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
 * The most recent failed automatic rebuild, as a dated sentence. A rebuild can
 * be an image update or a relay repair, so it is not called an update.
 *
 * Dated because the failure outlives the attempt that produced it: a retry can
 * wait for the Server's single build slot while the earlier refusal is still the
 * last thing recorded. While the sandbox is `converging` the sentence says the
 * failure was the previous attempt's; once the Server reports `stalled` it is the
 * latest. `timeZone` is for tests; the device zone is used otherwise.
 */
export function sandboxUpdateLastFailure(
  update: SandboxUpdate | undefined,
  timeZone?: string,
): string | null {
  const failure = update?.lastRepairFailure;
  if (!failure || update.state === 'current') return null;
  const at = new Date(failure.at);
  if (Number.isNaN(at.getTime())) return null;
  const when = new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
    ...(timeZone === undefined ? {} : { timeZone }),
  }).format(at);
  return update.selfRepair === 'stalled'
    ? `Last automatic rebuild failed ${when}: ${failure.message}`
    : `Retrying — the previous automatic rebuild failed ${when}: ${failure.message}`;
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
    const name = `${project.owner}/${project.repo}`;
    switch (sandboxUpdateBlocker(update)) {
      case 'turn':
        return (
          `${name} has a turn in flight, so Verity is not replacing its ` +
          `sandbox — ${image}. Cancel the turn first; recreating the container now would end it.`
        );
      case 'dev_server':
        return (
          `${name} has a running dev server, so Verity is not replacing its sandbox — ${image}. ` +
          'Stop the dev server first; recreating the container now would end it.'
        );
      case 'preview':
        return (
          `${name} is shared as a preview, so Verity is not replacing its sandbox — ${image}. ` +
          'Stop sharing it first; recreating the container now would interrupt it.'
        );
      case 'activity':
        return (
          `${name} is in use, so Verity is not replacing its sandbox — ${image}. ` +
          'It updates once the activity ends.'
        );
    }
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
    const label = sandboxUpdateWaitingLabel(update);
    return security
      ? { label, icon: 'shield', tone: 'danger' }
      : { label, icon: 'clock', tone: 'attention' };
  }
  return security
    ? { label: 'Security update stuck', icon: 'shield', tone: 'danger' }
    : { label: 'Sandbox update stuck', icon: 'alert-triangle', tone: 'attention' };
}
