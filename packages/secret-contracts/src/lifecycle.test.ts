import { describe, expect, it } from 'vitest';
import {
  executorProtocolHelloSchema,
  secretJobAttachExchangeSchema,
  secretJobAttachRequestSchema,
  secretJobAttachResponseSchema,
  secretJobCleanupResponseSchema,
  secretJobFrameSchema,
  secretJobStartRequestSchema,
  secretJobTransitionSchema,
} from './index.js';

const hash = 'a'.repeat(64);
const profile = { id: 'staging-pods-list', version: 3, policyHash: hash };

describe('secret job executor lifecycle contracts', () => {
  it('advertises only explicit runtime and protocol support', () => {
    expect(
      executorProtocolHelloSchema.parse({
        executorInstanceId: 'executor-1',
        supportedProtocolVersions: [1],
        runtime: 'docker-gvisor',
        runtimeVersion: 'runsc-1',
        imageDigest: hash,
      }).runtime,
    ).toBe('docker-gvisor');
    expect(() =>
      executorProtocolHelloSchema.parse({
        executorInstanceId: 'executor-1',
        supportedProtocolVersions: [1, 1],
        runtime: 'plain-docker',
        runtimeVersion: 'runc',
        imageDigest: hash,
      }),
    ).toThrow();
  });

  it('binds an idempotent start to request and immutable executor inputs', () => {
    expect(
      secretJobStartRequestSchema.parse({
        protocolVersion: 1,
        requestId: 'request-1',
        projectId: 'project-1',
        requestHash: hash,
        jobId: 'job-1',
        grantId: 'grant-1',
        profile,
        snapshotId: hash,
        executorImageDigest: hash,
        absoluteDeadline: '2026-07-17T20:00:00Z',
      }).jobId,
    ).toBe('job-1');
  });

  it('rejects oversized frames before they cross the executor boundary', () => {
    const frame = {
      protocolVersion: 1,
      jobId: 'job-1',
      sequence: 0,
      stream: 'stdout',
      encoding: 'utf8',
      payload: 'x'.repeat(65_537),
      emittedAt: '2026-07-17T20:00:00Z',
    } as const;
    expect(() => secretJobFrameSchema.parse(frame)).toThrow(/65536 bytes/);
  });

  it('requires contiguous, same-job replay frames', () => {
    const frame = (sequence: number, jobId = 'job-1') => ({
      protocolVersion: 1 as const,
      jobId,
      sequence,
      stream: 'system' as const,
      encoding: 'utf8' as const,
      payload: `frame-${sequence}`,
      emittedAt: '2026-07-17T20:00:00Z',
    });
    const replay = {
      protocolVersion: 1,
      jobId: 'job-1',
      firstSequence: 4,
      nextSequence: 6,
      frames: [frame(4), frame(5)],
      hasMore: false,
      state: 'running',
      attachmentState: 'attached',
    } as const;
    expect(secretJobAttachResponseSchema.parse(replay).nextSequence).toBe(6);
    expect(() =>
      secretJobAttachResponseSchema.parse({ ...replay, frames: [frame(4), frame(6)] }),
    ).toThrow(/non-contiguous/);
    expect(() =>
      secretJobAttachResponseSchema.parse({ ...replay, frames: [frame(4, 'other'), frame(5)] }),
    ).toThrow(/foreign frame/);
    expect(() =>
      secretJobAttachResponseSchema.parse({ ...replay, firstSequence: undefined }),
    ).toThrow(/require firstSequence/);
  });

  it('uses a next-sequence cursor and bounds aggregate replay bytes', () => {
    const request = {
      protocolVersion: 1,
      jobId: 'job-1',
      nextSequence: 0,
      maxFrames: 16,
      maxBytes: 1_048_576,
    } as const;
    expect(secretJobAttachRequestSchema.parse(request).nextSequence).toBe(0);

    const largeFrame = (sequence: number) => ({
      protocolVersion: 1 as const,
      jobId: 'job-1',
      sequence,
      stream: 'stdout' as const,
      encoding: 'utf8' as const,
      payload: 'x'.repeat(65_536),
      emittedAt: '2026-07-17T20:00:00Z',
    });
    expect(() =>
      secretJobAttachResponseSchema.parse({
        protocolVersion: 1,
        jobId: 'job-1',
        firstSequence: 0,
        nextSequence: 17,
        frames: Array.from({ length: 17 }, (_, index) => largeFrame(index)),
        hasMore: false,
        state: 'running',
        attachmentState: 'attached',
      }),
    ).toThrow(/replay page exceeds/);

    const response = {
      protocolVersion: 1,
      jobId: 'job-1',
      firstSequence: 0,
      nextSequence: 1,
      frames: [largeFrame(0)],
      hasMore: true,
      state: 'running',
      attachmentState: 'attached',
    } as const;
    expect(secretJobAttachExchangeSchema.parse({ request, response }).response.nextSequence).toBe(
      1,
    );
    expect(() =>
      secretJobAttachExchangeSchema.parse({
        request: { ...request, nextSequence: 1 },
        response,
      }),
    ).toThrow(/requested nextSequence/);
    expect(() =>
      secretJobAttachExchangeSchema.parse({
        request: { ...request, maxBytes: 1_024 },
        response,
      }),
    ).toThrow(/requested maxBytes/);
    for (const nextSequence of [0, 4]) {
      expect(() =>
        secretJobAttachExchangeSchema.parse({
          request: { ...request, nextSequence: 2 },
          response: {
            ...response,
            firstSequence: undefined,
            nextSequence,
            frames: [],
          },
        }),
      ).toThrow(/preserve requested nextSequence/);
    }
  });

  it('rejects skipped or reversed durable state transitions', () => {
    const transition = {
      protocolVersion: 1,
      jobId: 'job-1',
      from: 'running',
      to: 'terminal',
      transitionId: 'transition-1',
      observedAt: '2026-07-17T20:00:00Z',
    } as const;
    expect(secretJobTransitionSchema.parse(transition).to).toBe('terminal');
    expect(() =>
      secretJobTransitionSchema.parse({ ...transition, from: 'reaped', to: 'running' }),
    ).toThrow(/invalid job transition/);
  });

  it('makes cleanup retry and completion fields mutually consistent', () => {
    expect(() =>
      secretJobCleanupResponseSchema.parse({
        protocolVersion: 1,
        jobId: 'job-1',
        cleanupId: 'cleanup-1',
        disposition: 'retry',
      }),
    ).toThrow(/retryAfterSeconds/);
    expect(
      secretJobCleanupResponseSchema.parse({
        protocolVersion: 1,
        jobId: 'job-1',
        cleanupId: 'cleanup-1',
        disposition: 'reaped',
        completedAt: '2026-07-17T20:00:00Z',
      }).disposition,
    ).toBe('reaped');
  });
});
