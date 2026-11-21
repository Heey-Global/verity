import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, truncateAll, type TestDb } from '@verity/store/testing';
import type { ContainerCommandRunner } from './devcontainer-lifecycle.js';
import { DockerError, type ContainerInspect, type ContainerSpec } from './docker.js';
import { CONTAINER_GENERATION_LABEL, PROJECT_ID_LABEL } from './project-relay-migration.js';
import type { DevcontainerBuildSpawner, ProjectRelayControl } from './provisioner.js';
import { createProvisioner, defaultProjectRelay, fakeDocker } from './provisioner.test-helper.js';
import { retainedSandboxName } from './sandbox-replacement-rollback.js';
import { projectNetworkName } from './sandbox-identity.js';

// A recreate used to remove the running Sandbox before its replacement had started.
// When the replacement then failed — a devcontainer postCreateCommand rejecting the
// new image was enough — the project had no Sandbox left at all. These run the real
// recreate against a Docker double that keeps containers by id and name, so a
// rename, a removal or a container left running is observable, not inferred.

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

const CONTAINER_NAME = 'dev-example-org-example-repo';
const toolkitFeature = {
  ref: '/opt/verity-features/verity-sandbox-toolkit',
  version: '1.0.0',
  identity: 'sha256:toolkit-v1',
};

interface FakeContainer {
  id: string;
  name: string;
  running: boolean;
  image: string;
  labels: Record<string, string>;
}

/** Docker that keeps containers by id and name, as the daemon does. */
function statefulDocker(projectId: string, failStart?: (container: FakeContainer) => boolean) {
  const containers = new Map<string, FakeContainer>();
  let created = 0;
  const find = (ref: string) =>
    containers.get(ref) ?? [...containers.values()].find((c) => c.name === ref);
  const require = (ref: string) => {
    const container = find(ref);
    if (container === undefined) throw new DockerError({ kind: 'container_not_found', id: ref });
    return container;
  };
  const inspect = (container: FakeContainer): ContainerInspect => ({
    id: container.id,
    running: container.running,
    image: container.image,
    labels: { ...container.labels },
    networks: { [projectNetworkName(projectId)]: {} },
  });
  const renameContainer = vi.fn(async (ref: string, name: string) => {
    const container = require(ref);
    const holder = find(name);
    if (holder !== undefined && holder.id !== container.id)
      throw new DockerError({ kind: 'conflict', message: 'name already in use' });
    container.name = name;
  });
  const removeContainer = vi.fn(async (ref: string) => {
    containers.delete(require(ref).id);
  });
  const inspectContainer = vi.fn(async (ref: string) => inspect(require(ref)));
  const { client } = fakeDocker({
    createContainer: vi.fn(async (spec: ContainerSpec) => {
      if (find(spec.name) !== undefined)
        throw new DockerError({ kind: 'conflict', message: 'name already in use' });
      const id = `replacement-${++created}`;
      containers.set(id, {
        id,
        name: spec.name,
        running: false,
        image: spec.image,
        labels: { ...spec.labels },
      });
      return { id, warnings: [] };
    }),
    startContainer: vi.fn(async (ref: string) => {
      const container = require(ref);
      if (failStart?.(container) === true)
        throw new DockerError({ kind: 'other', status: 500, message: 'start refused' });
      container.running = true;
    }),
    stopContainer: vi.fn(async (ref: string) => {
      require(ref).running = false;
    }),
    removeContainer,
    renameContainer,
    inspectContainer,
    listContainers: vi.fn(async () =>
      [...containers.values()].map((c) => ({
        id: c.id,
        imageId: c.image,
        names: [`/${c.name}`],
        labels: { ...c.labels },
      })),
    ),
  });
  const seedRunning = (id: string, generation: string) => {
    containers.set(id, {
      id,
      name: CONTAINER_NAME,
      running: true,
      image: 'verity-devc-example-org-example-repo:old',
      labels: { [PROJECT_ID_LABEL]: projectId, [CONTAINER_GENERATION_LABEL]: generation },
    });
  };
  return { client, containers, seedRunning, renameContainer, removeContainer, inspectContainer };
}

/** A relay that can sleep and wake a generation, recording what it was asked. */
function sleepingRelay() {
  const base = defaultProjectRelay();
  const sleep = vi.fn(async () => undefined);
  const reactivate = vi.fn(base.start.bind(base));
  const discardGeneration = vi.fn(async () => undefined);
  const control: ProjectRelayControl = { ...base, sleep, reactivate, discardGeneration };
  return { control, sleep, reactivate, discardGeneration };
}

