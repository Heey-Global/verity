import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { createTestDb, truncateAll, type TestDb } from '@verity/store/testing';
import type { Conductor } from '@verity/session';
import Fastify from 'fastify';
import { createGatewaySessionCoordination } from './session-coordination-runtime.js';
import type { SpawnSession } from './session-create-route.js';

let ctx: TestDb;
const app = Fastify();
beforeAll(async () => {
  ctx = await createTestDb();
});
afterAll(async () => {
  await app.close();
  await ctx.close();
});
beforeEach(async () => {
  await truncateAll(ctx.db);
});

async function setup() {
  const store = ctx.store;
  for (const id of ['source-project', 'verity-control'])
    await store.createProject({
      id,
      owner: id === 'verity-control' ? 'verity' : '__local__',
      repo: id === 'verity-control' ? 'control' : 'source',
      kind: id === 'verity-control' ? 'control_plane' : 'local',
      state: 'active',
      containerName: id,
    });
  await store.createSession({
    sessionId: 'source',
    projectId: 'source-project',
    worktree: '/source',
    model: 'test',
  });
  const prompt = await store.appendEvent('source', {
    t: 'prompt',
    text: 'Start a Control session and hand over this investigation',
  });
  await store.markTurnRunning({ sessionId: 'source', promptSeq: prompt.seq });
  await store.bindTurnIdentity('source', { turnId: 'turn', startCommandId: 'command' });
  const dispatchTurn = vi.fn(async () => ({ queued: true }));
  const spawn = vi.fn<SpawnSession>(async (body, _log, userId) => {
    expect(userId).toBe('human');
    expect(body.project).toBe('verity/control');
    await store.createSession({
      sessionId: body.sessionId!,
      projectId: 'verity-control',
      worktree: '/control',
      model: 'test',
    });
    return { statusCode: 201, result: { sessionId: body.sessionId! } };
  });
  const deps = {
    store,
    app,
    conductor: {
      dispatchTurn,
      isBusy: () => true,
      isPlanningTurn: () => false,
    } as unknown as Conductor,
    spawn: () => spawn,
    authorized: async () => true,
    initiator: async () => ({ userId: 'human' }),
  };
  const caller = {
    projectId: 'source-project',
    sessionId: 'source',
    turnId: 'turn',
    approvedByCard: true,
    request: {
      operation: 'start',
      requestId: 'handover',
      targetProjectId: 'verity-control',
      name: 'Investigate',
      message: 'Investigate the failure and report evidence.',
    },
  };
  return {
    store,
    deps,
    caller,
    spawn,
    dispatchTurn,
    gateway: createGatewaySessionCoordination(deps),
  };
}

it('creates and links Control once, preserving peer provenance and durable queued result across runtime restart', async () => {
  const h = await setup();
  const result = await h.gateway.execute(h.caller);
  expect(result).toMatchObject({
    created: true,
    linked: true,
    delivery: { status: 'queued', queued: true },
  });
  expect(h.spawn).toHaveBeenCalledTimes(1);
  const dispatch = h.dispatchTurn.mock.calls[0] as unknown as [
    string,
    string,
    unknown,
    { peer: { sessionId: string; message: string }; initiatedBy: { userId: string } },
  ];
  expect(dispatch[1]).toContain('untrusted peer input');
  expect(dispatch[3].peer).toMatchObject({
    sessionId: 'source',
    message: h.caller.request.message,
  });
  expect(dispatch[3].initiatedBy).toEqual({ userId: 'human' });
  expect(await createGatewaySessionCoordination(h.deps).execute(h.caller)).toEqual(result);
  expect(h.spawn).toHaveBeenCalledTimes(1);
  expect(h.dispatchTurn).toHaveBeenCalledTimes(1);
  const links = await h.store.listSessionLinks('source');
  expect(links).toHaveLength(1);
  await h.store.deleteSessionLink('source', links[0]!.peerSessionId);
  await expect(h.gateway.execute(h.caller)).rejects.toThrow('revoked');
  expect(await h.store.listSessionLinks('source')).toHaveLength(0);
});

it('uses exact coordination approval for an exhausted allowance without a second delivery identity', async () => {
  const h = await setup();
  await h.gateway.execute(h.caller);
  const targetSessionId = (await h.store.listSessionLinks('source'))[0]!.peerSessionId;
  for (let i = 0; i < 5; i++)
    await h.store.reserveSessionLinkMessage(
      'source',
      targetSessionId,
      `consume-${i}`,
      false,
      async () => {},
    );
  expect(await h.store.sessionLinkHasAllowance('source', targetSessionId)).toBe(false);
  const caller = {
    ...h.caller,
    request: {
      operation: 'link',
      requestId: 'followup',
      targetProjectId: 'verity-control',
      targetSessionId,
      message: 'Report the current evidence.',
    },
  };
  expect(await h.gateway.presentation(caller)).toMatchObject({
    targetProject: { name: 'control' },
    targetSession: { id: targetSessionId },
  });
  expect(await h.gateway.execute(caller)).toMatchObject({ delivery: { status: 'queued' } });
  expect(h.dispatchTurn).toHaveBeenCalledTimes(2);
  expect(await h.store.sessionLinkHasAllowance('source', targetSessionId)).toBe(true);
  await createGatewaySessionCoordination(h.deps).execute(caller);
  expect(h.dispatchTurn).toHaveBeenCalledTimes(2);
});

it('does not restore a revoked link after its committed creation response is lost', async () => {
  const h = await setup();
  const createLink = h.store.createSessionLink.bind(h.store);
  const lostReply = vi
    .spyOn(h.store, 'createSessionLink')
    .mockImplementationOnce(async (...args) => {
      await createLink(...args);
      throw new Error('link response lost');
    });
  try {
    await expect(h.gateway.execute(h.caller)).rejects.toThrow('link response lost');
  } finally {
    lostReply.mockRestore();
  }
  const links = await h.store.listSessionLinks('source');
  expect(links).toHaveLength(1);
  await h.store.deleteSessionLink('source', links[0]!.peerSessionId);
  await expect(createGatewaySessionCoordination(h.deps).execute(h.caller)).rejects.toThrow(
    'revoked',
  );
  expect(await h.store.listSessionLinks('source')).toEqual([]);
  expect(h.dispatchTurn).not.toHaveBeenCalled();
});

it('reports unknown queue state after delivery succeeds but receipt persistence fails', async () => {
  const h = await setup();
  const update = h.store.sessionCoordination.update.bind(h.store.sessionCoordination);
  const failure = vi
    .spyOn(h.store.sessionCoordination, 'update')
    .mockImplementation(async (...args) => {
      if (args[2].phase === 'delivered') throw new Error('receipt write failed');
      await update(...args);
    });
  try {
    await expect(h.gateway.execute(h.caller)).rejects.toThrow('receipt write failed');
  } finally {
    failure.mockRestore();
  }
  expect(h.dispatchTurn).toHaveBeenCalledTimes(1);
  const result = await createGatewaySessionCoordination(h.deps).execute(h.caller);
  expect(result).toMatchObject({ delivery: { status: 'accepted', queued: null } });
  expect(h.dispatchTurn).toHaveBeenCalledTimes(1);
  expect(await createGatewaySessionCoordination(h.deps).execute(h.caller)).toEqual(result);
});
