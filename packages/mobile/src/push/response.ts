import { VerityApiError, type VerityClient, type PermissionDecision } from '../api.js';
import { publishSessionStatusMutation } from '../liveStatusMutation.js';
import { publishPullRequestStatusMutation } from '../pullRequestStatusMutation.js';
import { publishSettledPermission } from '../permissionSettlement.js';
import { PUSH_ACTION } from './categories.js';
import type { PushPayload } from './payload.js';

/** The reserved `actionIdentifier` expo reports for a plain notification tap
 * (no custom action button). Kept in sync with
 * `Notifications.DEFAULT_ACTION_IDENTIFIER`. */
export const DEFAULT_ACTION_IDENTIFIER = 'expo.modules.notifications.actions.DEFAULT';

/** A notification response resolved to what the app should do. `open-session` is
 * a pure navigation intent (no network); the other two are network replies the
 * outbox is responsible for delivering. */
export type PushReplyAction =
  | {
      type: 'decide-permission';
      sessionId: string;
      toolUseId: string;
      decision: PermissionDecision;
    }
  | { type: 'send-turn'; sessionId: string; prompt: string }
  | { type: 'merge-pull-request'; sessionId: string; pullRequestNumber: number }
  | { type: 'open-session'; sessionId: string };

/** Whether a delivery attempt succeeded, is permanently un-deliverable, or should
 * be retried on the next flush. */
export type PushReplyOutcome = 'done' | 'stale' | 'retry';

export interface PushResponseInput {
  /** The tapped action's identifier, or {@link DEFAULT_ACTION_IDENTIFIER}. */
  actionIdentifier: string;
  payload: PushPayload;
  /** Text the operator typed into a `textInput` action, if any. */
  userText?: string | undefined;
}

/** Map a notification response to a routed action, or `null` when it can't be
 * routed (unknown action, or a mismatched payload — e.g. an allow tap on a
 * payload with no `toolUseId`). Pure: no I/O, so it's the same on cold-start
 * (killed app) and warm-foreground handling. */
export function resolvePushResponse(input: PushResponseInput): PushReplyAction | null {
  const { actionIdentifier, payload, userText } = input;

  // A plain tap (or the actionless SESSION_STATUS category) just opens the session.
  if (actionIdentifier === DEFAULT_ACTION_IDENTIFIER) {
    return { type: 'open-session', sessionId: payload.sessionId };
  }

  if (actionIdentifier === PUSH_ACTION.openSession) {
    return { type: 'open-session', sessionId: payload.sessionId };
  }

  if (actionIdentifier === PUSH_ACTION.allow || actionIdentifier === PUSH_ACTION.deny) {
    if (payload.kind !== 'permission' || payload.toolUseId === undefined) return null;
    const decision: PermissionDecision =
      actionIdentifier === PUSH_ACTION.allow ? { behavior: 'allow' } : { behavior: 'deny' };
    return {
      type: 'decide-permission',
      sessionId: payload.sessionId,
      toolUseId: payload.toolUseId,
      decision,
    };
  }

  if (actionIdentifier === PUSH_ACTION.reply) {
    const prompt = userText?.trim();
    if (prompt === undefined || prompt.length === 0) return null;
    return { type: 'send-turn', sessionId: payload.sessionId, prompt };
  }

  if (actionIdentifier === PUSH_ACTION.mergePullRequest) {
    if (payload.kind !== 'pull_request_ready' || payload.pullRequestNumber === undefined) {
      return null;
    }
    return {
      type: 'merge-pull-request',
      sessionId: payload.sessionId,
      pullRequestNumber: payload.pullRequestNumber,
    };
  }

  return null;
}

/** Build the outbox's `perform` seam over a Verity client. Delivers the reply and
 * classifies the result so the outbox knows whether to drop or retry it:
 *
 * - `decide-permission` is idempotent on the server via `toolUseId`, so retrying a
 *   network failure is always safe; a 4xx means the prompt was already resolved
 *   (`stale`).
 * - `send-turn` carries the outbox entry id as `clientReplyId`, the server-side
 *   idempotency key (ADR 0008): a retry after a lost response returns the prior
 *   result instead of doubling the reply. Safe to retry on any transient failure.
 * - `open-session` is not a network reply — reported `done` immediately.
 *
 * A terminal 4xx (the reply can never succeed — e.g. the prompt was already
 * resolved) drops the entry. A transient status keeps it for the next flush: 5xx,
 * a transport error, and — critically — 401/403/408/425/429. The outbox may flush
 * before the bearer is loaded into memory (a biometric-unlock launch, an offline
 * reply from a prior session), so an unauthenticated 401/403 must be RETRIED, not
 * silently dropped, or the operator's queued permission answer is lost. */
const RETRYABLE_CLIENT_STATUS: ReadonlySet<number> = new Set([401, 403, 408, 425, 429]);

export function createPushReplyPerformer(
  client: Pick<VerityClient, 'decidePermission' | 'sendTurn' | 'mergePullRequest'>,
): (action: PushReplyAction, clientReplyId: string) => Promise<PushReplyOutcome> {
  return async (action, clientReplyId) => {
    try {
      if (action.type === 'decide-permission') {
        await client.decidePermission(action.sessionId, action.toolUseId, action.decision);
        publishSessionStatusMutation(action.sessionId, 'running');
        publishSettledPermission(action.sessionId, action.toolUseId);
        return 'done';
      }
      if (action.type === 'send-turn') {
        await client.sendTurn(action.sessionId, { prompt: action.prompt, clientReplyId });
        publishSessionStatusMutation(action.sessionId, 'running');
        return 'done';
      }
      if (action.type === 'merge-pull-request') {
        await client.mergePullRequest(action.sessionId, action.pullRequestNumber);
        publishPullRequestStatusMutation({
          sessionId: action.sessionId,
          pr: { phase: 'merged', pipeline: 'success', mergeable: false },
        });
        return 'done';
      }
      return 'done';
    } catch (error) {
      if (
        error instanceof VerityApiError &&
        error.status >= 400 &&
        error.status < 500 &&
        !RETRYABLE_CLIENT_STATUS.has(error.status)
      ) {
        if (action.type === 'decide-permission' && error.status === 409) {
          publishSettledPermission(action.sessionId, action.toolUseId);
        }
        if (action.type === 'merge-pull-request' && error.status === 409) {
          publishPullRequestStatusMutation({ sessionId: action.sessionId });
        }
        return 'stale';
      }
      return 'retry';
    }
  };
}