let roots: string[] = [];
afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

/** A clone whose devcontainer runs `postCreateCommand`; `postCreateFails` makes it reject. */
function cloneRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'verity-rollback-'));
  roots.push(root);
  const dir = join(root, 'example-org-example-repo', '.devcontainer');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'devcontainer.json'),
    '{ "image": "node:24-bookworm", "postCreateCommand": "verify-baked-runners" }',
  );
  return root;
}

async function seedActiveProject(): Promise<string> {
  const id = randomUUID();
  await ctx.store.upsertProject({
    id,
    owner: 'example-org',
    repo: 'example-repo',
    containerName: CONTAINER_NAME,
    state: 'active',
  });
  return id;
}

function provisionerFor(options: {
  docker: ReturnType<typeof statefulDocker>;
  relay: ProjectRelayControl;
  postCreateFails?: boolean;
}) {
  const command = vi.fn<ContainerCommandRunner>(async ({ command: cmd }) => {
    if (options.postCreateFails === true && cmd.includes('verify-baked-runners'))
      throw Object.assign(new Error('post-create failed'), {
        stderr: 'Stale baked cluster runner: /usr/local/libexec/x differs from /work/x',
      });
    return { stdout: '', stderr: '' };
  });
  const provisioner = createProvisioner({
    store: ctx.store,
    db: ctx.db,
    docker: options.docker.client,
    projectTokenMint: async () => 'tok',
    defaultImageRef: 'ghcr.io/heey-global/dev-base:default',
    hostCloneRoot: cloneRoot(),
    devcontainerBuild: vi.fn<DevcontainerBuildSpawner>(async () => ({ stdout: '', stderr: '' })),
    dockerHostForBuild: 'unix:///var/run/docker.sock',
    devcontainerFeature: toolkitFeature,
    containerCommand: command,
    projectRelay: options.relay,
  });
  provisioner.attachProjectBusyProbe(async () => false);
  return provisioner;
}

