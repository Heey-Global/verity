import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it, vi } from 'vitest';
import type { ContainerSpec } from '../docker.js';
import { checkProbeDatabaseSpace } from './probe-space.js';
const execute = promisify(execFile);
function fixture() {
  return {
    image: `postgres:18-alpine@sha256:${'a'.repeat(64)}`,
    architecture: 'amd64' as const,
    requiredBytes: 1025n,
    docker: {
      createContainer: vi.fn<(spec: ContainerSpec) => Promise<{ id: string; warnings: string[] }>>(
        async () => ({ id: 'space', warnings: [] }),
      ),
      startContainer: vi.fn(async () => undefined),
      waitContainer: vi.fn(async () => 0),
      removeContainer: vi.fn(async () => undefined),
    },
  };
}
it('checks the pinned image volume without networking or live mounts and rounds capacity up', async () => {
  const options = fixture();
  await checkProbeDatabaseSpace(options);
  const spec = options.docker.createContainer.mock.calls[0]![0];
  expect(spec).toMatchObject({
    image: options.image,
    platform: 'linux/amd64',
    network: 'none',
    readOnlyRootfs: true,
    entrypoint: ['sh', '-c'],
  });
  expect(spec.command?.at(-1)).toBe('2');
  expect(spec.binds).toBeUndefined();
  expect(spec.volumeMounts).toBeUndefined();
  expect(options.docker.removeContainer).toHaveBeenCalledExactlyOnceWith('space');
});
it('runs the capacity guard against the PostgreSQL volume parent and fails closed on bad or low df output', async () => {
  const options = fixture();
  await checkProbeDatabaseSpace(options);
  const command = options.docker.createContainer.mock.calls[0]![0].command!;
  const root = await mkdtemp(join(tmpdir(), 'probe-space-'));
  try {
    const bin = join(root, 'bin');
    await mkdir(bin);
    await writeFile(
      join(bin, 'df'),
      `#!/bin/sh\nprintf '%s' "$2" > "$PROBE_PATH_LOG"\nprintf 'Filesystem 1024-blocks Used Available Capacity Mounted on\\nvolume 100 10 %s 10%% /volume\\n' "$PROBE_FREE_KIB"\n`,
      { mode: 0o700 },
    );
    const environment = {
      ...process.env,
      PATH: bin + ':' + process.env.PATH,
      PGDATA: join(root, '18/docker'),
      PROBE_PATH_LOG: join(root, 'checked-path'),
    };
    for (const available of ['1', 'bogus', '-1', ''])
      await expect(
        execute('sh', ['-c', ...command], { env: { ...environment, PROBE_FREE_KIB: available } }),
      ).rejects.toThrow();
    await execute('sh', ['-c', ...command], { env: { ...environment, PROBE_FREE_KIB: '2' } });
    expect(await readFile(join(root, 'checked-path'), 'utf8')).toBe(root);
    await expect(
      execute('sh', ['-c', ...command], {
        env: { ...environment, PGDATA: 'relative', PROBE_FREE_KIB: '100' },
      }),
    ).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it('refuses unsafe image, size and timeout before allocating a worker', async () => {
  const options = fixture();
  for (const override of [
    { image: 'postgres:latest' },
    { requiredBytes: -1n },
    { requiredBytes: 2n ** 80n },
    { timeoutMs: 0 },
  ])
    await expect(checkProbeDatabaseSpace({ ...options, ...override })).rejects.toThrow();
  expect(options.docker.createContainer).not.toHaveBeenCalled();
});
it('removes workers after insufficient space or failed startup', async () => {
  const options = fixture();
  options.docker.waitContainer.mockResolvedValueOnce(1);
  await expect(checkProbeDatabaseSpace(options)).rejects.toThrow('unverifiable');
  options.docker.startContainer.mockRejectedValueOnce(new Error('start failed'));
  await expect(checkProbeDatabaseSpace(options)).rejects.toThrow('start failed');
  expect(options.docker.removeContainer).toHaveBeenCalledTimes(2);
});
it('bounds stalled checks and removes the worker', async () => {
  const options = fixture();
  options.docker.waitContainer.mockImplementationOnce(() => new Promise(() => {}));
  await expect(checkProbeDatabaseSpace({ ...options, timeoutMs: 10 })).rejects.toThrow('timed out');
  expect(options.docker.removeContainer).toHaveBeenCalledOnce();
});
it('honors shutdown before allocation and while waiting', async () => {
  const options = fixture();
  await expect(
    checkProbeDatabaseSpace({ ...options, signal: AbortSignal.abort() }),
  ).rejects.toThrow();
  expect(options.docker.createContainer).not.toHaveBeenCalled();
  const controller = new AbortController();
  options.docker.waitContainer.mockImplementationOnce(async () => {
    controller.abort();
    return 0;
  });
  await expect(checkProbeDatabaseSpace({ ...options, signal: controller.signal })).rejects.toThrow(
    'aborted',
  );
  expect(options.docker.removeContainer).toHaveBeenCalledOnce();
});
