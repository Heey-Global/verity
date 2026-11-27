import type { EventStore, ProjectRecord } from '@verity/store';
import { describe, expect, it, vi } from 'vitest';
import type { ContainerEventHandlers } from './docker-container-events.js';
import type { DockerClient } from './docker.js';
import { createEmbeddedProjectFleetBindings } from './embedded-project-fleet.js';

const project = {
  id: 'p1',
  containerName: 'dev-p1',
  state: 'active',
  provisionError: null,
  provisionWarning: null,
  stateChangedAt: new Date('2026-11-27T00:00:00Z'),
} as ProjectRecord;

describe('createEmbeddedProjectFleetBindings', () => {
  // Every detail read inspected the project's container; with Docker's event
  // stream open the row already follows the container, and the inspect is the
  // per-read cost this removes. Without the stream the read must still look.
  it('inspects on a detail read only while the event stream is not open', async () => {
    let handlers: ContainerEventHandlers | undefined;
    const inspectContainer = vi.fn(async (id: string) => ({ id, running: true }));
    const docker = {
      inspectContainer,
      followContainerEvents: (next: ContainerEventHandlers) => {
        handlers = next;
        return async () => undefined;
      },
    } as unknown as DockerClient;
    const eventStore = {
      getProject: async () => project,
      listProjects: async () => [project],
      updateProjectState: vi.fn(),
    } as unknown as EventStore;
    const bindings = createEmbeddedProjectFleetBindings({
      eventStore,
      installationService: undefined,
      docker,
      provisioner: undefined,
      projectList: undefined,
      hasMasterPassword: false,
      secretCipher: { isSealed: () => false },
      refreshProjectToken: undefined,
    });
    const stop = bindings.containerLiveness!.start();

    await bindings.reconcileProjectState!(project);
    expect(inspectContainer).toHaveBeenCalledTimes(1);

    handlers!.onConnected();
    await vi.waitFor(() => expect(inspectContainer).toHaveBeenCalledTimes(2));
    await bindings.reconcileProjectState!(project);
    await bindings.reconcileProjectState!(project);
    expect(inspectContainer).toHaveBeenCalledTimes(2);

    handlers!.onDisconnected(new Error('daemon restarting'));
    await bindings.reconcileProjectState!(project);
    expect(inspectContainer).toHaveBeenCalledTimes(3);
    await stop();
  });
});
