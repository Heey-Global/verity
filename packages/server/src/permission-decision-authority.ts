import type { EventStore } from '@verity/store';
import type { FastifyRequest } from 'fastify';

import { viewerId } from './view-state-routes.js';

/** What answering a permission prompt hands out (ADR 0023 §1). */
export type PermissionPromptClass = 'secret' | 'network' | 'general';

// Brokered tools: approving one releases a project secret to a process, or sends an
// outbound request that carries one. Backends report them bare or behind an MCP
// server prefix (`mcp__verity__verity_secret_run`), so the bare name is matched at
// the end after a separator. A foreign tool that happens to share the suffix is held
// to the stricter rule, which only ever asks for more.
const BROKERED: ReadonlyArray<readonly [RegExp, Exclude<PermissionPromptClass, 'general'>]> = [
  [/(?:^|[_./:])verity_secret_run$/u, 'secret'],
  [/(?:^|[_./:])verity_http_request$/u, 'network'],
];

export function classifyPermissionTool(tool: string): PermissionPromptClass {
  return BROKERED.find(([pattern]) => pattern.test(tool))?.[1] ?? 'general';
}

/** How many events back an open prompt's `permission` event is looked for. A prompt
 *  older than that is answered as if its tool were unknown, which needs Code. */
const PERMISSION_SCAN_PAGES = 10;
const PERMISSION_SCAN_PAGE = 200;

export interface PendingPermissionSource {
  store: Pick<EventStore, 'getEventsBeforeSeq'>;
  conductor: {
    pendingPermissions(sessionId: string): string[];
    detachedPermissionRequests?(sessionId: string): readonly { toolUseId: string; tool: string }[];
  };
}

/**
 * The tool an open conductor prompt asks about: `undefined` when the conductor holds no
 * such prompt (a linked-session message approval, or nothing at all), `null` when it
 * does but its durable `permission` event cannot be found.
 */
export async function pendingPermissionTool(
  source: PendingPermissionSource,
  sessionId: string,
  toolUseId: string,
): Promise<string | null | undefined> {
  const detached = source.conductor
    .detachedPermissionRequests?.(sessionId)
    .find((request) => request.toolUseId === toolUseId);
  if (detached !== undefined) return detached.tool;
  if (!source.conductor.pendingPermissions(sessionId).includes(toolUseId)) return undefined;
  let before: number | undefined;
  for (let page = 0; page < PERMISSION_SCAN_PAGES; page += 1) {
    const { events, hasMore } = await source.store.getEventsBeforeSeq(
      sessionId,
      PERMISSION_SCAN_PAGE,
      before,
    );
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i]!.event;
      if (event.t === 'permission' && event.id === toolUseId) return event.tool;
    }
    if (!hasMore || events.length === 0) return null;
    before = events[0]!.seq;
  }
  return null;
}

/**
 * Whether the requester holds Code in the session's project, as the route policy has
 * it: without accounts there is one operator, and administrators keep every route. An
 * unknown session is answered as allowed, so its own route reports it missing.
 */
export async function requesterMayCode(
  store: Pick<EventStore, 'isActiveAdministrator' | 'getSession' | 'hasProjectPermission'>,
  request: FastifyRequest,
  sessionId: string,
): Promise<boolean> {
  if (request.localUserId == null) return true;
  const viewer = viewerId(request);
  if (await store.isActiveAdministrator(viewer)) return true;
  const session = await store.getSession(sessionId);
  if (session === undefined) return true;
  return (
    session.projectId != null &&
    (await store.hasProjectPermission(viewer, session.projectId, 'code'))
  );
}

/** Allowing a secret or network prompt is Code; every other answer stays with execute. */
export async function mayAllowPermission(
  deps: PendingPermissionSource & {
    store: Pick<
      EventStore,
      'getEventsBeforeSeq' | 'isActiveAdministrator' | 'getSession' | 'hasProjectPermission'
    >;
  },
  request: FastifyRequest,
  sessionId: string,
  toolUseId: string,
): Promise<boolean> {
  if (request.localUserId == null) return true;
  const tool = await pendingPermissionTool(deps, sessionId, toolUseId);
  if (tool === undefined) return true;
  if (tool !== null && classifyPermissionTool(tool) === 'general') return true;
  return requesterMayCode(deps.store, request, sessionId);
}
