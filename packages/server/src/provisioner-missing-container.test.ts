import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { createTestDb, truncateAll, type TestDb } from '@verity/store/testing';
import type { ProjectState } from '@verity/store';
import { DockerError } from './docker.js';
import { CONTAINER_MISSING_REASON, MISSING_CONTAINER_REPAIR_GRACE_MS } from './project-state.js';
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
