import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { handleSupervisorRequest } from '../../../features/verity-sandbox-toolkit/bin/verity-runner-supervisor.mjs';

it('forwards only the validated capacity frame to the trusted broker', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cl-'));
  const frames: unknown[] = [];
  const server = createServer((socket) =>
    socket.once('data', (data) => {
      frames.push(JSON.parse(String(data)));
      socket.end(JSON.stringify({ ok: true, state: 'held' }) + '\n');
    }),
  );
  try {
    const path = join(root, 'b.sock');
    await new Promise<void>((resolve) => server.listen(path, resolve));
    vi.stubEnv('VERITY_AGENT_SPAWN_BROKER_SOCKET', path);
    const request = {
      protocolVersion: 1,
      kind: 'capacity-lease',
      action: 'retire',
      operationId: 'f58431a8-fcce-4d63-a401-3583c98a55d1',
      generation: 'generation-one',
    };
    expect(
      await handleSupervisorRequest(root, 'runner', { ...request, path: '/tmp/evil' }),
    ).toEqual({ ok: true, state: 'held' });
    expect(frames).toEqual([request]);
    await expect(
      handleSupervisorRequest(root, 'runner', { ...request, operationId: '../evil' }),
    ).rejects.toThrow('invalid capacity lease');
    expect(frames).toHaveLength(1);
  } finally {
    vi.unstubAllEnvs();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
