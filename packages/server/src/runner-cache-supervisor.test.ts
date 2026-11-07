import { createServer, type Server } from 'node:net';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import {
  claimTurn,
  readTurnState,
  handleSupervisorRequest,
} from '../../../features/verity-sandbox-toolkit/bin/verity-runner-supervisor.mjs';

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
async function fixture(
  reply?: unknown,
  options: {
    onMaintenance?: (respond: () => void) => void;
    capabilities?: Record<string, unknown>;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'runner-cache-supervisor-'));
  roots.push(root);
  const requests: Record<string, unknown>[] = [];
  const server = createServer((socket) => {
    let buffer = '';
    socket.on('data', (data) => {
      buffer += data.toString();
      if (!buffer.includes('\n')) return;
      const request = JSON.parse(buffer.split('\n')[0]!) as Record<string, unknown>;
      if (request.kind === 'status') {
        socket.end(
          JSON.stringify({
            ok: true,
            cacheMaintenanceVersion: 2,
            runtimeAdmissionFenceVersion: 1,
            ...options.capabilities,
          }) + '\n',
        );
        return;
      }
      requests.push(request);
      const respond = () =>
        socket.end(
          JSON.stringify(
            reply === undefined
              ? {
                  ok: true,
                  report: { sharedBytes: 123, legacyBytes: 0, blockers: [], usageComplete: true },
                }
              : reply,
          ) + '\n',
        );
      if (options.onMaintenance) options.onMaintenance(respond);
      else respond();
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

it.each([null, {}, { ok: 'wrong' }, { ok: true, padding: 'x'.repeat(65536) }])(
  'distinguishes invalid broker frames from explicit rejection',
  async (reply) => {
    const { root } = await fixture(reply);
    await expect(
      handleSupervisorRequest(root, 'runner', {
        protocolVersion: 1,
        kind: 'reclaim-package-caches',
        sessionIds: [],
        maxBytes: 4096,
      }),
    ).rejects.toMatchObject({ runnerCacheFailure: { code: 'broker-invalid-response' } });
  },
);
it('distinguishes explicit broker rejection and withholds its private reason', async () => {
  const { root } = await fixture({ ok: false, error: '/private/token' });
  const error = await handleSupervisorRequest(root, 'runner', {
    protocolVersion: 1,
    kind: 'reclaim-package-caches',
    sessionIds: [],
    maxBytes: 4096,
  }).catch((error: unknown) => error);
  expect(error).toMatchObject({ runnerCacheFailure: { code: 'broker-rejected' } });
  expect(String(error)).not.toContain('/private/token');
});

it('persists the validated Verity owner and rejects cross-session adoption', async () => {
  const { root } = await fixture();
  await expect(
    claimTurn(root, { turnId: 'owned', startCommandId: 'start', sessionId: 'owner' }, 'runner'),
  ).resolves.toMatchObject({ outcome: 'created', state: { sessionId: 'owner' } });
  expect((await readTurnState(root, 'owned'))?.sessionId).toBe('owner');
  await expect(
    claimTurn(root, { turnId: 'owned', startCommandId: 'start', sessionId: 'other' }, 'runner'),
  ).resolves.toMatchObject({ outcome: 'conflict', reason: 'session-identity-mismatch' });
  expect((await readTurnState(root, 'owned'))?.sessionId).toBe('owner');
});

it('accepts legacy ownership absence without assigning the retrying session', async () => {
  const { root } = await fixture();
  await claimTurn(root, { turnId: 'legacy', startCommandId: 'start' }, 'runner');
  await expect(
    claimTurn(root, { turnId: 'legacy', startCommandId: 'start', sessionId: 'retry' }, 'runner'),
  ).resolves.toMatchObject({ outcome: 'already-running' });
  expect((await readTurnState(root, 'legacy'))?.sessionId).toBeUndefined();
});

it.each(['../escape', '', 42, null])(
  'rejects invalid persisted session ownership %j',
  async (owner) => {
    const { root } = await fixture();
    await turn(root, 'owned', 'owner', 'running');
    const { readFile } = await import('node:fs/promises');
    const path = join(root, 'turns', 'owned', 'state.json');
    const state = JSON.parse(await readFile(path, 'utf8'));
    state.sessionId = owner;
    await writeFile(path, JSON.stringify(state));
    await expect(readTurnState(root, 'owned')).rejects.toThrow('invalid state');
  },
);

const pagedRequest = {
  protocolVersion: 1,
  kind: 'reclaim-package-caches',
  maintenanceVersion: 2,
  sessionIds: ['busy', 'idle'],
  maxBytes: 4096,
};

it('resolves one legacy owner without blocking unrelated idle homes', async () => {
  const { root, requests } = await fixture();
  await claimTurn(root, { turnId: 'legacy', startCommandId: 'start' }, 'runner');
  const pending = await handleSupervisorRequest(root, 'runner', pagedRequest);
  expect(pending).toMatchObject({
    maintenancePending: true,
    turnsNeedingOwnership: [
      {
        turnId: 'legacy',
        startCommandId: 'start',
        runnerInstanceId: 'runner',
        status: 'claimed',
      },
    ],
  });
  expect(requests).toEqual([]);
  const response = await handleSupervisorRequest(root, 'runner', {
    ...pagedRequest,
    scanId: pending.scanId,
    turnOwners: [{ turnId: 'legacy', sessionId: 'busy', conflict: false }],
  });
  expect(response).toMatchObject({ ok: true, report: { legacyBytes: null, usageComplete: false } });
  expect(requests).toEqual([
    { protocolVersion: 1, kind: 'reclaim-package-caches', sessionIds: ['idle'], maxBytes: 4096 },
  ]);
  expect((await readTurnState(root, 'legacy'))?.sessionId).toBeUndefined();
});

it('attributes a missing state without inventing settlement', async () => {
  const { root, requests } = await fixture();
  await mkdir(join(root, 'turns', 'missing'), { recursive: true });
  const pending = await handleSupervisorRequest(root, 'runner', pagedRequest);
  const response = await handleSupervisorRequest(root, 'runner', {
    ...pagedRequest,
    scanId: pending.scanId,
    turnOwners: [{ turnId: 'missing', sessionId: 'busy', conflict: false }],
  });
  expect(response).toMatchObject({ report: { usageComplete: false } });
  expect(requests[0]?.sessionIds).toEqual(['idle']);
  expect(await readTurnState(root, 'missing')).toBeUndefined();
});

it.each([
  { turnOwners: [] },
  { turnOwners: [{ turnId: 'missing', sessionId: 'busy', conflict: true }] },
])(
  'retains all legacy homes for unresolved ownership but permits leased shared maintenance: %j',
  async ({ turnOwners }) => {
    const { root, requests } = await fixture();
    await mkdir(join(root, 'turns', 'missing'), { recursive: true });
    const pending = await handleSupervisorRequest(root, 'runner', pagedRequest);
    const response = await handleSupervisorRequest(root, 'runner', {
      ...pagedRequest,
      scanId: pending.scanId,
      turnOwners,
    });
    expect(requests[0]?.sessionIds).toEqual([]);
    expect(response).toMatchObject({
      report: {
        legacyBytes: null,
        usageComplete: false,
        turnOwnershipCounts: { missingState: 1, invalidState: 0, unsettledWithoutSession: 0 },
      },
    });
  },
);

it('bounds each inventory page and performs no maintenance before scanning every turn', async () => {
  const { root, requests } = await fixture();
  for (let i = 0; i < 260; i++) await turn(root, `settled-${i}`, 'idle', 'settled');
  const pending = await handleSupervisorRequest(root, 'runner', pagedRequest);
  expect(pending).toMatchObject({
    maintenancePending: true,
    cursor: '256',
    turnsNeedingOwnership: [],
  });
  expect(requests).toEqual([]);
  await expect(
    handleSupervisorRequest(root, 'runner', {
      ...pagedRequest,
      scanId: pending.scanId,
      turnOwners: [],
    }),
  ).resolves.toMatchObject({ ok: true, report: { usageComplete: true } });
  expect(requests).toHaveLength(1);
});

it('invalidates a scan when a new claim appears during ownership resolution', async () => {
  const { root, requests } = await fixture();
  await mkdir(join(root, 'turns', 'missing'), { recursive: true });
  const pending = await handleSupervisorRequest(root, 'runner', pagedRequest);
  await claimTurn(root, { turnId: 'new', startCommandId: 'start', sessionId: 'idle' }, 'runner');
  await expect(
    handleSupervisorRequest(root, 'runner', {
      ...pagedRequest,
      scanId: pending.scanId,
      turnOwners: [],
    }),
  ).rejects.toMatchObject({ runnerCacheFailure: { code: 'turn-inventory-unavailable' } });
  expect(requests).toEqual([]);
});

it('rejects ownership answers for a turn outside its bounded authenticated page', async () => {
  const { root, requests } = await fixture();
  await mkdir(join(root, 'turns', 'missing'), { recursive: true });
  const pending = await handleSupervisorRequest(root, 'runner', pagedRequest);
  await expect(
    handleSupervisorRequest(root, 'runner', {
      ...pagedRequest,
      scanId: pending.scanId,
      turnOwners: [{ turnId: 'another', sessionId: 'idle', conflict: false }],
    }),
  ).rejects.toThrow('invalid turn ownership response');
  expect(requests).toEqual([]);
});

it('holds new claim admission until the final broker maintenance finishes', async () => {
  let releaseMaintenance: (() => void) | undefined;
  let enteredMaintenance: (() => void) | undefined;
  const entered = new Promise<void>((resolve) => {
    enteredMaintenance = resolve;
  });
  const { root } = await fixture(undefined, {
    onMaintenance: (respond) => {
      releaseMaintenance = respond;
      enteredMaintenance!();
    },
  });
  const maintenance = handleSupervisorRequest(root, 'runner', pagedRequest);
  await entered;
  let claimed = false;
  const claim = claimTurn(
    root,
    { turnId: 'new', startCommandId: 'start', sessionId: 'idle' },
    'runner',
  ).then((result) => {
    claimed = true;
    return result;
  });
  try {
    const disposition = await Promise.race([
      claim.then(() => 'claimed'),
      new Promise<string>((resolve) => setTimeout(() => resolve('blocked'), 50)),
    ]);
    expect(disposition).toBe('blocked');
    expect(claimed).toBe(false);
    expect(await readTurnState(root, 'new')).toBeUndefined();
  } finally {
    releaseMaintenance!();
  }
  await expect(maintenance).resolves.toMatchObject({ ok: true });
  await expect(claim).resolves.toMatchObject({ outcome: 'created', state: { sessionId: 'idle' } });
});

it('does not mutate caches through an old broker lacking the runtime fence', async () => {
  const { root, requests } = await fixture(undefined, {
    capabilities: { runtimeAdmissionFenceVersion: 0 },
  });
  await expect(handleSupervisorRequest(root, 'runner', pagedRequest)).rejects.toMatchObject({
    runnerCacheFailure: { code: 'unsupported' },
  });
  expect(requests).toEqual([]);
});

it('keeps maximum-length legacy ownership pages within the control response limit', async () => {
  const { root, requests } = await fixture();
  for (let i = 0; i < 200; i++) {
    const turnId = `turn-${String(i).padStart(4, '0')}-${'t'.repeat(118)}`;
    await turn(root, turnId, 'idle', 'claimed');
    const path = join(root, 'turns', turnId, 'state.json');
    const state = JSON.parse(await readFile(path, 'utf8'));
    delete state.sessionId;
    state.startCommandId = 's'.repeat(128);
    state.runnerInstanceId = 'r'.repeat(128);
    await writeFile(path, JSON.stringify(state));
  }
  const pending = await handleSupervisorRequest(root, 'runner', pagedRequest);
  expect(pending.maintenancePending).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(pending))).toBeLessThan(64 * 1024);
  expect(requests).toEqual([]);
});
