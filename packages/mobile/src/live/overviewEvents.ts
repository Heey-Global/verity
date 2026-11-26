import { SESSION_SUMMARY_FIELDS, type DomainEvent } from '@verity/events';
import { sessionSummarySchema, type SessionSummary } from '../api.js';
import { pullRequestSchema } from '../branch-api.js';

/**
 * How an overview event changes a list of session summaries (ADR 0033). Home
 * and the project page both hold such lists; applying the same event the same
 * way keeps them in agreement without either reading again.
 *
 * - `local`: the change is complete in the event (an answered request or
 *   question disappears) and has been applied to `sessions`.
 * - `reload`: the event announces something new whose content only the
 *   overview read may show this viewer (a request's tool and input, a
 *   question's options); read the list again.
 * - `none`: the event does not concern these sessions.
 */
export type OverviewEventEffect =
  { kind: 'local'; sessions: SessionSummary[] } | { kind: 'reload' } | { kind: 'none' };

export function applyOverviewEvent(
  sessions: readonly SessionSummary[],
  event: DomainEvent,
): OverviewEventEffect {
  if (event.t === 'permission.requested' || event.t === 'choices.opened') {
    return { kind: 'reload' };
  }
  if (event.t === 'session.summary') {
    const index = sessions.findIndex((session) => session.sessionId === event.sessionId);
    if (index < 0) return { kind: 'none' };
    const patched = withSummaryRow(sessions[index]!, event.patch);
    // A row this app cannot read is ignored: the list read carries the same
    // fields and would fail on them too, so reading again only adds load.
    if (patched === undefined) return { kind: 'none' };
    const next = [...sessions];
    next[index] = patched;
    return { kind: 'local', sessions: next };
  }
  if (event.t === 'pr.status') {
    if (!sessions.some((session) => session.sessionId === event.sessionId)) return { kind: 'none' };
    const parsed = pullRequestSchema.safeParse(event.pr);
    // A status this app cannot read is left to the overview read.
    if (!parsed.success) return { kind: 'reload' };
    let found = false;
    const next = sessions.map((session) => {
      if (session.sessionId !== event.sessionId) return session;
      found = true;
      return withPullRequest(session, parsed.data);
    });
    return found ? { kind: 'local', sessions: next } : { kind: 'none' };
  }
  if (event.t !== 'permission.decided' && event.t !== 'choices.answered') return { kind: 'none' };
  let changed = false;
  const next = sessions.map((session) => {
    if (session.sessionId !== event.sessionId) return session;
    const updated =
      event.t === 'permission.decided'
        ? withoutPermission(session, event.toolUseId)
        : withoutOpenChoices(session);
    if (updated !== session) changed = true;
    return updated;
  });
  return changed ? { kind: 'local', sessions: next } : { kind: 'none' };
}

/**
 * Events a view keeps and applies again to an overview read that was already
 * on its way when the event arrived; reads started after it are the server's
 * word.
 */
export function appliesToEarlierReads(event: DomainEvent): boolean {
  return (
    event.t === 'permission.decided' ||
    event.t === 'choices.answered' ||
    event.t === 'pr.status' ||
    event.t === 'session.summary'
  );
}

/** The session with the overview fields of a `session.summary` row in place
 * of its own: a field the row lacks is gone. The rest stays as read: what each
 * viewer sees differently, and what other overview events own.
 * Undefined when the result is not a row this app can read. */
