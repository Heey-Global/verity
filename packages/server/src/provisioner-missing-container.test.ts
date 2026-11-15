import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { createTestDb, truncateAll, type TestDb } from '@verity/store/testing';
import type { ProjectState } from '@verity/store';
import { DockerError } from './docker.js';
import { SANDBOX_REPAIR_RETRY_MAX_MS } from './project-relay-migration.js';
import { CONTAINER_MISSING_REASON } from './project-state.js';
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

function provisionerWithoutContainer() {
  const { client } = fakeDocker({
    inspectContainer: vi.fn(async (name: string) => {
      throw new DockerError({ kind: 'container_not_found', id: name });
    }),
  });
  let clock = 0;
  const provisioner = createProvisioner({
    now: () => (clock += SANDBOX_REPAIR_RETRY_MAX_MS + 1),
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

it.each([
  ['an active project before the state poll noticed', 'active', null],
  ['a project the state poll already marked failed', 'failed', CONTAINER_MISSING_REASON],
] as const)('recreates the vanished container of %s', async (_, state, reason) => {
  const project = await seed(state, reason);
  const provisioner = provisionerWithoutContainer();
  const recreate = vi.spyOn(provisioner, 'recreateContainer').mockResolvedValue(project);
  await provisioner.reconcileRelays([project]);
  expect(recreate).toHaveBeenCalledWith('p', expect.objectContaining({ confirmWarnings: true }));
});

it('leaves a project that failed for another reason to its manual Repair', async () => {
  const project = await seed('failed', 'clone failed');
  const provisioner = provisionerWithoutContainer();
  const recreate = vi.spyOn(provisioner, 'recreateContainer').mockResolvedValue(project);
  await provisioner.reconcileRelays([project]);
  expect(recreate).not.toHaveBeenCalled();
});
