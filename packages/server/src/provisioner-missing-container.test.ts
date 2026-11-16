import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { createTestDb, truncateAll, type TestDb } from '@verity/store/testing';
import type { ProjectState } from '@verity/store';
import { DeprovisionerImpl } from './deprovisioner.js';
import { DockerError } from './docker.js';
import { SANDBOX_REPAIR_RETRY_MIN_MS } from './project-relay-migration.js';
import {
  CONTAINER_MISSING_REASON,
  MISSING_CONTAINER_REPAIR_GRACE_MS,
  PROJECT_TEARDOWN_REASON,
  reconcileProjectContainerStates,
} from './project-state.js';
import {
  createProvisioner,
  defaultProjectRelay,
  fakeDocker,
  fakeGit,
} from './provisioner.test-helper.js';

// A Sandbox container removed outside Verity — a host cleanup, a manual `docker rm` —
// left its project without a container and nothing that would recreate it.

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

async function seed(state: ProjectState, provisionError: string | null = null) {
  await ctx.store.upsertProject({
    id: 'p',
    owner: 'example-org',
    repo: 'example-repo',
    containerName: 'dev-missing',
    state,
  });
  return (await ctx.store.updateProjectState('p', state, provisionError))!;
}

function provisionerWithoutContainer(elapsed = MISSING_CONTAINER_REPAIR_GRACE_MS + 1) {
  const { client } = fakeDocker({
    inspectContainer: vi.fn(async (name: string) => {
      throw new DockerError({ kind: 'container_not_found', id: name });
    }),
  });
  const provisioner = createProvisioner({
    now: () => Date.now() + elapsed,
    store: ctx.store,
    db: ctx.db,
    docker: client,
    git: fakeGit([]).runner,
    projectTokenMint: async () => 'tok',
    defaultImageRef: 'default',
    hostCloneRoot: '/srv/verity/workspaces',
    isDirectory: () => false,
    projectRelay: defaultProjectRelay(),
  });
  provisioner.attachProjectBusyProbe(async () => false);
  return provisioner;
}

it('recreates a vanished container once the missing mark outlasts any teardown', async () => {
  const project = await seed('failed', CONTAINER_MISSING_REASON);
  const provisioner = provisionerWithoutContainer();
  const recreate = vi.spyOn(provisioner, 'recreateContainer').mockResolvedValue(project);
  await provisioner.reconcileRelays([project]);
  expect(recreate).toHaveBeenCalledWith('p', expect.objectContaining({ confirmWarnings: true }));
});

it.each([
  // A deprovision removes the container before its row becomes `absent`.
  ['an active project, which may be mid-deprovision', 'active', null, undefined],
  ['a fresh missing mark', 'failed', CONTAINER_MISSING_REASON, 0],
  ['a failure with another cause, left to its manual Repair', 'failed', 'clone failed', undefined],
] as const)('leaves %s alone', async (_, state, reason, elapsed) => {
  const project = await seed(state, reason);
  const provisioner = provisionerWithoutContainer(elapsed);
  const recreate = vi.spyOn(provisioner, 'recreateContainer').mockResolvedValue(project);
  await provisioner.reconcileRelays([project]);
  expect(recreate).not.toHaveBeenCalled();
});

it('persists a failed missing-container repair and waits for its retry deadline', async () => {
  const project = await seed('failed', CONTAINER_MISSING_REASON);
  const now = Date.now() + MISSING_CONTAINER_REPAIR_GRACE_MS + 1;
  const time = vi.spyOn(Date, 'now').mockReturnValue(now);
  try {
    const provisioner = provisionerWithoutContainer(0);
    const recreate = vi
      .spyOn(provisioner, 'recreateContainer')
      .mockRejectedValue(new Error('create failed'));
    await expect(provisioner.reconcileRelays([project])).rejects.toThrow('Relay migration failed');
    const [intent] = await ctx.store.sandboxRepairIntents.list();
    expect(intent).toMatchObject({ projectId: 'p', status: 'waiting', failures: 1 });
    expect(intent!.retryAt.getTime()).toBe(now + SANDBOX_REPAIR_RETRY_MIN_MS);
    // An unchanged missing reason must not admit a second recreate before its backoff.
    await provisioner.reconcileRelays([project]);
    expect(recreate).toHaveBeenCalledTimes(1);
    time.mockReturnValue(intent!.retryAt.getTime());
    await expect(provisioner.reconcileRelays([project])).rejects.toThrow('Relay migration failed');
    expect(recreate).toHaveBeenCalledTimes(2);
  } finally {
    time.mockRestore();
  }
});

it('preserves teardown intent after a revocation failure instead of recreating the container', async () => {
  await seed('active');
  const { client } = fakeDocker();
  const revokeProject = vi.fn(async () => {
    throw new Error('revocation unavailable');
  });
  const deprovisioner = new DeprovisionerImpl(
    ctx.store,
    ctx.db,
    client,
    '/unused',
    () => false,
    undefined,
    { revokeProject } as unknown as ConstructorParameters<typeof DeprovisionerImpl>[6],
  );
  await expect(deprovisioner.deprovision('p', { purge: false })).rejects.toThrow(
    'credential revocation failed',
  );
  const project = (await ctx.store.getProject('p'))!;
  expect(project).toMatchObject({ state: 'failed', provisionError: PROJECT_TEARDOWN_REASON });
  // Docker's running/absent observations must not erase an interrupted deletion, even after restart.
  const updateState = vi.fn(ctx.store.updateProjectState.bind(ctx.store));
  await reconcileProjectContainerStates([project], client, updateState);
  expect(updateState).not.toHaveBeenCalled();
  const provisioner = provisionerWithoutContainer(MISSING_CONTAINER_REPAIR_GRACE_MS * 10);
  const recreate = vi.spyOn(provisioner, 'recreateContainer').mockResolvedValue(project);
  await provisioner.reconcileRelays([project]);
  expect(recreate).not.toHaveBeenCalled();
});
