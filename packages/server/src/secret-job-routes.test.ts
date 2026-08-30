import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SecretAuthorizationRejectedError } from './secret-authorization.js';
import { SecretJobRejectedError } from './secret-job-executor.js';
import { SecretJobFrameSpoolError } from './secret-job-frame-spool.js';
import { registerSecretJobRoutes } from './secret-job-routes.js';
import { SecretJobServiceRejectedError, type SecretJobService } from './secret-job-service.js';

const HASH = 'a'.repeat(64);
const ACTOR = { actorId: 'device-1', authorizationHash: HASH };
const invocation = {
  context: {
    protocolVersion: 1,
    projectId: 'project-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    toolCallId: 'call-1',
    channel: 'codex-mcp',
  },
  request: {
    kind: 'restricted',
    profile: { id: 'profile-1', version: 1, policyHash: HASH },
    parameters: { operation: 'list' },
    snapshotId: HASH,
  },
};

function service(overrides: Partial<SecretJobService> = {}): SecretJobService {
  return {
    request: vi.fn(() => Promise.resolve({ approvalId: 'approval-1' })),
    decideAndStart: vi.fn(() =>
      Promise.resolve({ decision: 'approved', jobId: 'job-1', state: 'running' }),
    ),
    status: vi.fn(() => ({ jobId: 'job-1', state: 'running' })),
    readFrames: vi.fn(() => Promise.resolve({ frames: [], nextSequence: 0, hasMore: false })),
    cleanup: vi.fn(() =>
      Promise.resolve({
        protocolVersion: 1,
        jobId: 'job-1',
        cleanupId: 'job-1:cleanup:1',
        disposition: 'already_reaped',
        completedAt: '2026-07-22T12:00:00.000Z',
      }),
    ),
    settle: vi.fn(() => Promise.resolve({ jobId: 'job-1', state: 'running' })),
    close: vi.fn(),
    ...overrides,
  } as SecretJobService;
}

