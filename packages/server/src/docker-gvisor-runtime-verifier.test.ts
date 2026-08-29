import { describe, expect, it, vi } from 'vitest';

import type { DockerClient } from './docker.js';
import { createDockerGvisorRuntimeVerifier } from './docker-gvisor-runtime-verifier.js';

const expected = {
  runtimeName: 'runsc',
  expectedPath: '/opt/verity/runsc/release-20260714.0/runsc',
  expectedArgs: ['--platform=systrap', '--network=none'],
} as const;

function dockerWith(inspectRuntime: DockerClient['inspectRuntime']): DockerClient {
  return { inspectRuntime } as DockerClient;
}

describe('Docker gVisor runtime verifier', () => {
  it('re-attests the exact registered path and arguments on every launch', async () => {
    const inspectRuntime = vi.fn(async () => ({
      path: expected.expectedPath,
      args: [...expected.expectedArgs],
    }));
    const verifier = createDockerGvisorRuntimeVerifier({
      docker: dockerWith(inspectRuntime),
      ...expected,
    });

    await verifier.verify('runsc');
    await verifier.verify('runsc');
    expect(inspectRuntime).toHaveBeenCalledTimes(2);
  });

  it('detects daemon drift after an earlier successful verification', async () => {
    const inspectRuntime = vi
      .fn<NonNullable<DockerClient['inspectRuntime']>>()
      .mockResolvedValueOnce({ path: expected.expectedPath, args: [...expected.expectedArgs] })
      .mockResolvedValueOnce({ path: '/usr/bin/runc', args: [] });
    const verifier = createDockerGvisorRuntimeVerifier({
      docker: dockerWith(inspectRuntime),
      ...expected,
    });

    await expect(verifier.verify('runsc')).resolves.toBeUndefined();
    await expect(verifier.verify('runsc')).rejects.toThrow(/path mismatch/);
  });

  it.each([
    ['missing', undefined],
    ['wrong path', { path: '/usr/bin/runc', args: [...expected.expectedArgs] }],
    ['wrong args', { path: expected.expectedPath, args: ['--network=host'] }],
  ])('fails closed for %s and retries after repair', async (_case, registration) => {
    const inspectRuntime = vi
      .fn<NonNullable<DockerClient['inspectRuntime']>>()
      .mockResolvedValueOnce(registration)
      .mockResolvedValueOnce({ path: expected.expectedPath, args: [...expected.expectedArgs] });
    const verifier = createDockerGvisorRuntimeVerifier({
      docker: dockerWith(inspectRuntime),
      ...expected,
    });

    await expect(verifier.verify('runsc')).rejects.toThrow(/missing|mismatch/);
    await expect(verifier.verify('runsc')).resolves.toBeUndefined();
    expect(inspectRuntime).toHaveBeenCalledTimes(2);
  });

  it('rejects an unexpected runtime name before touching Docker', async () => {
    const inspectRuntime = vi.fn();
    const verifier = createDockerGvisorRuntimeVerifier({
      docker: dockerWith(inspectRuntime),
      ...expected,
    });
    await expect(verifier.verify('runc')).rejects.toThrow(/unexpected/);
    expect(inspectRuntime).not.toHaveBeenCalled();
  });
});
