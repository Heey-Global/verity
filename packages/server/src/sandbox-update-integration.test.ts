import { storageRefusedTurnRepair } from './sandbox-storage-retry.js';
import { withPreviewProjectMutation } from './preview-project-mutation.js';
import { PROJECT_IMAGE_REBUILDING_WARNING } from '@verity/events';
import type { ProvisionerOptions } from './provisioner.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, truncateAll, type TestDb } from '@verity/store/testing';
import type { ProjectRecord } from '@verity/store';
import { BuildStorage } from './build-storage.js';
import { createProvisioner, fakeDocker, fakeGit } from './provisioner.test-helper.js';
import type { ProjectActivityReason } from './project-idle-sleep.js';
import { CONTAINER_GENERATION_LABEL, PROJECT_ID_LABEL } from './project-relay-migration.js';

let ctx: TestDb;
beforeAll(async () => {
  ctx = await createTestDb();
});
afterAll(async () => {
  await ctx.close();
});
beforeEach(async () => {
  vi.restoreAllMocks();
  await truncateAll(ctx.db);
});

type Internals = {
  classifyProjectSandbox: (
    project: ProjectRecord,
  ) => Promise<{ classification: 'migrated'; envDriftOnly: boolean }>;
  devcontainerWarningForProject: () => Promise<null>;
  resolveOrBuildImage: () => Promise<{ imageRef: string; usesDevcontainerImage: boolean }>;
  resolveRelayClaudeGateway: () => void;
  ensureSandboxRuntime: () => Promise<void>;
  runContainerPhase: () => Promise<ProjectRecord>;
};
async function fixture(hour = 3, minute = 0, extra: Partial<ProvisionerOptions> = {}) {
  let now = new Date(2026, 10, 16, hour, minute).getTime();
  const project = await ctx.store.upsertProject({
    id: 'p',
    owner: 'example',
    repo: 'site',
    containerName: 'dev-p',
    state: 'active',
  });
  const { client, calls } = fakeDocker({
    inspectContainer: vi.fn(async () => ({
      id: 'old',
      running: true,
      labels: { [PROJECT_ID_LABEL]: 'p', [CONTAINER_GENERATION_LABEL]: 'generation-1' },
    })),
  });
  const provisioner = createProvisioner({
    store: ctx.store,
    db: ctx.db,
    docker: client,
    git: fakeGit([]).runner,
    projectTokenMint: async () => 'token',
    defaultImageRef: 'target',
    hostCloneRoot: '/work/fixture',
    isDirectory: () => false,
    now: () => now,
    ...extra,
  });
  const internals = provisioner as unknown as Internals;
  vi.spyOn(internals, 'classifyProjectSandbox').mockResolvedValue({
    classification: 'migrated',
    envDriftOnly: false,
  });
  vi.spyOn(internals, 'devcontainerWarningForProject').mockResolvedValue(null);
  vi.spyOn(internals, 'resolveOrBuildImage').mockResolvedValue({
    imageRef: 'target',
    usesDevcontainerImage: false,
  });
  vi.spyOn(internals, 'resolveRelayClaudeGateway').mockImplementation(() => undefined);
  vi.spyOn(internals, 'ensureSandboxRuntime').mockResolvedValue(undefined);
  vi.spyOn(internals, 'runContainerPhase').mockResolvedValue(project);
  return {
    project,
    provisioner,
    internals,
    client,
    calls,
    setTime: (hour: number, minute = 0) => {
      now = new Date(2026, 10, 16, hour, minute).getTime();
    },
  };
}

