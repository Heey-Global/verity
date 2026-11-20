import { describe, expect, it, vi } from 'vitest';
import { buildServer } from './server.js';
import {
  AVAILABLE_SANDBOX_UPDATE,
  bus,
  conductor,
  ctx,
  isBusy,
} from './server-fixture.test-helper.js';
import type { SandboxUpdateStatus } from './sandbox-updates.js';

describe('manual sandbox update authorization', () => {
  async function setup(id: string) {
    await ctx.store.upsertProject({
      id,
      owner: 'test',
      repo: id,
      containerName: id,
      state: 'active',
    });
    await ctx.store.createSession({
      sessionId: id,
      projectId: id,
      worktree: '/work',
      model: 'claude-opus-4-8',
    });
    const recreateContainer = vi.fn(async () => (await ctx.store.getProject(id))!);
    return { recreateContainer, provisioner: { provision: vi.fn(), recreateContainer } };
  }

  it('waits for acknowledged cancellation to settle before interrupting services', async () => {
    const id = 'manual-update';
    const { provisioner, recreateContainer } = await setup(id);
    let busy = true;
    isBusy.mockImplementation(() => busy);
    const cancelTurn = vi.fn(async () => {
      setTimeout(() => {
        busy = false;
      }, 75);
      return true;
    });
    const server = buildServer({
      eventStore: ctx.store,
      bus,
      conductor: { ...conductor, cancelTurn } as unknown as typeof conductor,
      provisioner,
    });
    try {
      const response = await server.inject({
        method: 'POST',
        url: `/verity-control/projects/${id}/recreate-container`,
        payload: { interruptServices: true, cancelTurns: true },
      });
      expect(response.statusCode).toBe(200);
      expect(cancelTurn).toHaveBeenCalledWith(id);
      expect(recreateContainer).toHaveBeenCalledWith(
        id,
        expect.objectContaining({ interruptServices: true }),
      );
    } finally {
      await server.close();
    }
  });

  it('refuses an acknowledged cancellation that never settles', async () => {
    const id = 'manual-unsettled-ack';
    const { provisioner, recreateContainer } = await setup(id);
    isBusy.mockReturnValue(true);
    const cancelTurn = vi.fn(async () => true);
    const server = buildServer({
      eventStore: ctx.store,
      bus,
      conductor: { ...conductor, cancelTurn } as unknown as typeof conductor,
      provisioner,
    });
    try {
      const response = await server.inject({
        method: 'POST',
        url: `/verity-control/projects/${id}/recreate-container`,
        payload: { interruptServices: true, cancelTurns: true },
      });
      expect(response.statusCode).toBe(409);
      expect(cancelTurn).toHaveBeenCalledWith(id);
      expect(recreateContainer).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  }, 15_000);

  it('refuses replacement when cancellation has not settled the turn', async () => {
    const id = 'manual-still-busy';
    const { provisioner, recreateContainer } = await setup(id);
    isBusy.mockReturnValue(true);
    const server = buildServer({ eventStore: ctx.store, bus, conductor, provisioner });
    try {
      const response = await server.inject({
        method: 'POST',
        url: `/verity-control/projects/${id}/recreate-container`,
        payload: { interruptServices: true, cancelTurns: true },
      });
      expect(response.statusCode).toBe(409);
      expect(recreateContainer).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });
});

it('reports overdue blockers immediately and does not reuse recovery from an older image', async () => {
  const id = 'durable-update-status';
  await ctx.store.upsertProject({
    id,
    owner: 'test',
    repo: id,
    containerName: id,
    state: 'active',
  });
  let exhausted = false;
  let status: SandboxUpdateStatus = { ...AVAILABLE_SANDBOX_UPDATE };
  let durable = {
    since: Date.now() - 25 * 60 * 60_000,
    reasons: ['dev_server'],
    reportedAt: Date.now(),
    recovery: {
      state: 'ready' as 'ready' | 'failed',
      at: 1,
      detail: 'Previous services recovered',
    },
  };
  const server = buildServer({
    eventStore: ctx.store,
    bus,
    conductor,
    sandboxUpdates: {
      status: async () => status,
      statusAll: async (projects) => new Map(projects.map((project) => [project.id, status])),
    },
    provisioner: {
      provision: vi.fn(),
      sandboxUpdateStates: () => new Map([[id, durable]]),
      unrepairedSandboxes: () => new Set(exhausted ? [id] : []),
    },
  });
  try {
    const response = await server.inject({ method: 'GET', url: `/projects/${id}` });
    const update = response.json<{ project: { sandboxUpdate: SandboxUpdateStatus } }>().project
      .sandboxUpdate;
    expect(update).toMatchObject({
      turnBlocked: true,
      blockedBy: ['dev_server'],
      scheduledTonight: true,
      overdue: true,
    });
    expect(update.recovery).toBeUndefined();
    exhausted = true;
    const stopped = (await server.inject({ method: 'GET', url: `/projects/${id}` })).json<{
      project: { sandboxUpdate: SandboxUpdateStatus };
    }>().project.sandboxUpdate;
    expect(stopped.scheduledTonight).toBeUndefined();
    expect(stopped.selfRepair).toBe('stalled');
    exhausted = false;
    durable = { ...durable, reasons: [] };
    status = { ...status, state: 'current' };
    const current = (await server.inject({ method: 'GET', url: `/projects/${id}` })).json<{
      project: { sandboxUpdate: SandboxUpdateStatus };
    }>().project.sandboxUpdate;
    expect(current.recovery).toEqual(durable.recovery);
    expect(current.overdue).toBeUndefined();
    durable.recovery = {
      state: 'failed',
      at: Date.now(),
      detail: 'Replacement failed after retiring old container',
    };
    for (const state of ['unknown', 'available'] as const) {
      status = { ...status, state };
      const failed = (await server.inject({ method: 'GET', url: `/projects/${id}` })).json<{
        project: { sandboxUpdate: SandboxUpdateStatus };
      }>().project.sandboxUpdate;
      expect(failed.recovery).toEqual(durable.recovery);
    }
  } finally {
    await server.close();
  }
});
