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
    await expect(
      f.provisioner.repairSandboxForTurn('p', 'session', undefined, {
        requireFreshAgentGatewayIdentity: true,
      }),
    ).resolves.toBe(true);
    expect(recreate).toHaveBeenCalledTimes(1);
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