describe('sandbox image update arbitration', () => {
  it.each([
    [2, 59, false],
    [3, 0, true],
    [4, 59, true],
    [5, 0, false],
  ])('dispatches at local %i:%i only within window', async (hour, minute, expected) => {
    const f = await fixture(hour, minute);
    f.provisioner.attachProjectBusyProbe(async () => ['dev_server', 'preview']);
    const recreate = vi.spyOn(f.provisioner, 'recreateContainer').mockResolvedValue(f.project);
    await f.provisioner.reconcileRelays([f.project], { updateAvailable: new Set(['p']) });
    expect(recreate.mock.calls.length).toBe(expected ? 1 : 0);
    if (expected)
      expect(recreate).toHaveBeenCalledWith(
        'p',
        expect.objectContaining({ interruptServices: true }),
      );
  });

  it.each(['turn', 'unknown'] as const)(
    'keeps old container when final activity changes to %s',
    async (reason) => {
      const f = await fixture();
      let reasons: ProjectActivityReason[] = ['dev_server'];
      f.provisioner.attachProjectBusyProbe(async () => reasons);
      vi.spyOn(f.internals, 'resolveOrBuildImage').mockImplementation(async () => {
        reasons = [reason];
        return { imageRef: 'target', usesDevcontainerImage: false };
      });
      await expect(
        f.provisioner.recreateContainer('p', {
          interruptServices: true,
          initiator: { kind: 'system', trigger: 'sandbox_reconcile' },
        }),
      ).rejects.toThrow('busy');
      expect(
        f.calls.filter(
          (call) => call.method === 'stopContainer' || call.method === 'removeContainer',
        ),
      ).toEqual([]);
    },
  );

  it('keeps old container when preparation finishes after the window closes', async () => {
    const f = await fixture(4, 59);
    f.provisioner.attachProjectBusyProbe(async () => ['preview']);
    vi.spyOn(f.internals, 'resolveOrBuildImage').mockImplementation(async () => {
      f.setTime(5);
      return { imageRef: 'target', usesDevcontainerImage: false };
    });
    await expect(
      f.provisioner.recreateContainer('p', {
        interruptServices: true,
        initiator: { kind: 'system', trigger: 'sandbox_reconcile' },
      }),
    ).rejects.toThrow('busy');
    expect(
      f.calls.filter(
        (call) => call.method === 'stopContainer' || call.method === 'removeContainer',
      ),
    ).toEqual([]);
  });

  it('allows an explicitly requested daytime service interruption', async () => {
    const f = await fixture(12);
    f.provisioner.attachProjectBusyProbe(async () => ['preview']);
    await f.provisioner.recreateContainer('p', {
      interruptServices: true,
      initiator: { kind: 'user', userId: 'person' },
    });
    expect(f.calls.some((call) => call.method === 'removeContainer')).toBe(true);
  });
});

