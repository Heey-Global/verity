import { z } from 'zod';

export const pendingPermissionRequestSchema = z.object({
  toolUseId: z.string().min(1),
  tool: z.string().min(1),
  riskClass: z.string().min(1),
  input: z.unknown().optional(),
  grantChannel: z.literal('acp').optional(),
  createdAt: z.number().optional(),
  detached: z.boolean().optional(),
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
  request: (path: string, init: { method: 'GET' | 'POST' }) => Promise<Response>,
) {
  return {
    async list(sessionId: string) {
      const response = await request(
        `/sessions/${encodeURIComponent(sessionId)}/secret-approvals`,
        { method: 'GET' },
      );
      return historySchema.parse(await response.json()).requests;
    },
    async reopen(sessionId: string, approvalId: string): Promise<void> {
      await request(
        `/sessions/${encodeURIComponent(sessionId)}/secret-approvals/${encodeURIComponent(approvalId)}/reopen`,
        { method: 'POST' },
      );
    },
  };
}