describe('secret job routes', () => {
  const apps: FastifyInstance[] = [];
  afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

  function appFor(jobService: SecretJobService) {
    const app = Fastify();
    apps.push(app);
    registerSecretJobRoutes(app, jobService, (header) =>
      header === 'Bearer valid-token' ? ACTOR : undefined,
    );
    return app;
  }

  it('accepts a validated restricted invocation for approval', async () => {
    const jobService = service();
    const response = await appFor(jobService).inject({
      method: 'POST',
      url: '/secret-jobs/requests',
      headers: { authorization: 'Bearer valid-token' },
      payload: invocation,
    });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ approvalId: 'approval-1' });
    // Vitest owns the injected method; it does not use an object receiver.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(jobService.request).toHaveBeenCalledWith(invocation, ACTOR);
  });

  it('does not transport native tool capabilities through HTTP headers', async () => {
    const jobService = service();
    const response = await appFor(jobService).inject({
      method: 'POST',
      url: '/secret-jobs/requests',
      headers: {
        authorization: 'Bearer valid-token',
        'x-verity-native-tool-capability': 'native-once',
      },
      payload: invocation,
    });
    expect(response.statusCode).toBe(202);
    expect(response.body).not.toContain('native-once');
    // Vitest owns the injected method; it does not use an object receiver.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(jobService.request).toHaveBeenCalledWith(invocation, ACTOR);
  });

  it('requires a verified principal and passes it to approval', async () => {
    const jobService = service();
    const app = appFor(jobService);
    const input = {
      approved: true,
      jobId: 'job-1',
      absoluteDeadline: '2026-07-22T12:00:59.000Z',
    };
    const unauthenticated = await app.inject({
      method: 'POST',
      url: '/secret-jobs/approvals/approval-1/decision',
      payload: input,
    });
    expect(unauthenticated.statusCode).toBe(401);

    const response = await app.inject({
      method: 'POST',
      url: '/secret-jobs/approvals/approval-1/decision',
      headers: { authorization: 'Bearer valid-token' },
      payload: input,
    });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ decision: 'approved', jobId: 'job-1', state: 'running' });
    expect(JSON.stringify(response.json())).not.toContain('valid-token');
    // Vitest owns the injected method; it does not use an object receiver.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(jobService.decideAndStart).toHaveBeenCalledWith({
      approvalId: 'approval-1',
      actor: ACTOR,
      ...input,
    });
  });

  it('rejects caller-controlled executor image selection', async () => {
    const response = await appFor(service()).inject({
      method: 'POST',
      url: '/secret-jobs/approvals/approval-1/decision',
      headers: { authorization: 'Bearer valid-token' },
      payload: {
        approved: true,
        jobId: 'job-1',
        executorImageDigest: 'b'.repeat(64),
        absoluteDeadline: '2026-07-22T12:00:59.000Z',
      },
    });
    expect(response.statusCode).toBe(400);
  });

  it('exposes status and bounded durable replay', async () => {
    const jobService = service();
    const app = appFor(jobService);
    const status = await app.inject({
      method: 'GET',
      url: '/secret-jobs/job-1',
      headers: { authorization: 'Bearer valid-token' },
    });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toEqual({ jobId: 'job-1', state: 'running' });

    const frames = await app.inject({
      method: 'GET',
      url: '/secret-jobs/job-1/frames?nextSequence=4',
      headers: { authorization: 'Bearer valid-token' },
    });
    expect(frames.statusCode).toBe(200);
    // Vitest owns the injected method; it does not use an object receiver.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(jobService.readFrames).toHaveBeenCalledWith('job-1', ACTOR, 4);
  });

  it('authenticates status, frame replay, and cleanup independently', async () => {
    const jobService = service();
    const app = appFor(jobService);
    for (const request of [
      { method: 'GET' as const, url: '/secret-jobs/job-1' },
      { method: 'GET' as const, url: '/secret-jobs/job-1/frames' },
      { method: 'POST' as const, url: '/secret-jobs/job-1/cleanup' },
    ]) {
      const response = await app.inject(request);
      expect(response.statusCode).toBe(401);
    }
  });

  it('rejects malformed transport input before invoking the service', async () => {
    const jobService = service();
    const response = await appFor(jobService).inject({
      method: 'POST',
      url: '/secret-jobs/requests',
      headers: { authorization: 'Bearer valid-token' },
      payload: { ...invocation, unexpected: true },
    });
    expect(response.statusCode).toBe(400);
    // Vitest owns the injected method; it does not use an object receiver.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(jobService.request).not.toHaveBeenCalled();
  });

  it('leaves unexpected infrastructure failures as server errors', async () => {
    const app = appFor(
      service({ request: vi.fn(() => Promise.reject(new Error('database unavailable'))) }),
    );
    const response = await app.inject({
      method: 'POST',
      url: '/secret-jobs/requests',
      headers: { authorization: 'Bearer valid-token' },
      payload: invocation,
    });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: 'internal server error' });
    expect(response.body).not.toContain('database unavailable');
  });

  it('rejects an unauthenticated request submission before parsing its body', async () => {
    const jobService = service();
    const response = await appFor(jobService).inject({
      method: 'POST',
      url: '/secret-jobs/requests',
      payload: invocation,
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'unauthorized' });
    // Vitest owns the injected method; it does not use an object receiver.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(jobService.request).not.toHaveBeenCalled();
  });

  it('answers an authorization or policy refusal with an opaque 403', async () => {
    // Both refusal kinds collapse to one message on purpose: the difference
    // between "you may not" and "this profile forbids it" is an oracle.
    for (const error of [
      new SecretAuthorizationRejectedError('device is not an approver'),
      new SecretJobServiceRejectedError('profile snapshot is stale'),
    ]) {
      const response = await appFor(
        service({ request: vi.fn(() => Promise.reject(error)) }),
      ).inject({
        method: 'POST',
        url: '/secret-jobs/requests',
        headers: { authorization: 'Bearer valid-token' },
        payload: invocation,
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ error: 'secret job request rejected' });
      expect(response.body).not.toContain(error.message);
    }
  });

  const decision = {
    method: 'POST' as const,
    url: '/secret-jobs/approvals/approval-1/decision',
    headers: { authorization: 'Bearer valid-token' },
    payload: { approved: false },
  };

  it('completes a denied decision with 200 rather than the accepted-for-start 202', async () => {
    const jobService = service({
      decideAndStart: vi.fn(() => Promise.resolve({ decision: 'denied' as const })),
    });
    const response = await appFor(jobService).inject(decision);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ decision: 'denied' });
    // Vitest owns the injected method; it does not use an object receiver.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(jobService.decideAndStart).toHaveBeenCalledWith({
      approvalId: 'approval-1',
      actor: ACTOR,
      approved: false,
    });
  });

  it('separates a losing decision race from an unauthorized decider', async () => {
    // 409 says the approval was already settled — retrying is pointless but the
    // caller is legitimate; 403 says this device may not decide at all.
    for (const [error, status] of [
      [new SecretJobServiceRejectedError('approval already settled'), 409],
      [new SecretAuthorizationRejectedError('actor is not the requester'), 403],
    ] as const) {
      const response = await appFor(
        service({ decideAndStart: vi.fn(() => Promise.reject(error)) }),
      ).inject(decision);
      expect(response.statusCode).toBe(status);
      expect(response.json()).toEqual({ error: 'secret job decision rejected' });
      expect(response.body).not.toContain(error.message);
    }
  });

  it('does not leak a decision-path infrastructure failure to the caller', async () => {
    const response = await appFor(
      service({ decideAndStart: vi.fn(() => Promise.reject(new Error('docker socket gone'))) }),
    ).inject(decision);
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: 'internal server error' });
    expect(response.body).not.toContain('docker socket gone');
  });

  it('refuses an unsafe job id on every job-scoped route', async () => {
    // The id reaches the store and the frame spool, so a path-shaped or
    // whitespace-bearing id must be rejected at the transport edge.
    const jobService = service();
    const app = appFor(jobService);
    for (const [request, error] of [
      [{ method: 'GET' as const, url: '/secret-jobs/..%2Fetc' }, 'invalid secret job id'],
      [
        { method: 'GET' as const, url: '/secret-jobs/..%2Fetc/frames' },
        'invalid secret job frame request',
      ],
      [{ method: 'POST' as const, url: '/secret-jobs/..%2Fetc/cleanup' }, 'invalid secret job id'],
    ] as const) {
      const response = await app.inject({
        ...request,
        headers: { authorization: 'Bearer valid-token' },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error });
    }
    // Vitest owns the injected methods; they do not use an object receiver.
    /* eslint-disable @typescript-eslint/unbound-method */
    expect(jobService.status).not.toHaveBeenCalled();
    expect(jobService.readFrames).not.toHaveBeenCalled();
    expect(jobService.cleanup).not.toHaveBeenCalled();
    /* eslint-enable @typescript-eslint/unbound-method */
  });

  it('refuses a frame cursor that is not a non-negative integer', async () => {
    const jobService = service();
    const app = appFor(jobService);
    for (const query of ['afterSequence=-1', 'afterSequence=1.5', 'afterSequence=abc']) {
      const response = await app.inject({
        method: 'GET',
        url: `/secret-jobs/job-1/frames?${query}`,
        headers: { authorization: 'Bearer valid-token' },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: 'invalid secret job frame request' });
    }
    // Vitest owns the injected method; it does not use an object receiver.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(jobService.readFrames).not.toHaveBeenCalled();
  });

  it('reports an unknown job as not found instead of an empty status', async () => {
    const response = await appFor(
      service({ status: vi.fn(() => Promise.resolve(undefined)) }),
    ).inject({
      method: 'GET',
      url: '/secret-jobs/job-missing',
      headers: { authorization: 'Bearer valid-token' },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'secret job not found' });
  });

  it('does not leak a status-path infrastructure failure to the caller', async () => {
    const response = await appFor(
      service({
        status: vi.fn(() => {
          throw new Error('store connection refused');
        }),
      }),
    ).inject({
      method: 'GET',
      url: '/secret-jobs/job-1',
      headers: { authorization: 'Bearer valid-token' },
    });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: 'internal server error' });
    expect(response.body).not.toContain('store connection refused');
  });

  it('separates an unauthorized frame read from an unreadable spool', async () => {
    // A caller who may not see this job must get the same answer as one asking
    // for a job that never existed; a corrupt spool is a different, 400-shaped
    // problem that a retry with a different cursor may fix.
    for (const [error, status, body] of [
      [
        new SecretJobServiceRejectedError('actor may not read this job'),
        404,
        { error: 'secret job not found' },
      ],
      [
        new SecretJobFrameSpoolError('spool checksum mismatch'),
        400,
        { error: 'secret job frames unavailable' },
      ],
      [new Error('disk full'), 500, { error: 'internal server error' }],
    ] as const) {
      const response = await appFor(
        service({ readFrames: vi.fn(() => Promise.reject(error)) }),
      ).inject({
        method: 'GET',
        url: '/secret-jobs/job-1/frames',
        headers: { authorization: 'Bearer valid-token' },
      });
      expect(response.statusCode).toBe(status);
      expect(response.json()).toEqual(body);
      expect(response.body).not.toContain(error.message);
    }
  });

  it('returns the cleanup receipt for an authorized caller', async () => {
    const jobService = service();
    const response = await appFor(jobService).inject({
      method: 'POST',
      url: '/secret-jobs/job-1/cleanup',
      headers: { authorization: 'Bearer valid-token' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      protocolVersion: 1,
      jobId: 'job-1',
      cleanupId: 'job-1:cleanup:1',
      disposition: 'already_reaped',
      completedAt: '2026-07-22T12:00:00.000Z',
    });
    // Vitest owns the injected method; it does not use an object receiver.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(jobService.cleanup).toHaveBeenCalledWith('job-1', ACTOR);
  });

  it('answers both cleanup refusal kinds as not found and keeps failures internal', async () => {
    for (const [error, status, body] of [
      [
        new SecretJobServiceRejectedError('actor may not clean up this job'),
        404,
        { error: 'secret job not found' },
      ],
      [new SecretJobRejectedError('job is not reapable'), 404, { error: 'secret job not found' }],
      [new Error('containerd unreachable'), 500, { error: 'internal server error' }],
    ] as const) {
      const response = await appFor(
        service({ cleanup: vi.fn(() => Promise.reject(error)) }),
      ).inject({
        method: 'POST',
        url: '/secret-jobs/job-1/cleanup',
        headers: { authorization: 'Bearer valid-token' },
      });
      expect(response.statusCode).toBe(status);
      expect(response.json()).toEqual(body);
      expect(response.body).not.toContain(error.message);
    }
  });
});