it('persists turn repair storage refusal and skips another build until its backoff expires', async () => {
  const f = await fixture(12);
  f.provisioner.attachProjectBusyProbe(async () => []);
  const root = mkdtempSync(join(tmpdir(), 'turn-capacity-'));
  try {
    const storage = new BuildStorage(
      join(root, 'owned'),
      join(root, 'storage.json'),
      { estimateBytes: 8 * 1024 ** 3, reserveBytes: 2 * 1024 ** 3, reserveInodes: 1 },
      () => ({ availableBytes: 0, freeInodes: 1_000_000 }),
    );
    let refusal: unknown;
    try {
      storage.admit().dispose();
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(Error);
    const recreate = vi
      .spyOn(f.provisioner, 'recreateContainer')
      .mockRejectedValue(new Error('replacement image preparation failed', { cause: refusal }));
    await expect(
      f.provisioner.repairSandboxForTurn('p', 'session', undefined, {
        requireFreshAgentGatewayIdentity: true,
      }),
    ).resolves.toBe(true);
    expect((await ctx.store.sandboxRepairIntents.list())[0]).toMatchObject({
      storageRefused: true,
      status: 'waiting',
      sourceGeneration: 'generation-1',
    });
    const intent = (await ctx.store.sandboxRepairIntents.list())[0];
    await f.provisioner.reconcileRelays([f.project], { updateAvailable: new Set() });
    expect((await ctx.store.sandboxRepairIntents.list())[0]).toEqual(intent);
    await expect(
      f.provisioner.repairSandboxForTurn('p', 'session', undefined, {
        requireFreshAgentGatewayIdentity: true,
      }),
    ).resolves.toBe(true);
    expect(recreate).toHaveBeenCalledTimes(1);
    // A restarted reconciler must retain the owed identity refresh too.
    const restored = await fixture(12);
    restored.provisioner.attachProjectBusyProbe(async () => []);
    const restoredRecreate = vi.spyOn(restored.provisioner, 'recreateContainer');
    await restored.provisioner.reconcileRelays([restored.project], { updateAvailable: new Set() });
    expect((await ctx.store.sandboxRepairIntents.list())[0]).toEqual(intent);
    await restored.provisioner.repairSandboxForTurn('p', 'session', undefined, {
      requireFreshAgentGatewayIdentity: true,
    });
    expect(restoredRecreate).not.toHaveBeenCalled();
    f.setTime(12, 1);
    await f.provisioner.repairSandboxForTurn('p', 'session', undefined, {
      requireFreshAgentGatewayIdentity: true,
    });
    expect(recreate).toHaveBeenCalledTimes(2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('persists recovery before retiring the old generation and records a failed replacement', async () => {
  const check = vi.fn(async () => ({ state: 'ready' as const, detail: 'ready' }));
  const f = await fixture(12, 0, { sandboxUpdateRecovery: { capture: async () => check } });
  f.provisioner.attachProjectBusyProbe(async () => []);
  let persistedBeforeStop = false;
  vi.spyOn(f.client, 'stopContainer').mockImplementation(async () => {
    persistedBeforeStop =
      (await ctx.store.sandboxUpdateState.list()).get('p')?.recovery?.state === 'checking';
  });
  vi.spyOn(f.internals, 'runContainerPhase').mockRejectedValue(new Error('replacement failed'));
  await expect(f.provisioner.recreateContainer('p')).rejects.toThrow('replacement failed');
  expect(persistedBeforeStop).toBe(true);
  expect((await ctx.store.sandboxUpdateState.list()).get('p')?.recovery?.state).toBe('failed');
  expect(check).not.toHaveBeenCalled();
});

it('restores the previous project status when recovery capture fails after a forced image rebuild', async () => {
  const capture = vi.fn(async () => {
    expect((await ctx.store.getProject('p'))?.provisionWarning).toBe(
      PROJECT_IMAGE_REBUILDING_WARNING,
    );
    throw new Error('recovery capture timed out');
  });
  const f = await fixture(12, 0, { sandboxUpdateRecovery: { capture } });
  await ctx.store.updateProjectState('p', 'active', null, 'Previous warning');
  f.provisioner.attachProjectBusyProbe(async () => []);
  await expect(f.provisioner.recreateContainer('p', { forceRebuild: true })).rejects.toThrow(
    'recovery capture timed out',
  );
  expect(capture).toHaveBeenCalledExactlyOnceWith('p');
  expect(f.internals.resolveOrBuildImage).toHaveBeenCalledWith(
    expect.anything(),
    expect.anything(),
    true,
    undefined,
  );
  expect(await ctx.store.getProject('p')).toMatchObject({
    state: 'active',
    provisionError: null,
    provisionWarning: 'Previous warning',
  });
  expect(f.internals.runContainerPhase).not.toHaveBeenCalled();
  expect(
    f.calls.some((call) => call.method === 'stopContainer' || call.method === 'removeContainer'),
  ).toBe(false);
  expect(f.provisioner.isProjectProvisioning('p')).toBe(false);
});

it('keeps the durable waiting clock through failed update discovery until a confirmed empty result', async () => {
  const f = await fixture(12);
  f.provisioner.attachProjectBusyProbe(async () => ['dev_server']);
  const recreate = vi.spyOn(f.provisioner, 'recreateContainer').mockResolvedValue(f.project);
  await f.provisioner.reconcileRelays([f.project], { updateAvailable: new Set(['p']) });
  const initial = (await ctx.store.sandboxUpdateState.list()).get('p');
  expect(initial?.reasons).toEqual(['dev_server']);
  await f.provisioner.reconcileRelays([f.project], {});
  expect((await ctx.store.sandboxUpdateState.list()).get('p')).toEqual(initial);
  expect(f.provisioner.sandboxUpdateStates().get('p')).toEqual(initial);
  await f.provisioner.reconcileRelays([f.project], { updateAvailable: new Set() });
  expect((await ctx.store.sandboxUpdateState.list()).has('p')).toBe(false);
  expect(f.provisioner.sandboxUpdateStates().has('p')).toBe(false);
  expect(recreate).not.toHaveBeenCalled();
});

it('keeps an offered update wait through repeated classification failures until discovery clears it', async () => {
  const f = await fixture(12);
  f.provisioner.attachProjectBusyProbe(async () => ['dev_server']);
  await f.provisioner.reconcileRelays([f.project], { updateAvailable: new Set(['p']) });
  const initial = (await ctx.store.sandboxUpdateState.list()).get('p');
  expect(initial?.reasons).toEqual(['dev_server']);
  vi.mocked(f.internals.classifyProjectSandbox).mockRejectedValue(new Error('inspect failed'));
  for (let attempt = 0; attempt < 2; attempt++) {
    await expect(
      f.provisioner.reconcileRelays([f.project], { updateAvailable: new Set(['p']) }),
    ).rejects.toThrow();
    expect((await ctx.store.sandboxUpdateState.list()).get('p')).toEqual(initial);
    expect(f.provisioner.sandboxUpdateStates().get('p')).toEqual(initial);
  }
  await expect(
    f.provisioner.reconcileRelays([f.project], { updateAvailable: new Set() }),
  ).rejects.toThrow();
  expect((await ctx.store.sandboxUpdateState.list()).has('p')).toBe(false);
  expect(f.provisioner.sandboxUpdateStates().has('p')).toBe(false);
});

it.each(['sleeping', 'absent'] as const)(
  'clears a wait when lifecycle becomes %s despite failed update discovery',
  async (state) => {
    const f = await fixture(12);
    f.provisioner.attachProjectBusyProbe(async () => ['preview']);
    await f.provisioner.reconcileRelays([f.project], { updateAvailable: new Set(['p']) });
    expect((await ctx.store.sandboxUpdateState.list()).has('p')).toBe(true);
    await ctx.store.updateProjectState('p', state);
    await f.provisioner.reconcileRelays([{ ...f.project, state }], {});
    expect((await ctx.store.sandboxUpdateState.list()).has('p')).toBe(false);
  },
);

it('prepares outside the mutation fence, captures before retirement and checks after release', async () => {
  const events: string[] = [];
  const f = await fixture(12, 0, {
    sandboxUpdateRecovery: {
      prepare: async () => {
        events.push('prepare');
      },
      capture: async () => {
        expect(events).toEqual(['prepare', 'fenced']);
        events.push('capture');
        return async () => {
          expect(events).toEqual(['prepare', 'fenced', 'capture', 'retire', 'released']);
          return { state: 'ready', detail: 'ready' };
        };
      },
    },
    withContainerReplace: async (_project, replace, beforeRetire) => {
      events.push('fenced');
      try {
        await beforeRetire?.();
        events.push('retire');
        return await replace();
      } finally {
        events.push('released');
      }
    },
  });
  f.provisioner.attachProjectBusyProbe(async () => []);
  await f.provisioner.recreateContainer('p');
  expect((await ctx.store.sandboxUpdateState.list()).get('p')?.recovery?.state).toBe('ready');
});

it.each([false, true])(
  'refuses a legacy replacement hook without preflight (recovery: %s)',
  async (recovery) => {
    const capture = vi.fn(async () => async () => ({ state: 'ready' as const, detail: 'ready' }));
    const f = await fixture(12, 0, {
      ...(recovery ? { sandboxUpdateRecovery: { capture } } : {}),
      withContainerReplace: async (_project, replace) => replace(),
    });
    f.provisioner.attachProjectBusyProbe(async () => []);
    await expect(f.provisioner.recreateContainer('p')).rejects.toThrow(
      'Replacement requires service capture and preflight',
    );
    expect(capture).not.toHaveBeenCalled();
    expect(
      f.calls.some((call) => call.method === 'stopContainer' || call.method === 'removeContainer'),
    ).toBe(false);
  },
);

it.each(['turn', 'unknown', 'window'] as const)(
  'refuses late %s before the actual preview mutation hook retires either connector set',
  async (change) => {
    let reasons: ProjectActivityReason[] = ['preview'];
    const retireLocal = vi.fn(async () => {
      reasons = [];
    });
    const retirePublic = vi.fn(async () => {
      reasons = [];
    });
    const releaseLocal = vi.fn();
    const releasePublic = vi.fn();
    const f = await fixture(4, 59, {
      sandboxUpdateRecovery: {
        capture: async () => {
          if (change === 'window') f.setTime(5);
          else reasons = [change];
          return async () => ({ state: 'ready', detail: 'ready' });
        },
      },
      withContainerReplace: (project, replace, beforeRetire) =>
        withPreviewProjectMutation(
          project.id,
          replace,
          {
            local: { beginSessionMove: async () => releaseLocal, retireProjectShares: retireLocal },
            public: {
              beginSessionMove: async () => releasePublic,
              retireProjectShares: retirePublic,
            },
          },
          beforeRetire,
        ),
    });
    f.provisioner.attachProjectBusyProbe(async () => reasons);
    await expect(
      f.provisioner.recreateContainer('p', {
        interruptServices: true,
        initiator: { kind: 'system', trigger: 'sandbox_reconcile' },
      }),
    ).rejects.toThrow('busy');
    expect(retireLocal).not.toHaveBeenCalled();
    expect(retirePublic).not.toHaveBeenCalled();
    expect(releaseLocal).toHaveBeenCalledOnce();
    expect(releasePublic).toHaveBeenCalledOnce();
    expect(
      f.calls.some((call) => call.method === 'stopContainer' || call.method === 'removeContainer'),
    ).toBe(false);
  },
);

it.each(['local', 'public'] as const)(
  'journals recovery before %s retirement and persists its failure',
  async (failing) => {
    const check = vi.fn(async () => ({ state: 'ready' as const, detail: 'ready' }));
    const retire = async (kind: 'local' | 'public') => {
      expect((await ctx.store.sandboxUpdateState.list()).get('p')?.recovery?.state).toBe(
        'checking',
      );
      if (kind === failing) throw new Error(`${kind} connector retirement failed`);
    };
    const f = await fixture(3, 0, {
      sandboxUpdateRecovery: { capture: async () => check },
      withContainerReplace: (project, replace, beforeRetire) =>
        withPreviewProjectMutation(
          project.id,
          replace,
          {
            local: {
              beginSessionMove: async () => () => {},
              retireProjectShares: () => retire('local'),
            },
            public: {
              beginSessionMove: async () => () => {},
              retireProjectShares: () => retire('public'),
            },
          },
          beforeRetire,
        ),
    });
    f.provisioner.attachProjectBusyProbe(async () => ['preview']);
    await expect(
      f.provisioner.recreateContainer('p', {
        interruptServices: true,
        initiator: { kind: 'system', trigger: 'sandbox_reconcile' },
      }),
    ).rejects.toThrow(`${failing} connector retirement failed`);
    expect((await ctx.store.sandboxUpdateState.list()).get('p')?.recovery).toMatchObject({
      state: 'failed',
      detail: expect.stringContaining(`${failing} connector retirement failed`),
    });
    expect(check).not.toHaveBeenCalled();
    expect(
      f.calls.some((call) => call.method === 'stopContainer' || call.method === 'removeContainer'),
    ).toBe(false);
  },
);

it.each(['turn', 'window'] as const)(
  'restores the original wait when %s changes during recovery persistence',
  async (change) => {
    let reasons: ProjectActivityReason[] = ['preview'];
    const retire = vi.fn(async () => {});
    const f = await fixture(4, 59, {
      sandboxUpdateRecovery: {
        capture: async () => async () => ({ state: 'ready', detail: 'ready' }),
      },
      withContainerReplace: (project, replace, beforeRetire) =>
        withPreviewProjectMutation(
          project.id,
          replace,
          {
            local: { beginSessionMove: async () => () => {}, retireProjectShares: retire },
            public: { beginSessionMove: async () => () => {}, retireProjectShares: retire },
          },
          beforeRetire,
        ),
    });
    f.provisioner.attachProjectBusyProbe(async () => reasons);
    const initial = { since: Date.now() - 25 * 60 * 60_000, reasons: ['preview'], reportedAt: 1 };
    await ctx.store.sandboxUpdateState.set('p', initial);
    const set = ctx.store.sandboxUpdateState.set.bind(ctx.store.sandboxUpdateState);
    vi.spyOn(ctx.store.sandboxUpdateState, 'set').mockImplementation(async (id, state) => {
      await set(id, state);
      if (state.recovery?.state === 'checking') {
        if (change === 'turn') reasons = ['turn'];
        else f.setTime(5);
      }
    });
    await expect(
      f.provisioner.recreateContainer('p', {
        interruptServices: true,
        initiator: { kind: 'system', trigger: 'sandbox_reconcile' },
      }),
    ).rejects.toThrow('busy');
    expect(retire).not.toHaveBeenCalled();
    expect((await ctx.store.sandboxUpdateState.list()).get('p')).toEqual(initial);
    expect(f.provisioner.sandboxUpdateStates().get('p')).toEqual(initial);
    expect(
      f.calls.some((call) => call.method === 'stopContainer' || call.method === 'removeContainer'),
    ).toBe(false);
  },
);

it('retains the owed turn repair through retry preparation and restart without an image update', async () => {
  const f = await fixture(12);
  f.provisioner.attachProjectBusyProbe(async () => []);
  const intent = storageRefusedTurnRepair({
    projectId: 'p',
    sourceGeneration: 'generation-1',
    targetImageRef: 'target',
    failures: 1,
    now: new Date(2026, 10, 16, 11).getTime(),
    error: 'capacity',
  });
  await ctx.store.sandboxRepairIntents.record(intent);
  vi.spyOn(f.internals, 'resolveOrBuildImage').mockImplementationOnce(async () => {
    expect((await ctx.store.sandboxRepairIntents.list())[0]).toEqual(intent);
    throw new Error('Server stopped during preparation');
  });
  await expect(
    f.provisioner.repairSandboxForTurn('p', 'session', undefined, {
      requireFreshAgentGatewayIdentity: true,
    }),
  ).rejects.toThrow('Server stopped during preparation');
  expect((await ctx.store.sandboxRepairIntents.list())[0]).toEqual(intent);
  const restarted = await fixture(12);
  restarted.provisioner.attachProjectBusyProbe(async () => []);
  await restarted.provisioner.reconcileRelays([restarted.project], { updateAvailable: new Set() });
  expect(restarted.internals.runContainerPhase).toHaveBeenCalledOnce();
  expect(await ctx.store.sandboxRepairIntents.list()).toEqual([]);
});