describe('recreate keeps the previous Sandbox until its replacement has started', () => {
  it('restores the previous Sandbox when the replacement fails its postCreateCommand', async () => {
    const id = await seedActiveProject();
    const docker = statefulDocker(id);
    docker.seedRunning('previous', 'generation-previous');
    const relay = sleepingRelay();
    const provisioner = provisionerFor({ docker, relay: relay.control, postCreateFails: true });

    await expect(provisioner.recreateContainer(id, { confirmWarnings: true })).rejects.toThrow(
      /The previous Sandbox was restored/,
    );

    const project = await ctx.store.getProject(id);
    expect(project?.state).toBe('active');
    expect(project?.provisionError).toBeNull();
    expect(project?.provisionWarning).toMatch(/postCreateCommand failed/);
    expect(project?.provisionWarning).toMatch(/previous Sandbox was restored/);
    // Exactly one container, the previous one, running under the project's name.
    expect([...docker.containers.values()]).toEqual([
      expect.objectContaining({ id: 'previous', name: CONTAINER_NAME, running: true }),
    ]);
    expect(docker.renameContainer).toHaveBeenCalledWith(
      'previous',
      retainedSandboxName(CONTAINER_NAME, 'generation-previous'),
    );
    expect(relay.sleep).toHaveBeenCalled();
    expect(relay.reactivate).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: id, containerGeneration: 'generation-previous' }),
    );
    expect(relay.discardGeneration).not.toHaveBeenCalled();
  });

  it('restores the previous Sandbox when the replacement cannot start', async () => {
    const id = await seedActiveProject();
    const docker = statefulDocker(id, (container) => container.id !== 'previous');
    docker.seedRunning('previous', 'generation-previous');
    const provisioner = provisionerFor({ docker, relay: sleepingRelay().control });

    await expect(provisioner.recreateContainer(id, { confirmWarnings: true })).rejects.toThrow(
      /The previous Sandbox was restored/,
    );
    expect((await ctx.store.getProject(id))?.state).toBe('active');
    expect([...docker.containers.values()]).toEqual([
      expect.objectContaining({ id: 'previous', name: CONTAINER_NAME, running: true }),
    ]);
  });

  it('removes the previous Sandbox and its relay once the replacement has started', async () => {
    const id = await seedActiveProject();
    const docker = statefulDocker(id);
    docker.seedRunning('previous', 'generation-previous');
    const relay = sleepingRelay();
    const provisioner = provisionerFor({ docker, relay: relay.control });

    const result = await provisioner.recreateContainer(id, { confirmWarnings: true });

    expect(result.state).toBe('active');
    expect(result.provisionWarning).toBeNull();
    const remaining = [...docker.containers.values()];
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toMatchObject({ name: CONTAINER_NAME, running: true });
    expect(remaining[0]?.id).not.toBe('previous');
    expect(relay.discardGeneration).toHaveBeenCalledWith({
      projectId: id,
      containerGeneration: 'generation-previous',
    });
    expect(relay.reactivate).not.toHaveBeenCalled();
  });

  it('ends failed without leftovers when the previous Sandbox cannot be resumed either', async () => {
    const id = await seedActiveProject();
    const docker = statefulDocker(id);
    docker.seedRunning('previous', 'generation-previous');
    const relay = sleepingRelay();
    relay.reactivate.mockRejectedValue(new Error('relay generation unavailable'));
    const provisioner = provisionerFor({ docker, relay: relay.control, postCreateFails: true });

    await expect(provisioner.recreateContainer(id, { confirmWarnings: true })).rejects.toThrow(
      /restoring the previous Sandbox failed/,
    );
    const project = await ctx.store.getProject(id);
    expect(project?.state).toBe('failed');
    expect(project?.provisionError).toMatch(/postCreateCommand failed/);
    expect(project?.provisionError).toMatch(/relay generation unavailable/);
    expect(docker.containers.size).toBe(0);
    expect(relay.discardGeneration).toHaveBeenCalledWith({
      projectId: id,
      containerGeneration: 'generation-previous',
    });
  });

  it('removes the previous Sandbox first, as before, when the relay cannot sleep it', async () => {
    const id = await seedActiveProject();
    const docker = statefulDocker(id);
    docker.seedRunning('previous', 'generation-previous');
    const provisioner = provisionerFor({
      docker,
      relay: defaultProjectRelay(),
      postCreateFails: true,
    });

    await expect(provisioner.recreateContainer(id, { confirmWarnings: true })).rejects.toThrow(
      /postCreateCommand failed/,
    );
    expect((await ctx.store.getProject(id))?.state).toBe('failed');
    expect(docker.renameContainer).not.toHaveBeenCalled();
    expect(docker.removeContainer).toHaveBeenCalledWith(CONTAINER_NAME);
    expect(docker.containers.size).toBe(0);
  });
});

