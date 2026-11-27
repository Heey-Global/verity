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
  /** Null when nobody is named: the request is then for everyone who sees it,
   *  except a secret or network prompt, which stays with {@link forCode}. */
  owner: string | null;
  /** Permission prompts for everyone with Code rather than for the owner. */
  forCode: ReadonlySet<string>;
}

export interface RequestAddressingDeps {
  store: Pick<EventStore, 'sessionPeople' | 'isActiveAdministrator' | 'hasProjectPermission'>;
}

type RightsStore = Pick<RequestAddressingDeps['store'], 'hasProjectPermission'> & {
  isActiveAdministrator(userId: string): Promise<boolean>;
};

/** The store with each person's administrator role read once per list load. */
function memoizedAdministrators(store: RequestAddressingDeps['store']): RightsStore {
  const administrators = new Map<string, Promise<boolean>>();
  return {
    hasProjectPermission: (userId, projectId, permission) =>
      store.hasProjectPermission(userId, projectId, permission),
    isActiveAdministrator: (userId) => {
      let known = administrators.get(userId);
      if (known === undefined) {
        known = store.isActiveAdministrator(userId);
        administrators.set(userId, known);
      }
      return known;
    },
  };
}

/** Whether `userId` holds Code where `projectId` is; a session without a project
 *  is an administrator's. */
export async function holdsCode(
  store: RightsStore,
  userId: string,
  projectId: string | null,
): Promise<boolean> {
  if (await store.isActiveAdministrator(userId)) return true;
  return projectId !== null && (await store.hasProjectPermission(userId, projectId, 'code'));
}

/** Whether `userId` is an active member who can see the session's project. */
async function canRead(
  store: RightsStore,
  userId: string,
  projectId: string | null,
): Promise<boolean> {
  if (await store.isActiveAdministrator(userId)) return true;
  return projectId !== null && (await store.hasProjectPermission(userId, projectId, 'read'));
}

/** Whether the session waits on someone: a prompt, a question, a plan or mockups. */
function hasOpenRequest(summary: SessionSummary): boolean {
  return (
    summary.pendingPermissions.length > 0 ||
    summary.openChoices !== undefined ||
    summary.status === 'awaiting_input' ||
    summary.planning === 'active' ||
    summary.mockupReview?.state === 'pending'
  );
}

/** Address every session's requests once per list load, shared by all requesters. */
export async function addressRequests(
  deps: RequestAddressingDeps,
  summaries: readonly SessionSummary[],
): Promise<Map<string, RequestAddressing>> {
  // Only sessions that ask something need an owner; the others cost no query.
  const asking = summaries.filter(hasOpenRequest);
  const fallback = await deps.store.sessionPeople.owners(asking.map((s) => s.sessionId));
  const addressing = new Map<string, RequestAddressing>();
  // Polled by every device: each person's rights are read once per project.
  const rights = new Map<string, Promise<boolean>>();
  const store = memoizedAdministrators(deps.store);
  const cached = (
    kind: 'read' | 'code',
    owner: string,
    projectId: string | null,
  ): Promise<boolean> => {
    const key = `${kind}\0${owner}\0${projectId ?? ''}`;
    let held = rights.get(key);
    if (held === undefined) {
      held =
        kind === 'code' ? holdsCode(store, owner, projectId) : canRead(store, owner, projectId);
      rights.set(key, held);
    }
    return held;
  };
  // Sessions resolve side by side; the cache still reads each right once.
  const resolve = async (summary: SessionSummary): Promise<RequestAddressing> => {
    // A person who left the project, or was deactivated, cannot answer: the next one
    // in line does, and with nobody left the request is for everyone who sees it.
    let owner: string | null = null;
    for (const candidate of [
      summary.requestInitiator,
      ...(fallback.get(summary.sessionId) ?? []),
    ]) {
      if (candidate != null && (await cached('read', candidate, summary.projectId))) {
        owner = candidate;
        break;
      }
    }
    const sensitive = (summary.pendingPermissionRequests ?? []).filter(
      (request) => classifyPermissionTool(request.tool) !== 'general',
    );
    const ownerMayAllow =
      sensitive.length === 0 ||
      (owner !== null && (await cached('code', owner, summary.projectId)));
    return {
      owner,
      forCode: new Set(ownerMayAllow ? [] : sensitive.map((request) => request.toolUseId)),
    };
  };
  const resolved = await Promise.all(asking.map(resolve));
  asking.forEach((summary, index) => addressing.set(summary.sessionId, resolved[index]!));
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

/** A per-request cache of the requester's Code rights by project. A failed check
 *  shows the prompt rather than failing the requester's whole list. */
export function viewerCodeRights(
  deps: RequestAddressingDeps,
  viewer: string,
): (projectId: string | null) => Promise<boolean> {
  const known = new Map<string | null, Promise<boolean>>();
  const store = memoizedAdministrators(deps.store);
  return (projectId) => {
    let held = known.get(projectId);
    if (held === undefined) {
      held = holdsCode(store, viewer, projectId).catch(() => true);
      known.set(projectId, held);
    }
    return held;
  };
}
