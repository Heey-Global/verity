import type {
  RunGrantClaims,
  SecretJobCleanupResponse,
  SecretJobStartRequest,
  SecretJobTerminalResult,
  SecretToolInvocation,
} from '@verity/secret-contracts';
import { describe, expect, it, vi } from 'vitest';

import type { BrokeredSecretJobExecutor } from './brokered-secret-job-executor.js';
import { createInMemorySecretJobFrameSpool } from './secret-job-frame-spool.js';
import {
  createSecretJobService,
  SecretJobServiceRejectedError,
  type SecretJobAuthorization,
} from './secret-job-service.js';

const HASH = 'a'.repeat(64);
const IMAGE = 'b'.repeat(64);

function claims(): RunGrantClaims {
  return {
    protocolVersion: 1,
    grantId: 'grant-1',
    requestHash: HASH,
    projectId: 'project-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    toolCallId: 'call-1',
    profile: { id: 'profile-1', version: 1, policyHash: HASH },
    executorImageDigest: IMAGE,
    aliases: [{ id: 'alias-1', version: 1 }],
    providerBindings: [{ id: 'binding-1', version: 1, provider: 'doppler' }],
    snapshotId: HASH,
    audience: 'verity-secret-job-executor',
    issuedAt: '2026-07-22T12:00:00.000Z',
    expiresAt: '2026-07-22T12:01:00.000Z',
    nonce: 'bm9uY2U',
    approval: { id: 'approval-1', actorId: 'user-1', decisionHash: HASH },
  };
}

