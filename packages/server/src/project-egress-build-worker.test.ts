import { describe, expect, it, vi } from 'vitest';
import { superviseProtectedBuild } from './project-egress-build-worker.js';
import { ProtectedBuildFailure } from './project-egress-build-error.js';
import { ProtectedBuildTransportError } from './project-egress-build-client.js';
import type { ProtectedBuildCommand, ProtectedBuildReply } from './project-egress-build.js';

const request = {
  projectId: 'project-a',
  attemptId: '11111111-1111-4111-8111-111111111111',
  snapshot: 'attempt-a/verity-build-a',
  image: `verity-devc-repo:${'a'.repeat(12)}`,
  noCache: false,
};
const record = (
  ended: boolean,
  phase: 'running' | 'succeeded' | 'stopping' = 'running',
): ProtectedBuildReply => ({ version: 1, record: { request, phase, ended } });

describe('protected build worker supervision', () => {
  it('recovers a lost begin reply using the same immutable attempt', async () => {
    let begins = 0;
    const command = vi.fn(async (input: ProtectedBuildCommand): Promise<ProtectedBuildReply> => {
      if (input.operation === 'health') return { version: 1, available: true };
      if (input.operation === 'begin') {
        if (++begins === 1) throw new ProtectedBuildTransportError();
        return record(false);
      }
      return record(true, 'succeeded');
    });
    expect(
      await superviseProtectedBuild(request, command, { pause: async () => undefined }),
    ).toEqual({ success: true });
    expect(
      command.mock.calls.filter(([input]) => input.operation === 'begin').map(([input]) => input),
    ).toEqual([
      { operation: 'begin', request },
      { operation: 'begin', request },
    ]);
  });
  it('requires host-confirmed complete termination, renewing only a running attempt', async () => {
    let statuses = 0;
    const command = vi.fn(async (input: ProtectedBuildCommand): Promise<ProtectedBuildReply> => {
      if (input.operation === 'health') return { version: 1, available: true };
      if (input.operation === 'status')
        return ++statuses === 1
          ? record(false)
          : statuses === 2
            ? record(false, 'stopping')
            : record(true, 'succeeded');
      return record(false);
    });
    expect(
      await superviseProtectedBuild(request, command, { pause: async () => undefined }),
    ).toEqual({ success: true });
    expect(command.mock.calls.map(([input]) => input.operation)).toEqual([
      'health',
      'begin',
      'status',
      'heartbeat',
      'status',
      'status',
    ]);
  });
  it('does not retry refusals and tries to contain an unknown begin outcome', async () => {
    const command = vi.fn(async (input: ProtectedBuildCommand): Promise<ProtectedBuildReply> => {
      if (input.operation === 'health') return { version: 1, available: true };
      throw new Error('refused');
    });
    await expect(superviseProtectedBuild(request, command)).rejects.toThrow('refused');
    expect(command.mock.calls.map(([input]) => input.operation)).toEqual([
      'health',
      'begin',
      'cancel',
      'status',
    ]);
  });
  it('does not return a releasable outcome when timed-out cancellation is uncertain', async () => {
    let time = 0;
    const command = vi.fn(async (input: ProtectedBuildCommand): Promise<ProtectedBuildReply> => {
      if (input.operation === 'health') return { version: 1, available: true };
      if (input.operation === 'begin') {
        time = 2;
        return record(false);
      }
      return record(false, 'stopping');
    });
    await expect(
      superviseProtectedBuild(request, command, { now: () => time, timeoutMs: 1 }),
    ).rejects.toThrow('termination is unconfirmed');
  });
  it('rejects missing readiness before any host work', async () => {
    const command = vi.fn(async (): Promise<ProtectedBuildReply> => ({
      version: 1,
      available: false,
    }));
    await expect(superviseProtectedBuild(request, command)).rejects.toThrow('not ready');
    expect(command).toHaveBeenCalledTimes(1);
  });
});

