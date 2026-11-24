import Fastify from 'fastify';
import { expect, it, vi } from 'vitest';
import { registerSecretApprovalRoutes } from './secret-approval-routes.js';
import type { BrokeredToolApprovalStore } from './brokered-tool-approval-store.js';

const id = 'b7aa84e6-ab38-4f5e-b26e-d5509ba90798';
const record = {
  id,
  projectId: 'p',
  sessionId: 's',
  toolName: 'verity_http_request',
  status: 'denied',
  createdAt: '2026-11-20T00:00:00Z',
  decidedAt: '2026-11-20T00:01:00Z',
  canonicalInput: 'sensitive request input',
  requestMac: 'private MAC',
  authorizationSnapshot:
    '{"bindings":[{"bindingId":"b","connectionId":"c","dopplerProject":"p","dopplerConfig":"s"}]}',
};
function harness(allowed = true, unrecorded = false, approval = record) {
  const app = Fastify();
  const reopen = vi.fn(async () => ({ ...record, status: 'pending' }));
  const refresh = vi.fn(async () => {});
  registerSecretApprovalRoutes(app, {
    approvals: {
      listReopenable: async () => [record],
      listUnrecordedDecisions: async () => (unrecorded ? [record] : []),
      get: async () => approval,
      reopen,
    } as unknown as BrokeredToolApprovalStore,
    store: { getSession: async () => ({ sessionId: 's' }) } as never,
    permitted: async () => allowed,
    refresh,
  });
  return { app, reopen, refresh };
}

it('lists only safe history metadata, without the saved input or MAC', async () => {
  const { app } = harness();
  try {
    const response = await app.inject({ method: 'GET', url: '/sessions/s/secret-approvals' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      requests: [
        {
          id,
          toolName: record.toolName,
          status: 'denied',
          createdAt: record.createdAt,
          decidedAt: record.decidedAt,
        },
      ],
    });
    expect(response.body).not.toContain('sensitive');
    expect(response.body).not.toContain('MAC');
  } finally {
    await app.close();
  }
});

it.each([true, false])(
  'reopens consent only with current execution authority (%s)',
  async (allowed) => {
    const { app, reopen, refresh } = harness(allowed);
    try {
      const response = await app.inject({
        method: 'POST',
        url: `/sessions/s/secret-approvals/${id}/reopen`,
      });
      expect(response.statusCode).toBe(allowed ? 200 : 403);
      expect(reopen).toHaveBeenCalledTimes(allowed ? 1 : 0);
      expect(refresh).toHaveBeenCalledTimes(allowed ? 2 : 0);
    } finally {
      await app.close();
    }
  },
);

it('preserves the previous receipt if recovery cannot record its decision before reopening', async () => {
  const { app, reopen, refresh } = harness(true, true);
  try {
    const response = await app.inject({
      method: 'POST',
      url: `/sessions/s/secret-approvals/${id}/reopen`,
    });
    expect(response.statusCode).toBe(503);
    expect(refresh).toHaveBeenCalledWith('s');
    expect(reopen).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});

it('asks for a new request when the saved provider snapshot is obsolete', async () => {
  const { app, reopen, refresh } = harness(true, false, { ...record, authorizationSnapshot: '{}' });
  try {
    const response = await app.inject({
      method: 'POST',
      url: `/sessions/s/secret-approvals/${id}/reopen`,
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: 'This approval is obsolete. Submit the secret request again.',
    });
    expect(reopen).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});