describe('a Sandbox parked by a recreate the Server did not finish', () => {
  function parkedSandbox(docker: ReturnType<typeof statefulDocker>) {
    docker.seedRunning('previous', 'generation-previous');
    const parked = docker.containers.get('previous')!;
    parked.name = retainedSandboxName(CONTAINER_NAME, 'generation-previous');
    parked.running = false;
  }

  // `active` is what a restart between parking and the replacement's start leaves.
  it.each(['failed', 'container_starting', 'active', 'cloning', 'sleeping'] as const)(
    'is restored when its %s project was left without a Sandbox',
    async (state) => {
      const id = await seedActiveProject();
      await ctx.store.updateProjectState(id, state, state === 'failed' ? 'interrupted' : null);
      const docker = statefulDocker(id);
      parkedSandbox(docker);
      const relay = sleepingRelay();
      const provisioner = provisionerFor({ docker, relay: relay.control });

      await provisioner.reconcileRelays([(await ctx.store.getProject(id))!], {});

      const project = await ctx.store.getProject(id);
      expect(project?.state).toBe('active');
      expect(project?.provisionWarning).toMatch(/previous Sandbox was restored/);
      expect(docker.containers.get('previous')).toMatchObject({
        name: CONTAINER_NAME,
        running: true,
      });
    },
  );

  it('is removed when its replacement is running', async () => {
    const id = await seedActiveProject();
    const docker = statefulDocker(id);
    parkedSandbox(docker);
    docker.containers.set('replacement', {
      id: 'replacement',
      name: CONTAINER_NAME,
      running: true,
      image: 'verity-devc-example-org-example-repo:new',
      labels: { [PROJECT_ID_LABEL]: id, [CONTAINER_GENERATION_LABEL]: 'generation-new' },
    });
    const relay = sleepingRelay();
    const provisioner = provisionerFor({ docker, relay: relay.control });

    await provisioner.reconcileRelays([(await ctx.store.getProject(id))!], {});

    expect(docker.containers.has('previous')).toBe(false);
    expect(docker.containers.get('replacement')).toMatchObject({ running: true });
    expect(relay.discardGeneration).toHaveBeenCalledWith({
      projectId: id,
      containerGeneration: 'generation-previous',
    });
  });

  it('keeps the fallback when a running replacement has not completed lifecycle commands', async () => {
    const id = await seedActiveProject();
    await ctx.store.updateProjectState(id, 'container_starting');
    const docker = statefulDocker(id);
    parkedSandbox(docker);
    docker.containers.set('replacement', {
      id: 'replacement',
      name: CONTAINER_NAME,
      running: true,
      image: 'verity-devc-example-org-example-repo:new',
      labels: { [PROJECT_ID_LABEL]: id, [CONTAINER_GENERATION_LABEL]: 'generation-new' },
    });
    const relay = sleepingRelay();
    const provisioner = provisionerFor({ docker, relay: relay.control });
    await provisioner.reconcileRelays([(await ctx.store.getProject(id))!], {});
    expect(docker.containers.has('previous')).toBe(true);
    expect(docker.containers.get('replacement')).toMatchObject({ running: true });
    expect(relay.discardGeneration).not.toHaveBeenCalled();
    expect(relay.reactivate).not.toHaveBeenCalled();
  });

  // A container under the Sandbox name, even a stopped one, is newer than the
  // parked Sandbox. Restoring would delete it and silently undo the update.
  it('preserves a provision registered while reconciliation inspects the live name', async () => {
    const id = await seedActiveProject();
    const docker = statefulDocker(id);
    parkedSandbox(docker);
    const relay = sleepingRelay();
    const provisioner = provisionerFor({ docker, relay: relay.control });
    const tracking = (
      provisioner as unknown as {
        inFlightProvisions: Map<string, Promise<unknown>>;
      }
    ).inFlightProvisions;
    const inFlight = new Promise(() => undefined);
    const inspectContainer = docker.inspectContainer.getMockImplementation()!;
    docker.inspectContainer.mockImplementation(async (name) => {
      if (name === CONTAINER_NAME) tracking.set(id, inFlight);
      return inspectContainer(name);
    });
    await provisioner.reconcileRelays([(await ctx.store.getProject(id))!], {});
    expect(tracking.get(id)).toBe(inFlight);
    expect(relay.reactivate).not.toHaveBeenCalled();
    tracking.delete(id);
  });

  it('never replaces a stopped newer Sandbox with the parked one', async () => {
    const id = await seedActiveProject();
    const docker = statefulDocker(id);
    parkedSandbox(docker);
    docker.containers.set('replacement', {
      id: 'replacement',
      name: CONTAINER_NAME,
      running: false,
      image: 'verity-devc-example-org-example-repo:new',
      labels: { [PROJECT_ID_LABEL]: id, [CONTAINER_GENERATION_LABEL]: 'generation-new' },
    });
    const relay = sleepingRelay();
    const provisioner = provisionerFor({ docker, relay: relay.control });

    await provisioner.reconcileRelays([(await ctx.store.getProject(id))!], {});

    expect(docker.containers.get('replacement')).toMatchObject({ name: CONTAINER_NAME });
    expect(docker.containers.has('previous')).toBe(true);
    expect(relay.discardGeneration).not.toHaveBeenCalled();
    expect(relay.reactivate).not.toHaveBeenCalled();
  });
});

describe('a replacement that fails after egress protection was turned on', () => {
  it('does not start the previous Sandbox outside protection', async () => {
    const id = await seedActiveProject();
    const docker = statefulDocker(id);
    docker.seedRunning('previous', 'generation-previous');
    const relay = sleepingRelay();
    const provisioner = provisionerFor({ docker, relay: relay.control, postCreateFails: true });
    // Parking sees protection off; the restore after the failed replacement sees it on.
    const egress = vi.spyOn(
      provisioner as unknown as { egressFor(): Promise<unknown> },
      'egressFor',
    );
    let calls = 0;
    egress.mockImplementation(async () => (++calls > 3 ? {} : undefined));

    await expect(provisioner.recreateContainer(id, { confirmWarnings: true })).rejects.toThrow(
      /egress protection is on/,
    );
    expect((await ctx.store.getProject(id))?.state).toBe('failed');
    expect(relay.reactivate).not.toHaveBeenCalled();
    expect(docker.containers.has('previous')).toBe(false);
  });
});