function invocation(): SecretToolInvocation {
  return {
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
}

function setup(
  options: {
    denied?: boolean;
    hold?: boolean;
    imageDigest?: string;
  } = {},
) {
  let release: (() => void) | undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const authorization: SecretJobAuthorization = {
    request: vi.fn(() => Promise.resolve({ approvalId: 'approval-1' })),
    decide: vi.fn(() =>
      Promise.resolve(
        options.denied
          ? { decision: 'denied' as const }
          : {
              decision: 'approved' as const,
              capability: 'never-return-this',
              claims: { ...claims(), executorImageDigest: options.imageDigest ?? IMAGE },
            },
      ),
    ),
  };
  const states = new Map<string, 'pending' | 'running' | 'reaped'>();
  const terminal: SecretJobTerminalResult = {
    protocolVersion: 1,
    jobId: 'job-1',
    outcome: 'succeeded',
    finishedAt: '2026-07-22T12:00:30.000Z',
  };
  const runJob = vi.fn(async (_grant, request: SecretJobStartRequest) => {
    states.set(request.jobId, 'running');
    if (options.hold) await held;
    states.set(request.jobId, 'reaped');
    return terminal;
  });
  const cleanup = vi.fn((jobId: string): Promise<SecretJobCleanupResponse> =>
    Promise.resolve({
      protocolVersion: 1,
      jobId,
      cleanupId: `${jobId}:cleanup:1`,
      disposition: 'already_reaped',
      completedAt: '2026-07-22T12:00:31.000Z',
    }),
  );
  const executor: BrokeredSecretJobExecutor = {
    runJob,
    cleanup,
    jobState: (jobId) => states.get(jobId),
    boundGrants: () => 0,
  };
  const frames = createInMemorySecretJobFrameSpool();
  const service = createSecretJobService({
    authorization,
    executor,
    frames,
    randomId: () => 'fixed',
    now: () => new Date('2026-07-22T12:00:00.000Z'),
  });
  return { service, authorization, runJob, cleanup, frames, release: release! };
}

describe('secret job service', () => {
  it('requests approval through the authorization boundary', async () => {
    const { service, authorization } = setup();
    await expect(
      service.request(invocation(), { actorId: 'user-1', authorizationHash: HASH }),
    ).resolves.toEqual({ approvalId: 'approval-1' });
    // Vitest owns the injected method; it does not use an object receiver.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(authorization.request).toHaveBeenCalledWith(invocation(), HASH);
  });

  it('rejects a malformed image digest returned by authorization', async () => {
    const { service, runJob } = setup({ imageDigest: 'not-a-digest' });
    await expect(
      service.decideAndStart({
        approvalId: 'approval-1',
        actor: { actorId: 'user-1', authorizationHash: HASH },
        approved: true,
        jobId: 'job-1',
        absoluteDeadline: '2026-07-22T12:00:59.000Z',
      }),
    ).rejects.toThrow();
    expect(runJob).not.toHaveBeenCalled();
  });

  it('keeps the capability internal and derives launch context from approved claims', async () => {
    const { service, runJob, release } = setup({ hold: true });
    const response = await service.decideAndStart({
      approvalId: 'approval-1',
      actor: { actorId: 'user-1', authorizationHash: HASH },
      approved: true,
      jobId: 'job-1',
      absoluteDeadline: '2026-07-22T12:00:59.000Z',
    });

    expect(response).toEqual({ decision: 'approved', jobId: 'job-1', state: 'pending' });
    expect(JSON.stringify(response)).not.toContain('never-return-this');
    expect(runJob).toHaveBeenCalledWith(
      { capability: 'never-return-this', claims: claims() },
      expect.objectContaining({
        requestId: 'request-fixed',
        projectId: 'project-1',
        requestHash: HASH,
        grantId: 'grant-1',
        profile: claims().profile,
        snapshotId: HASH,
        jobId: 'job-1',
        executorImageDigest: IMAGE,
      }),
    );
    release();
    await expect(
      service.settle('job-1', { actorId: 'user-1', authorizationHash: HASH }),
    ).resolves.toMatchObject({
      state: 'reaped',
      result: { outcome: 'succeeded' },
    });
  });

  it('does not launch a denied request', async () => {
    const { service, runJob } = setup({ denied: true });
    await expect(
      service.decideAndStart({
        approvalId: 'approval-1',
        actor: { actorId: 'user-1', authorizationHash: HASH },
        approved: false,
      }),
    ).resolves.toEqual({ decision: 'denied' });
    expect(runJob).not.toHaveBeenCalled();
  });

  it('rejects duplicate job ids before spending another approval', async () => {
    const { service, authorization } = setup({ hold: true });
    const input = {
      approvalId: 'approval-1',
      actor: { actorId: 'user-1', authorizationHash: HASH },
      approved: true,
      jobId: 'job-1',
      absoluteDeadline: '2026-07-22T12:00:59.000Z',
    } as const;
    await service.decideAndStart(input);
    await expect(service.decideAndStart(input)).rejects.toBeInstanceOf(
      SecretJobServiceRejectedError,
    );
    // Vitest owns the injected method; it does not use an object receiver.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(authorization.decide).toHaveBeenCalledTimes(1);
  });

  it('reserves a job id before awaiting approval under concurrent starts', async () => {
    const { service, authorization } = setup({ hold: true });
    const input = {
      approvalId: 'approval-1',
      actor: { actorId: 'user-1', authorizationHash: HASH },
      approved: true,
      jobId: 'job-1',
      absoluteDeadline: '2026-07-22T12:00:59.000Z',
    } as const;
    const [first, second] = await Promise.allSettled([
      service.decideAndStart(input),
      service.decideAndStart(input),
    ]);
    expect(first.status).toBe('fulfilled');
    expect(second).toMatchObject({
      status: 'rejected',
      reason: expect.any(SecretJobServiceRejectedError),
    });
    // Vitest owns the injected method; it does not use an object receiver.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(authorization.decide).toHaveBeenCalledTimes(1);
  });

  it('clamps a requested deadline to the approved grant expiry', async () => {
    const { service, runJob } = setup();
    await expect(
      service.decideAndStart({
        approvalId: 'approval-1',
        actor: { actorId: 'user-1', authorizationHash: HASH },
        approved: true,
        jobId: 'job-1',
        absoluteDeadline: '2026-07-22T12:01:01.000Z',
      }),
    ).resolves.toMatchObject({ decision: 'approved' });
    expect(runJob).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ absoluteDeadline: '2026-07-22T12:01:00.000Z' }),
    );
  });

  it('replays durable frames and delegates cleanup without deleting output', async () => {
    const { service, frames, cleanup } = setup();
    const actor = { actorId: 'user-1', authorizationHash: HASH };
    await service.decideAndStart({
      approvalId: 'approval-1',
      actor,
      approved: true,
      jobId: 'job-1',
      absoluteDeadline: '2026-07-22T12:00:59.000Z',
    });
    await service.settle('job-1', actor);
    await frames.persist({
      protocolVersion: 1,
      jobId: 'job-1',
      sequence: 0,
      stream: 'stdout',
      encoding: 'utf8',
      payload: 'redacted output',
      emittedAt: '2026-07-22T12:00:01.000Z',
    });
    await expect(service.readFrames('job-1', actor)).resolves.toMatchObject({
      frames: [{ payload: 'redacted output' }],
    });
    await expect(service.cleanup('job-1', actor)).resolves.toMatchObject({
      disposition: 'already_reaped',
    });
    expect(cleanup).toHaveBeenCalledWith('job-1');
    await expect(service.readFrames('job-1', actor)).resolves.toMatchObject({
      frames: [{ payload: 'redacted output' }],
    });
  });
});
