import { describe, expect, it, vi } from 'vitest';
import { DockerError } from '../docker.js';
import { isRetryablePullError, pullWithRetry } from './pull-retry.js';

const image = `ghcr.io/heey-global/verity/verity-server@sha256:${'b'.repeat(64)}`;
const stalled = new DockerError({ kind: 'pull_stalled', image, idleMs: 1, message: 'stalled' });

describe('isRetryablePullError', () => {
  it.each([
    ['a stall', stalled, true],
    ['a dropped connection', new DockerError({ kind: 'network', cause: new Error('reset') }), true],
    [
      'a registry 5xx reported inside the stream',
      new DockerError({
        kind: 'other',
        status: 200,
        message: 'image pull failed: received unexpected HTTP status: 503 Service Unavailable',
      }),
      true,
    ],
    [
      'a dial timeout reported inside the stream',
      new DockerError({
        kind: 'other',
        status: 200,
        message: 'image pull failed: dial tcp 140.82.0.1:443: i/o timeout',
      }),
      true,
    ],
    // A pull still moving after the whole ceiling would spend it again.
    [
      'the ceiling',
      new DockerError({ kind: 'timeout', image, timeoutMs: 1, message: 'did not finish' }),
      false,
    ],
    [
      'a missing image',
      new DockerError({ kind: 'image_not_found', image, message: 'manifest unknown' }),
      false,
    ],
    [
      'a full disk',
      new DockerError({
        kind: 'other',
        status: 200,
        message: 'image pull failed: write /var/lib/docker/tmp: no space left on device',
      }),
      false,
    ],
    ['an error that is not from Docker', new Error('i/o timeout'), false],
  ] as const)('%s', (_name, error, retryable) => {
    expect(isRetryablePullError(error)).toBe(retryable);
  });
});

describe('pullWithRetry', () => {
  it('waits the configured delays between attempts and rethrows the last failure', async () => {
    const pull = vi.fn(async () => {
      throw stalled;
    });
    const sleep = vi.fn<(ms: number) => Promise<unknown>>(async () => undefined);
    await expect(pullWithRetry(image, pull, { delaysMs: [1, 2], sleep })).rejects.toBe(stalled);
    expect(pull).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([1, 2]);
  });

  it('returns as soon as an attempt succeeds', async () => {
    const pull = vi.fn<() => Promise<void>>().mockRejectedValueOnce(stalled).mockResolvedValue();
    const sleep = vi.fn<(ms: number) => Promise<unknown>>(async () => undefined);
    await expect(pullWithRetry(image, pull, { delaysMs: [1, 2], sleep })).resolves.toBeUndefined();
    expect(pull).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });
});
