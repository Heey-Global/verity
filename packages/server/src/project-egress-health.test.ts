import { afterEach, expect, it, vi } from 'vitest';
import {
  projectEgressAvailability,
  projectEgressFailure,
  projectEgressHealthReasons,
  projectEgressInstallationFailure,
  type ProjectEgressHealth,
} from './project-egress-health.js';

afterEach(() => vi.useRealTimers());
it('caches display probes but rechecks readiness when enabling', async () => {
  vi.useFakeTimers();
  const health = vi
    .fn<() => Promise<ProjectEgressHealth>>()
    .mockResolvedValue({ available: true, reason: 'ready' });
  const status = projectEgressAvailability(() => ({ health }));
  expect((await status()).available).toBe(true);
  health.mockResolvedValue({ available: false, reason: 'service_unreachable' });
  expect((await status()).available).toBe(true);
  expect(health).toHaveBeenCalledTimes(1);
  expect((await status(true)).reason).toBe('service_unreachable');
  expect(health).toHaveBeenCalledTimes(2);
  health.mockResolvedValue({ available: true, reason: 'ready' });
  await vi.advanceTimersByTimeAsync(10_001);
  expect((await status()).available).toBe(true);
});
it('uses installation failures only as an outage explanation, never as readiness', async () => {
  let installation: unknown = { version: 1, state: 'unavailable', reason: 'runtime_unsupported' };
  const health = vi
    .fn<() => Promise<ProjectEgressHealth>>()
    .mockResolvedValue({ available: false, reason: 'socket_missing' });
  const status = projectEgressAvailability(
    () => ({ health }),
    () => installation,
  );
  expect(await status()).toEqual({ available: false, reason: 'runtime_unsupported' });
  installation = { version: 1, state: 'ready', reason: 'ready' };
  expect(await status(true)).toEqual({ available: false, reason: 'socket_missing' });
  installation = { version: 1, state: 'unavailable', reason: 'private host exception' };
  expect((await status(true)).reason).toBe('socket_missing');
  installation = { version: 1, state: 'unavailable', reason: 'controller_failed' };
  health.mockResolvedValue({ available: true, reason: 'ready' });
  expect((await status(true)).available).toBe(true);
});
it('does not let missing or corrupt provisioning diagnostics break settings', async () => {
  const status = projectEgressAvailability(
    () => undefined,
    () => {
      throw new Error('private file');
    },
  );
  expect(await status()).toEqual({ available: false, reason: 'not_configured' });
  expect(projectEgressInstallationFailure(null)).toBeUndefined();
  expect(
    projectEgressInstallationFailure({
      version: 2,
      state: 'unavailable',
      reason: 'runtime_unsupported',
    }),
  ).toBeUndefined();
  expect(projectEgressFailure(new Error('private error'))).toEqual({
    available: false,
    reason: 'host_not_ready',
  });
  expect(projectEgressHealthReasons).not.toContain('private error');
});
