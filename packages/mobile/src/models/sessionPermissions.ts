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
