import { hostname } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { createServerLogSource } from './server-log-source.js';
vi.mock('node:os', () => ({ hostname: () => 'current-generation' }));
afterEach(() => vi.unstubAllEnvs());
it('reads the current container even when HOSTNAME was inherited from a retired generation', async () => {
  vi.stubEnv('HOSTNAME', 'retired-generation');
  const containerLogs = vi.fn().mockResolvedValue('ready');
  const window = { since: '2026-10-29T10:00:00Z', until: '2026-10-29T11:00:00Z' };
  expect(await createServerLogSource({ containerLogs })!(window)).toBe('ready');
  expect(containerLogs).toHaveBeenCalledWith(hostname(), 1000, window);
});
it('honors an explicit container identity and reports an absent transport as unconfigured', async () => {
  const containerLogs = vi.fn().mockResolvedValue('ready');
  const window = { since: '2026-10-29T10:00:00Z', until: '2026-10-29T11:00:00Z' };
  await createServerLogSource({ containerLogs }, 'explicit-server')!(window);
  expect(containerLogs).toHaveBeenCalledWith('explicit-server', 1000, window);
  expect(createServerLogSource(undefined)).toBeUndefined();
});
