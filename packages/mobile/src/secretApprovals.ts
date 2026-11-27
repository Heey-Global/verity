import { secretApprovalSourceSchema } from '@verity/events';
import { z } from 'zod';

import { addressedToViewerSchema } from './sessionRequests.js';

/** One parked permission prompt with what it asks. `input` is absent when the
 * server judged it too large to carry; the app then opens the session instead. */
export const pendingPermissionRequestSchema = z.object({
  toolUseId: z.string().min(1),
  tool: z.string().min(1),
  riskClass: z.string().min(1),
  input: z.unknown().optional(),
  grantChannel: z.literal('acp').optional(),
  createdAt: z.number().optional(),
  detached: z.boolean().optional(),
  /** Session list only: whether the requester is the one to decide it. */
  addressedToViewer: addressedToViewerSchema,
  secretSource: secretApprovalSourceSchema.optional(),
});
export type PendingPermissionRequest = z.infer<typeof pendingPermissionRequestSchema>;

const historySchema = z.object({
  requests: z.array(
    z.object({
      id: z.string(),
      toolName: z.enum(['verity_http_request', 'verity_secret_run']),
      status: z.enum(['denied', 'expired']),
      createdAt: z.string(),
      decidedAt: z.string().nullable(),
      summary: z.string().optional(),
    }),
  ),
});

/** Use the client's authenticated transport; history never includes credentials or request bodies. */
export function createSecretApprovalsClient(
  request: (
    path: string,
    init: { method: 'GET' | 'POST'; signal?: AbortSignal },
  ) => Promise<Response>,
  authScope: () => string | undefined = () => '',
) {
  type Requests = z.infer<typeof historySchema>['requests'];
  const pending = new Map<string, { read: Promise<Requests>; outdated: boolean }>();
  const fetchHistory = async (sessionId: string): Promise<Requests> => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        request(`/sessions/${encodeURIComponent(sessionId)}/secret-approvals`, {
          method: 'GET',
          signal: controller.signal,
        })
          .then((response) => response.json())
          .then((body) => historySchema.parse(body).requests),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error('Approval history request timed out'));
            controller.abort();
          }, 15_000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const list = (sessionId: string): Promise<Requests> => {
    const scope = authScope();
    const checkScope = (history: Requests): Requests => {
      if (authScope() !== scope) throw new Error('Approval history identity changed');
      return history;
    };
    if (scope === undefined) return fetchHistory(sessionId).then(checkScope);
    const key = JSON.stringify([scope, sessionId]);
    const existing = pending.get(key);
    if (existing !== undefined) return existing.read;
    const entry: { read: Promise<Requests>; outdated: boolean } = {
      outdated: false,
      read: fetchHistory(sessionId)
        .finally(() => pending.delete(key))
        .then(
          (history) => (entry.outdated ? refresh() : checkScope(history)),
          (error: unknown) => {
            if (entry.outdated) return refresh();
            throw error;
          },
        ),
    };
    function refresh(): Promise<Requests> {
      if (authScope() !== scope) throw new Error('Approval history identity changed');
      return list(sessionId);
    }
    pending.set(key, entry);
    return entry.read;
  };
  return {
    list,
    async reopen(sessionId: string, approvalId: string): Promise<void> {
      const scope = authScope();
      await request(
        `/sessions/${encodeURIComponent(sessionId)}/secret-approvals/${encodeURIComponent(approvalId)}/reopen`,
        { method: 'POST' },
      );
      const existing =
        scope === undefined ? undefined : pending.get(JSON.stringify([scope, sessionId]));
      if (existing !== undefined) existing.outdated = true;
    },
  };
}