function withSummaryRow(
  session: SessionSummary,
  row: Readonly<Record<string, unknown>>,
): SessionSummary | undefined {
  const next: Record<string, unknown> = { ...session };
  for (const key of SESSION_SUMMARY_FIELDS) {
    if (key in row) next[key] = row[key];
    else delete next[key];
  }
  const parsed = sessionSummarySchema.safeParse(next);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Kept events without those `event` replaces: a session's newer pull request
 * status makes its older one moot. Keeping one per session stops a burst of
 * statuses, such as the first sweep after a server restart, from pushing kept
 * answers out of a bounded buffer.
 */
export function keptWithout<T extends { event: DomainEvent }>(
  kept: readonly T[],
  event: DomainEvent,
): T[] {
  // A newer status or whole row makes the session's older one moot.
  if (event.t !== 'pr.status' && event.t !== 'session.summary') return [...kept];
  return kept.filter(
    (entry) => entry.event.t !== event.t || entry.event.sessionId !== event.sessionId,
  );
}

/** The session with the pull request status the overview routes would now
 * show: the full status, and the compact one Home's markers read. */
export function withPullRequest(
  session: SessionSummary,
  pullRequest: NonNullable<SessionSummary['pullRequest']> | null,
): SessionSummary {
  if (pullRequest === null) return { ...session, pullRequest: null, pr: null };
  return {
    ...session,
    pullRequest,
    pr: {
      phase: pullRequest.phase,
      pipeline: pullRequest.pipeline,
      mergeable: pullRequest.mergeable,
      ...(pullRequest.viewerCanMerge === undefined
        ? {}
        : { viewerCanMerge: pullRequest.viewerCanMerge }),
      ...(pullRequest.mergeState === undefined ? {} : { mergeState: pullRequest.mergeState }),
    },
  };
}

/** The session without one settled permission request — both its id and the
 * descriptor Home builds its card from. Unchanged when it held neither. */
export function withoutPermission(session: SessionSummary, toolUseId: string): SessionSummary {
  const requests = session.pendingPermissionRequests?.filter(
    (request) => request.toolUseId !== toolUseId,
  );
  const requestsChanged =
    requests !== undefined && requests.length !== session.pendingPermissionRequests?.length;
  const pendingPermissions = (session.pendingPermissions ?? []).filter((id) => id !== toolUseId);
  const idsChanged = pendingPermissions.length !== (session.pendingPermissions?.length ?? 0);
  if (!idsChanged && !requestsChanged) return session;
  return {
    ...session,
    ...(session.pendingPermissions === undefined ? {} : { pendingPermissions }),
    ...(requestsChanged ? { pendingPermissionRequests: requests } : {}),
    // Detached requests may be listed only as descriptors; the session waits
    // until neither list holds anything.
    ...(session.permissionAwaitingInput === true &&
    pendingPermissions.length === 0 &&
    (requests ?? session.pendingPermissionRequests ?? []).length === 0
      ? { status: 'running' as const, permissionAwaitingInput: undefined }
      : {}),
  };
}

function withoutOpenChoices(session: SessionSummary): SessionSummary {
  if (session.openChoices === undefined) return session;
  const rest = { ...session };
  delete rest.openChoices;
  return rest;
}

/**
 * Drops events that are not newer than one already applied for the same
 * entity, e.g. a replay overlapping what a view received before.
 */
export class RevisionGate {
  private readonly seen = new Map<string, number>();

  accept(event: DomainEvent): boolean {
    const key = entityKey(event);
    const previous = this.seen.get(key);
    if (previous !== undefined && event.rev <= previous) return false;
    // Re-inserted, so eviction drops the entity unchanged for longest.
    this.seen.delete(key);
    this.seen.set(key, event.rev);
    if (this.seen.size > 2_048) this.seen.delete(this.seen.keys().next().value!);
    return true;
  }

  /** After a resync the snapshot decides; earlier revisions no longer matter. */
  reset(): void {
    this.seen.clear();
  }
}

function entityKey(event: DomainEvent): string {
  switch (event.t) {
    case 'permission.requested':
    case 'permission.decided':
      return `permission:${event.sessionId}:${event.toolUseId}`;
    case 'choices.opened':
    case 'choices.answered':
      return `choices:${event.sessionId}`;
    case 'session.summary':
    case 'pr.status':
      return `${event.t}:${event.sessionId}`;
    case 'project.changed':
    case 'sandbox.lifecycle':
    case 'sandbox.update':
      return `${event.t}:${event.projectId}`;
  }
}
