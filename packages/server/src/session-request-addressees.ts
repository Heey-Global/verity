import type { EventStore } from '@verity/store';

import { classifyPermissionTool } from './permission-decision-authority.js';
import type { SessionSummary } from './server-types.js';

/**
 * Whom a session's open requests are for (ADR 0023): the person the current turn
 * runs for, else whoever started the session, else its project's creator. Allowing
 * a secret or network prompt needs Code, so one that person cannot allow goes to
 * everyone with Code in the project instead.
 */
export interface RequestAddressing {
  /** Null when nobody is named: the request is then for everyone who sees it. */
  owner: string | null;
  /** Permission prompts for everyone with Code rather than for the owner. */
  forCode: ReadonlySet<string>;
}

export interface RequestAddressingDeps {
  store: Pick<EventStore, 'sessionPeople' | 'isActiveAdministrator' | 'hasProjectPermission'>;
}

/** Whether `userId` holds Code where `projectId` is; a session without a project
 *  is an administrator's. */
async function holdsCode(
  store: RequestAddressingDeps['store'],
  userId: string,
  projectId: string | null,
): Promise<boolean> {
  if (await store.isActiveAdministrator(userId)) return true;
  return projectId !== null && (await store.hasProjectPermission(userId, projectId, 'code'));
}

/** Address every session's requests once per list load, shared by all requesters. */
export async function addressRequests(
  deps: RequestAddressingDeps,
  summaries: readonly SessionSummary[],
): Promise<Map<string, RequestAddressing>> {
  const fallback = await deps.store.sessionPeople.owners(
    summaries.filter((s) => s.requestInitiator === undefined).map((s) => s.sessionId),
  );
  const addressing = new Map<string, RequestAddressing>();
  for (const summary of summaries) {
    const owner = summary.requestInitiator ?? fallback.get(summary.sessionId) ?? null;
    const sensitive = (summary.pendingPermissionRequests ?? []).filter(
      (request) => classifyPermissionTool(request.tool) !== 'general',
    );
    const ownerMayAllow =
      sensitive.length === 0 ||
      (owner !== null && (await holdsCode(deps.store, owner, summary.projectId)));
    addressing.set(summary.sessionId, {
      owner,
      forCode: new Set(ownerMayAllow ? [] : sensitive.map((request) => request.toolUseId)),
    });
  }
  return addressing;
}

/** The parts of a summary that say, for one requester, which requests are theirs. */
export async function addressedTo(
  viewer: string,
  summary: SessionSummary,
  addressing: RequestAddressing | undefined,
  viewerHoldsCode: (projectId: string | null) => Promise<boolean>,
): Promise<Pick<SessionSummary, 'addressedToViewer' | 'pendingPermissionRequests'>> {
  const mine = addressing?.owner == null || addressing.owner === viewer;
  const requests = summary.pendingPermissionRequests;
  if (requests === undefined) return { addressedToViewer: mine };
  return {
    addressedToViewer: mine,
    pendingPermissionRequests: await Promise.all(
      requests.map(async (request) => ({
        ...request,
        addressedToViewer:
          addressing?.forCode.has(request.toolUseId) === true
            ? await viewerHoldsCode(summary.projectId)
            : mine,
      })),
    ),
  };
}

/** A per-request cache of the requester's Code rights by project. */
export function viewerCodeRights(
  deps: RequestAddressingDeps,
  viewer: string,
): (projectId: string | null) => Promise<boolean> {
  const known = new Map<string | null, Promise<boolean>>();
  return (projectId) => {
    let held = known.get(projectId);
    if (held === undefined) {
      held = holdsCode(deps.store, viewer, projectId);
      known.set(projectId, held);
    }
    return held;
  };
}
