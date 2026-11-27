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

  // Reopened on the same store, a server must judge its projects with its own
  // provisioner's guards, and its reads must not trust a stream it never opened.
  it('builds a new liveness for a new provisioner on the same store', async () => {
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
    const bind = (provisioner: object) =>
      createEmbeddedProjectFleetBindings({
        eventStore,
        installationService: undefined,
        docker,
        provisioner: provisioner as never,
        projectList: undefined,
        hasMasterPassword: false,
        secretCipher: { isSealed: () => false },
        refreshProjectToken: undefined,
      });
    const first = bind({ isProjectProvisioning: () => false });
    const stop = first.containerLiveness!.start();
    handlers!.onConnected();
    await vi.waitFor(() => expect(inspectContainer).toHaveBeenCalledTimes(1));
    await first.reconcileProjectState!(project);
    expect(inspectContainer).toHaveBeenCalledTimes(1);
    const second = bind({ isProjectProvisioning: () => false });
    await second.reconcileProjectState!(project);
    expect(inspectContainer).toHaveBeenCalledTimes(2);
    await stop();
  });

  // Without it the overview serves the row from before the container died for
  // the cache's lifetime; kept after the stop, a closed server's cache would
  // stay reachable and keep being invalidated.
  it('refreshes the project list on stream writes while the server runs', async () => {
    let handlers: ContainerEventHandlers | undefined;
    let running = true;
    const docker = {
      inspectContainer: vi.fn(async (id: string) => ({ id, running })),
      followContainerEvents: (next: ContainerEventHandlers) => {
        handlers = next;
        return async () => undefined;
      },
    } as unknown as DockerClient;
    let row = project;
    const eventStore = {
      getProject: async () => row,
      listProjects: async () => [row],
      updateProjectState: vi.fn(async (_id: string, state: ProjectRecord['state']) => {
        row = { ...row, state };
        return row;
      }),
    } as unknown as EventStore;
    const projectList = { list: vi.fn(), invalidate: vi.fn() };
    const bindings = createEmbeddedProjectFleetBindings({
      eventStore,
      installationService: undefined,
      docker,
      provisioner: undefined,
      projectList,
      hasMasterPassword: false,
      secretCipher: { isSealed: () => false },
      refreshProjectToken: undefined,
    });
    const stop = bindings.containerLiveness!.start();
    handlers!.onConnected();
    running = false;
    handlers!.onEvent('p1', 'die');
    await vi.waitFor(() => expect(projectList.invalidate).toHaveBeenCalledTimes(1));
    await stop();
    row = { ...row, state: 'active' };
    await bindings.reconcileProjectState!(row);
    expect(eventStore.updateProjectState).toHaveBeenCalledTimes(2);
    expect(projectList.invalidate).toHaveBeenCalledTimes(1);
  });
});
