import { createServer, type Server } from 'node:net';
import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { handleSupervisorRequest } from '../../../features/verity-sandbox-toolkit/bin/verity-runner-supervisor.mjs';

const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'runner-cache-supervisor-'));
  roots.push(root);
  const requests: Record<string, unknown>[] = [];
  const server = createServer((socket) => {
    let buffer = '';
    socket.on('data', (data) => {
      buffer += data.toString();
      if (!buffer.includes('\n')) return;
      requests.push(JSON.parse(buffer.split('\n')[0]!) as Record<string, unknown>);
      socket.end(
        JSON.stringify({
          ok: true,
          report: { sharedBytes: 123, legacyBytes: 0, blockers: [], usageComplete: true },
        }) + '\n',
      );
    });
  });
  servers.push(server);
  const path = join(root, 'broker.sock');
  await new Promise<void>((resolve) => server.listen(path, resolve));
  vi.stubEnv('VERITY_AGENT_SPAWN_BROKER_SOCKET', path);
  return { root, requests };
}
async function turn(root: string, id: string, sessionId: string, status: string) {
  const directory = join(root, 'turns', id);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, 'state.json'),
    JSON.stringify({
      protocolVersion: 1,
      turnId: id,
      startCommandId: 'start',
      runnerInstanceId: 'runner',
      createdAt: 0,
      updatedAt: 0,
      sessionId,
      status,
    }),
  );
}
it('forwards cache maintenance and its report but excludes unsettled sessions', async () => {
  const { root, requests } = await fixture();
  await turn(root, 'busy-turn', 'busy', 'running');
  await turn(root, 'old-turn', 'idle', 'settled');
  const response = await handleSupervisorRequest(root, 'runner', {
    protocolVersion: 1,
    kind: 'reclaim-package-caches',
    sessionIds: ['busy', 'idle'],
    maxBytes: 4096,
  });
  expect(requests).toEqual([
    { protocolVersion: 1, kind: 'reclaim-package-caches', sessionIds: ['idle'], maxBytes: 4096 },
  ]);
  expect(response).toMatchObject({
    ok: true,
    report: {
      sharedBytes: 123,
      legacyBytes: null,
      usageComplete: false,
      blockers: [expect.stringContaining('unsettled')],
    },
  });
});
it('retains caches when turn ownership is corrupt or missing', async () => {
  const { root, requests } = await fixture();
  await mkdir(join(root, 'turns', 'unknown'), { recursive: true });
  await expect(
    handleSupervisorRequest(root, 'runner', {
      protocolVersion: 1,
      kind: 'reclaim-package-caches',
      sessionIds: ['idle'],
      maxBytes: 4096,
    }),
  ).rejects.toThrow('ownership is unknown');
  expect(requests).toEqual([]);
});
it.each([
  { sessionIds: ['../escape'], maxBytes: 1 },
  { sessionIds: [], maxBytes: -1 },
  { sessionIds: Array.from({ length: 513 }, () => 'session'), maxBytes: 1 },
])('rejects invalid maintenance inventory %j', async (request) => {
  const { root, requests } = await fixture();
  await expect(
    handleSupervisorRequest(root, 'runner', {
      protocolVersion: 1,
      kind: 'reclaim-package-caches',
      ...request,
    }),
  ).rejects.toThrow('invalid package cache');
  expect(requests).toEqual([]);
});

it.each(['missing', 'invalid', 'historical', 'claimed', 'running'])(
  'diagnoses %s states without bypassing ownership',
  async (kind) => {
    const { root, requests } = await fixture();
    const directory = join(root, 'turns', 'private-turn');
    await mkdir(directory, { recursive: true });
    if (kind === 'invalid') await writeFile(join(directory, 'state.json'), '{private content');
    if (kind === 'historical')
      await writeFile(
        join(directory, 'state.json'),
        JSON.stringify({ status: 'settled', protocolVersion: 0 }),
      );
    if (kind === 'claimed' || kind === 'running') {
      await turn(root, 'private-turn', 'idle', kind);
      const { readFile } = await import('node:fs/promises');
      const state = JSON.parse(await readFile(join(directory, 'state.json'), 'utf8'));
      delete state.sessionId;
      await writeFile(join(directory, 'state.json'), JSON.stringify(state));
    }
    await expect(
      handleSupervisorRequest(root, 'runner', {
        protocolVersion: 1,
        kind: 'reclaim-package-caches',
        sessionIds: ['idle'],
        maxBytes: 4096,
      }),
    ).rejects.toMatchObject({
      runnerCacheFailure: {
        code: 'turn-ownership-unknown',
        counts: {
          missingState: Number(kind === 'missing'),
          invalidState: Number(kind === 'invalid' || kind === 'historical'),
          unsettledWithoutSession: Number(kind === 'claimed' || kind === 'running'),
        },
      },
    });
    expect(requests).toEqual([]);
  },
);
it('allows valid settled states without sessionId to reach the broker', async () => {
  const { root, requests } = await fixture();
  await turn(root, 'old-turn', 'idle', 'settled');
  const { readFile } = await import('node:fs/promises');
  const path = join(root, 'turns', 'old-turn', 'state.json');
  const state = JSON.parse(await readFile(path, 'utf8'));
  delete state.sessionId;
  await writeFile(path, JSON.stringify(state));
  await expect(
    handleSupervisorRequest(root, 'runner', {
      protocolVersion: 1,
      kind: 'reclaim-package-caches',
      sessionIds: ['idle'],
      maxBytes: 4096,
    }),
  ).resolves.toMatchObject({ ok: true });
  expect(requests).toHaveLength(1);
});
it('distinguishes an absent broker from unknown turn ownership', async () => {
  const { root } = await fixture();
  vi.stubEnv('VERITY_AGENT_SPAWN_BROKER_SOCKET', join(root, 'absent.sock'));
  await expect(
    handleSupervisorRequest(root, 'runner', {
      protocolVersion: 1,
      kind: 'reclaim-package-caches',
      sessionIds: [],
      maxBytes: 4096,
    }),
  ).rejects.toMatchObject({ runnerCacheFailure: { code: 'broker-unavailable' } });
});

it.skipIf(process.getuid!() === 0)(
  'distinguishes broker socket access denial without exposing paths',
  async () => {
    const { root } = await fixture();
    const socket = join(root, 'broker.sock');
    await chmod(socket, 0o000);
    try {
      await expect(
        handleSupervisorRequest(root, 'runner', {
          protocolVersion: 1,
          kind: 'reclaim-package-caches',
          sessionIds: [],
          maxBytes: 4096,
        }),
      ).rejects.toMatchObject({ runnerCacheFailure: { code: 'broker-access-denied' } });
    } finally {
      await chmod(socket, 0o600);
    }
  },
);
