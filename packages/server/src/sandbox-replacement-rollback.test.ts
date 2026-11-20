import { describe, expect, it, vi } from 'vitest';
import type { ProjectRecord } from '@verity/store';
import { DockerError, type ContainerInspect, type DockerClient } from './docker.js';
import { planRelaySweep } from './docker-gc.js';
import { CONTAINER_GENERATION_LABEL, PROJECT_ID_LABEL } from './project-relay-migration.js';
import { defaultProjectRelay } from './provisioner.test-helper.js';
import { RetainedResumeError } from './sandbox-retained-resume.js';
import {
  parkSandboxForReplacement,
  reconcileRetainedSandboxes,
  restoreParkedSandbox,
  retainedSandboxName,
  retainedSandboxesOf,
  type ReplacementRollbackHost,
} from './sandbox-replacement-rollback.js';

const project = { id: 'p', containerName: 'dev-p', state: 'active' } as ProjectRecord;
const running: ContainerInspect = {
  id: 'previous',
  running: true,
  labels: { [PROJECT_ID_LABEL]: 'p', [CONTAINER_GENERATION_LABEL]: 'g1' },
};

/** A rollback host whose Docker and lifecycle calls are spies the tests read directly. */
function host(overrides: Partial<ReplacementRollbackHost> = {}, inspect = running) {
  const inspectContainer = vi.fn<(ref: string) => Promise<ContainerInspect>>(async () => inspect);
  const renameContainer = vi.fn(async () => undefined);
  const removeContainer = vi.fn(async () => undefined);
  const quiesce = vi.fn(async () => undefined);
  const resume = vi.fn(async () => undefined);
  const docker = { inspectContainer, renameContainer, removeContainer } as unknown as DockerClient;
  const value: ReplacementRollbackHost = {
    docker,
    projectRelay: {
      ...defaultProjectRelay(),
      sleep: vi.fn(async () => undefined),
      reactivate: vi.fn(),
    },
    store: { updateProjectState: vi.fn(async () => undefined) },
    failure: (message) => new Error(message),
    describe: String,
    egressIdle: async () => true,
    fingerprint: (container) => JSON.stringify(container.labels),
    quiesce,
    resume,
    ...overrides,
  };
  return { value, docker, inspectContainer, renameContainer, removeContainer, quiesce, resume };
}

describe('parkSandboxForReplacement', () => {
  it('parks a running, owned Sandbox under its retained name', async () => {
    const h = host();
    const parked = await parkSandboxForReplacement(h.value, project);
    expect(parked).toMatchObject({ containerId: 'previous', generation: 'g1' });
    expect(h.quiesce).toHaveBeenCalledOnce();
    expect(h.renameContainer).toHaveBeenCalledWith('previous', 'dev-p--retained-g1');
  });

  it('discards the slept relay when Docker cannot rename the Sandbox', async () => {
    const discardGeneration = vi.fn(async () => undefined);
    const h = host();
    h.value.projectRelay.discardGeneration = discardGeneration;
    h.renameContainer.mockRejectedValue(new Error('rename failed'));
    await expect(parkSandboxForReplacement(h.value, project)).rejects.toThrow('rename failed');
    expect(discardGeneration).toHaveBeenCalledWith({
      projectId: 'p',
      containerGeneration: 'g1',
    });
  });

  // A protected generation cannot be kept: the host admits one per project and a
  // wake demands a fresh one. Parking it would strand the project on restore.
  it.each([
    ['egress protection is on', { egressIdle: async (): Promise<boolean> => false }, running],
    [
      'the egress host cannot answer',
      { egressIdle: (): Promise<boolean> => Promise.reject(new Error('down')) },
      running,
    ],
    ['the container is not running', {}, { ...running, running: false }],
    [
      'the container belongs to another project',
      {},
      { ...running, labels: { [PROJECT_ID_LABEL]: 'q' } },
    ],
  ] as const)('leaves the Sandbox alone when %s', async (_, overrides, inspect) => {
    const h = host(overrides, inspect);
    expect(await parkSandboxForReplacement(h.value, project)).toBeUndefined();
    expect(h.quiesce).not.toHaveBeenCalled();
    expect(h.renameContainer).not.toHaveBeenCalled();
  });

  it('leaves the Sandbox alone when the relay cannot sleep it or Docker cannot rename', async () => {
    const noSleep = host({ projectRelay: defaultProjectRelay() });
    expect(await parkSandboxForReplacement(noSleep.value, project)).toBeUndefined();
    const noRename = host();
    delete (noRename.docker as Partial<DockerClient>).renameContainer;
    expect(await parkSandboxForReplacement(noRename.value, project)).toBeUndefined();
    expect(noSleep.quiesce).not.toHaveBeenCalled();
    expect(noRename.quiesce).not.toHaveBeenCalled();
  });
});

