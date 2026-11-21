import { expect, it, vi } from 'vitest';
import { createSecretApprovalsClient } from './secretApprovals.js';

it('uses session-scoped authenticated paths and strips private history fields', async () => {
  const request = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          requests: [
            {
              id: 'a1',
              toolName: 'verity_http_request',
              status: 'denied',
              createdAt: '2026-11-20T00:00:00Z',
              decidedAt: null,
              canonicalInput: 'private',
              requestMac: 'private',
            },
          ],
        }),
      ),
  );
  const client = createSecretApprovalsClient(request);
  const history = await client.list('session/a');
  expect(request).toHaveBeenCalledWith('/sessions/session%2Fa/secret-approvals', { method: 'GET' });
  expect(history).toEqual([
    {
      id: 'a1',
      toolName: 'verity_http_request',
      status: 'denied',
      createdAt: '2026-11-20T00:00:00Z',
      decidedAt: null,
    },
  ]);
  await client.reopen('session/a', 'id/b');
  expect(request).toHaveBeenLastCalledWith('/sessions/session%2Fa/secret-approvals/id%2Fb/reopen', {
    method: 'POST',
  });
});
