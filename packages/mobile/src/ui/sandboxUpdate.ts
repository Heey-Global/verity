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
 * never converge. Either way, only `stalled` is worth a glyph.
 */
export function sandboxUpdateNeedsAttention(
  update: SandboxUpdate | undefined,
): update is SandboxUpdate & { selfRepair: 'stalled' } {
  return update?.selfRepair === 'stalled' && update.state !== 'current';
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
 * Three cases, because the honest answer differs by more than wording:
 * - `current`    — nothing to say.
 * - `converging` — behind, and Verity is handling it. Reportable where there is
 *   room for a sentence (the project detail screen), never as an alert.
 * - `stalled`    — behind, and Verity has given up retrying.
 */
export function sandboxUpdateSummary(update: SandboxUpdate | undefined): string | null {
  if (update?.selfRepair === 'stalled' && update.state === 'unknown') {
    return 'Sandbox repair stuck — the sandbox could not be rebuilt';
  }
  if (update === undefined || update.state !== 'available') return null;
  const security = isSecuritySandboxUpdate(update);
  return update.selfRepair === 'stalled'
    ? security
      ? 'Security update stuck — the sandbox is still on the old image'
      : 'Sandbox update stuck — the sandbox is still on the old image'
    : security
      ? 'Security update pending — Verity is rebuilding this sandbox'
      : 'Update pending — Verity is rebuilding this sandbox';
}

/** The overview glyph for a sandbox that will not update itself. `tone` is
 *  semantic, resolved to a theme color by the RN layer, matching how
 *  {@link AttentionFlag} and {@link projectBadge} hand off. */
export interface SandboxUpdateIndicator {
  label: string;
  /** Feather icon name. */
  icon: 'shield' | 'alert-triangle';
  tone: 'danger' | 'attention';
}

/**
 * What, if anything, the project overview should draw next to a project.
 *
 * `undefined` for everything except a stalled update — including a pending one,
 * which is the whole point (see the module doc). Deliberately NOT a download
 * glyph: nothing here is an offer to update, it is a report that an update did
 * not happen. The security case gets a shield in `danger` rather than the same
 * triangle in a louder color, so the two are distinguishable at glyph size.
 */
export function sandboxUpdateIndicator(
  update: SandboxUpdate | undefined,
): SandboxUpdateIndicator | undefined {
  if (!sandboxUpdateNeedsAttention(update)) return undefined;
  return isSecuritySandboxUpdate(update)
    ? { label: 'Security update stuck', icon: 'shield', tone: 'danger' }
    : { label: 'Sandbox update stuck', icon: 'alert-triangle', tone: 'attention' };
}