describe('restoreParkedSandbox', () => {
  const parked = {
    containerId: 'previous',
    generation: 'g1',
    name: 'dev-p--retained-g1',
    fingerprint: JSON.stringify(running.labels),
  };
  const stopped = { ...running, running: false };

  function restoringHost(atName: ContainerInspect | undefined, retained = stopped) {
    const h = host();
    h.inspectContainer.mockImplementation(async (ref: string) => {
      if (ref === 'previous') return retained;
      if (atName === undefined) throw new DockerError({ kind: 'container_not_found', id: ref });
      return atName;
    });
    return h;
  }

  it('removes the failed replacement, renames the parked Sandbox back and resumes it', async () => {
    const h = restoringHost({
      id: 'replacement',
      running: false,
      labels: { [PROJECT_ID_LABEL]: 'p' },
    });
    await restoreParkedSandbox(h.value, project, parked, async () => undefined);
    expect(h.removeContainer).toHaveBeenCalledWith('replacement');
    expect(h.renameContainer).toHaveBeenCalledWith('previous', 'dev-p');
    expect(h.resume).toHaveBeenCalledWith(project, stopped, 'g1', expect.any(Function));
  });

  it('never removes a foreign container holding the Sandbox name', async () => {
    const h = restoringHost({ id: 'foreign', running: true, labels: {} });
    await expect(
      restoreParkedSandbox(h.value, project, parked, async () => undefined),
    ).rejects.toThrow('foreign container');
    expect(h.removeContainer).not.toHaveBeenCalled();
    expect(h.resume).not.toHaveBeenCalled();
  });

  it('refuses a parked Sandbox that changed while its replacement started', async () => {
    const changed = { ...stopped, labels: { ...stopped.labels, extra: 'x' } };
    const h = restoringHost(undefined, changed);
    await expect(
      restoreParkedSandbox(h.value, project, parked, async () => undefined),
    ).rejects.toThrow('changed');
    expect(h.renameContainer).not.toHaveBeenCalled();
    expect(h.resume).not.toHaveBeenCalled();
  });
});

describe('a parked generation in the container inventory', () => {
  const inventory = [
    {
      id: 'previous',
      imageId: 'sha256:old',
      names: [`/${retainedSandboxName('dev-p', 'g1')}`],
      labels: { [PROJECT_ID_LABEL]: 'p', [CONTAINER_GENERATION_LABEL]: 'g1' },
    },
    {
      id: 'relay-g1',
      imageId: 'sha256:relay',
      created: 0,
      names: ['/verity-relay-g1'],
      labels: {
        [PROJECT_ID_LABEL]: 'p',
        [CONTAINER_GENERATION_LABEL]: 'g1',
        'verity.component': 'project-relay',
      },
    },
  ];

  it('is recognised by its retained name and generation, and only for its project', () => {
    expect(retainedSandboxesOf(inventory, project)).toEqual([
      { containerId: 'previous', generation: 'g1' },
    ]);
    expect(retainedSandboxesOf(inventory, { id: 'q', containerName: 'dev-p' })).toEqual([]);
  });

  // The relay of a parked generation must survive until the parked Sandbox is
  // restored or discarded: a restore reactivates exactly that relay.
  it('keeps its relay out of the daily relay sweep', () => {
    expect(planRelaySweep({ containers: inventory, nowMs: Date.now(), minAgeMs: 0 })).toEqual([]);
    expect(
      planRelaySweep({ containers: inventory.slice(1), nowMs: Date.now(), minAgeMs: 0 }),
    ).toHaveLength(1);
  });
});

