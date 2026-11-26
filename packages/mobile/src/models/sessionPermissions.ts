import { VerityApiError } from '../api.js';
import type { SessionStream } from '../stream.js';
import type { PendingPermissionRequest } from '../secretApprovals.js';

/** Reconcile exact cards with the same snapshot watermark as their pending ids. */
export function reconcileSessionPermissions(
  stream: SessionStream,
  snapshot: {
    pendingPermissions?: string[] | undefined;
    pendingPermissionRequests?: PendingPermissionRequest[] | undefined;
  },
  throughSeq: number,
): void {
  if (snapshot.pendingPermissions !== undefined)
    stream.reconcilePendingPermissions(
      snapshot.pendingPermissions,
      throughSeq,
      snapshot.pendingPermissionRequests,
    );
}

/**
 * What the operator must know after an allow with a reusable scope. Only the
 * server knows whether the action went on, so the text follows its answer and
 * never claims both that the decision failed and that the request ran.
 */
export function scopedDecisionNotice(result: {
  scopeSaved?: boolean | undefined;
  actionContinued?: boolean | undefined;
}): string | undefined {
  if (result.actionContinued === false)
    return result.scopeSaved === false
      ? 'Not run: the reusable approval could not be saved. The agent has to request it again.'
      : 'Not run: the approval was saved, but the action could not continue. The agent has to request it again.';
  if (result.scopeSaved !== false) return undefined;
  // Older servers do not say whether the action went on; the chat records it.
  return result.actionContinued === true
    ? 'Request allowed, but the reusable approval could not be saved. Future requests will ask again.'
    : 'The reusable approval could not be saved. The chat shows whether the request ran.';
}

/** A decision that never reached the server, as one statement. */
export function permissionDecisionFailure(error: unknown): string {
  return `Decision failed: ${error instanceof VerityApiError ? error.message : 'the decision could not be sent'}`;
}
