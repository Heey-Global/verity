import type { DomainEvent } from '@verity/events';
import type { SessionSummary } from '../api.js';

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
