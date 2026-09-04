import { PermissionDecisionInProgressError } from '@verity/session';
import Fastify, { type FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';

import {
  registerSessionControlRoutes,
  type SessionControlRouteDeps,
} from './session-control-routes.js';

describe('Session control routes', () => {
  let app: FastifyInstance;
  let deps: SessionControlRouteDeps;

  beforeEach(() => {
    app = Fastify();
    app.setErrorHandler((error, _request, reply) =>
      error instanceof ZodError
        ? reply.code(400).send({ error: 'invalid request' })
        : reply.send(error),
    );
    deps = {
      store: { getSession: vi.fn(async () => ({ sessionId: 's1' }) as never) },
      conductor: {
        stopSession: vi.fn(async () => ({ cancelled: false, droppedQueued: [] })),
        releaseUnconfirmedTermination: vi.fn(async () => false),
        decidePermission: vi.fn(async () => true),
        dequeue: vi.fn(async () => undefined),
      },
      cancelMeetingJobs: vi.fn(() => false),
      permissionResolved: vi.fn(),
    };
    registerSessionControlRoutes(app, deps);
  });

  it('rejects a non-boolean force flag before touching the session', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/sessions/s1/cancel',
      payload: { force: 'true' },
    });
    expect(response.statusCode).toBe(400);
    expect(deps.store.getSession).not.toHaveBeenCalled();
  });

  it('reports a permission decision already being processed as conflict', async () => {
    vi.mocked(deps.conductor.decidePermission).mockRejectedValueOnce(
      new PermissionDecisionInProgressError('s1', 'tool-1'),
    );
    const response = await app.inject({
      method: 'POST',
      url: '/sessions/s1/permissions/tool-1',
      payload: { behavior: 'allow' },
    });
    expect(response.statusCode).toBe(409);
    expect(deps.permissionResolved).not.toHaveBeenCalled();
  });

  it('returns scope persistence and signals a resolved permission', async () => {
    vi.mocked(deps.conductor.decidePermission).mockImplementationOnce(
      async (_id, _toolUseId, _decision, options) => {
        options?.onScopeSaved?.(false);
        return true;
      },
    );
    const response = await app.inject({
      method: 'POST',
      url: '/sessions/s1/permissions/tool-1',
      payload: { behavior: 'allow', scope: 'project' },
    });
    expect(response.json()).toMatchObject({ decided: true, scopeSaved: false });
    expect(deps.permissionResolved).toHaveBeenCalledWith('s1', 'tool-1');
  });

  it('preserves attachments when retracting a queued turn', async () => {
    vi.mocked(deps.conductor.dequeue).mockResolvedValueOnce({
      prompt: 'revise this',
      attachments: [{ kind: 'image', mediaType: 'image/png', data: 'AAAA' }],
    });
    const response = await app.inject({
      method: 'POST',
      url: '/sessions/s1/queue/item-1/cancel',
    });
    expect(response.json()).toEqual({
      sessionId: 's1',
      itemId: 'item-1',
      prompt: 'revise this',
      attachments: [{ kind: 'image', mediaType: 'image/png', data: 'AAAA' }],
    });
  });
});