// After a Server restart the parked Sandbox may be the only copy of the project's
// Sandbox. A restore that fails for a reason that may pass must not destroy it.
describe('reconcileRetainedSandboxes', () => {
  const failed = { ...project, state: 'failed' } as ProjectRecord;
  const stopped = { ...running, running: false };

  function inventoryHost(resumeError: unknown) {
    const h = host({}, stopped);
    h.inspectContainer.mockImplementation(async (ref: string) => {
      if (ref === 'previous') return stopped;
      throw new DockerError({ kind: 'container_not_found', id: ref });
    });
    h.resume.mockRejectedValue(resumeError);
    (h.docker as { listContainers?: DockerClient['listContainers'] }).listContainers = async () => [
      {
        id: 'previous',
        imageId: 'sha256:old',
        names: [`/${retainedSandboxName('dev-p', 'g1')}`],
        labels: { [PROJECT_ID_LABEL]: 'p', [CONTAINER_GENERATION_LABEL]: 'g1' },
      },
    ];
    return h;
  }
  const hooks = {
    isProvisioning: () => false,
    serialize: async (_project: ProjectRecord, restore: () => Promise<void>) => restore(),
  };

  it('keeps the parked Sandbox when its restore fails for a reason that may pass', async () => {
    const h = inventoryHost(new RetainedResumeError(new Error('runner not ready'), false, []));
    await expect(reconcileRetainedSandboxes(h.value, [failed], hooks)).rejects.toThrow(
      'reconcile failed',
    );
    expect(h.removeContainer).not.toHaveBeenCalledWith('previous');
    // Renamed back, so the next pass still finds it as parked.
    expect(h.renameContainer).toHaveBeenLastCalledWith(
      'previous',
      retainedSandboxName('dev-p', 'g1'),
    );
  });

  it('leaves the parked Sandbox alone when provisioning starts during inspection', async () => {
    const h = inventoryHost(new Error('unused'));
    const isProvisioning = vi.fn().mockReturnValueOnce(false).mockReturnValue(true);
    await expect(
      reconcileRetainedSandboxes(h.value, [failed], { ...hooks, isProvisioning }),
    ).rejects.toThrow('reconcile failed');
    expect(h.resume).not.toHaveBeenCalled();
    expect(h.removeContainer).not.toHaveBeenCalled();
    expect(h.renameContainer).not.toHaveBeenCalled();
  });

  it('removes the parked Sandbox once its relay generation is gone for good', async () => {
    const h = inventoryHost(new RetainedResumeError(new Error('relay gone'), true, []));
    await expect(reconcileRetainedSandboxes(h.value, [failed], hooks)).rejects.toThrow(
      'reconcile failed',
    );
    expect(h.removeContainer).toHaveBeenCalledWith('previous');
  });

  it('does not start the parked Sandbox once egress protection is on', async () => {
    const h = inventoryHost(new Error('unused'));
    h.value.egressIdle = async () => false;
    await reconcileRetainedSandboxes(h.value, [failed], hooks);
    expect(h.resume).not.toHaveBeenCalled();
    expect(h.removeContainer).toHaveBeenCalledWith('previous');
    expect(h.value.store.updateProjectState).toHaveBeenCalledWith(
      'p',
      'failed',
      expect.stringContaining('egress protection'),
    );
  });
});