it('recovers completion between a running status and heartbeat refusal', async () => {
  let statuses = 0;
  const command = vi.fn(async (input: ProtectedBuildCommand): Promise<ProtectedBuildReply> => {
    if (input.operation === 'health') return { version: 1, available: true };
    if (input.operation === 'heartbeat') throw new Error('terminal');
    if (input.operation === 'status')
      return ++statuses === 1 ? record(false) : record(true, 'succeeded');
    return record(false);
  });
  expect(await superviseProtectedBuild(request, command, { pause: async () => undefined })).toEqual(
    { success: true },
  );
  expect(command.mock.calls.some(([input]) => input.operation === 'cancel')).toBe(false);
});

it('releases a failed begin only after matching terminal cancellation confirmation', async () => {
  const command = vi.fn(async (input: ProtectedBuildCommand): Promise<ProtectedBuildReply> => {
    if (input.operation === 'health') return { version: 1, available: true };
    if (input.operation === 'begin')
      throw new ProtectedBuildFailure('files_prepare_failed', {
        correlationId: '22222222-2222-4222-8222-222222222222',
      });
    return { version: 1, record: { request, ended: true, phase: 'failed' } };
  });
  await expect(superviseProtectedBuild(request, command)).resolves.toEqual({
    success: false,
    failure: {
      reason: 'files_prepare_failed',
      correlationId: '22222222-2222-4222-8222-222222222222',
    },
  });
});

it('recovers terminal status after cancellation transport failure', async () => {
  const command = async (input: ProtectedBuildCommand): Promise<ProtectedBuildReply> => {
    if (input.operation === 'health') return { version: 1, available: true };
    if (input.operation === 'status')
      return { version: 1, record: { request, ended: true, phase: 'failed' } };
    throw new Error('lost');
  };
  await expect(superviseProtectedBuild(request, command)).resolves.toEqual({ success: false });
});

it.each(['identity', 'phase'] as const)(
  'retains storage for invalid ended evidence: %s',
  async (invalid) => {
    const command = async (input: ProtectedBuildCommand): Promise<ProtectedBuildReply> => {
      if (input.operation === 'health') return { version: 1, available: true };
      if (input.operation === 'begin') throw new Error('refused');
      return {
        version: 1,
        record: {
          request: invalid === 'identity' ? { ...request, projectId: 'other' } : request,
          ended: true,
          phase: invalid === 'phase' ? 'running' : 'failed',
        },
      };
    };
    await expect(superviseProtectedBuild(request, command)).rejects.toThrow('refused');
  },
);

it('reports success when the error path proves the build itself succeeded', async () => {
  // Status failing after completion (e.g. a cleanup refusal) must not discard a built image.
  const command = vi.fn(async (input: ProtectedBuildCommand): Promise<ProtectedBuildReply> => {
    if (input.operation === 'health') return { version: 1, available: true };
    if (input.operation === 'begin') return record(false);
    if (input.operation === 'status' && command.mock.calls.length < 4)
      throw new ProtectedBuildFailure('cleanup_failed');
    return record(true, 'succeeded');
  });
  // A bounded clock makes an unconfirmed outcome fail fast instead of polling forever.
  let tick = 0;
  expect(
    await superviseProtectedBuild(request, command, {
      pause: async () => undefined,
      now: () => ++tick,
      timeoutMs: 20,
    }),
  ).toEqual({ success: true });
});

it('confirms termination by request fields, independent of serialized key order', async () => {
  const reordered = {
    noCache: request.noCache,
    image: request.image,
    snapshot: request.snapshot,
    attemptId: request.attemptId,
    projectId: request.projectId,
  };
  const command = vi.fn(async (input: ProtectedBuildCommand): Promise<ProtectedBuildReply> => {
    if (input.operation === 'health') return { version: 1, available: true };
    if (input.operation === 'begin') return record(false);
    return { version: 1, record: { request: reordered, phase: 'succeeded', ended: true } };
  });
  // A bounded clock makes an unconfirmed outcome fail fast instead of polling forever.
  let tick = 0;
  expect(
    await superviseProtectedBuild(request, command, {
      pause: async () => undefined,
      now: () => ++tick,
      timeoutMs: 20,
    }),
  ).toEqual({ success: true });
});
