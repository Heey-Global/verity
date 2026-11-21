import type { EventStore } from '@verity/store';
import type { FastifyInstance } from 'fastify';
import type { BuildStorage } from './build-storage.js';
import { DependencyCapacity } from './dependency-capacity.js';
import { DockerProjectRuntime } from './project-runtime.js';
import { sandboxIdentity } from './sandbox-identity.js';

export function createEmbeddedDependencyCapacity(
  storage: BuildStorage,
  store: EventStore,
  dockerBaseUrl?: string,
) {
  const runtime = new DockerProjectRuntime({ dockerBaseUrl });
  const capacity = new DependencyCapacity(
    store.capacityLeases,
    (bytes, inodes) => storage.checkDependencyCapacity(bytes, inodes),
    async (lease, action) => {
      const project = await store.getProject(lease.projectId);
      const sandbox = await store.projectSandboxes.get(lease.projectId, lease.userId);
      if (!project || !sandbox)
        throw new Error('Dependency capacity sandbox identity unavailable.');
      return runtime.capacityLease(
        { ...project, containerName: sandboxIdentity(project, sandbox).containerName },
        {
          userId: lease.userId,
          generation: lease.containerGeneration,
          action,
          operationId: lease.id,
        },
      );
    },
  );
  storage.setDependencyReservations(() => capacity.pressure());
  void capacity.initialize().catch(() => undefined);
  return capacity;
}

export function installDependencyCapacityReconciliation(
  app: FastifyInstance,
  capacity: DependencyCapacity | undefined,
): void {
  if (!capacity) return;
  let running = false;
  let closed = false;
  let pending: Promise<void> = Promise.resolve();
  const reconcile = () => {
    if (running || closed) return;
    running = true;
    pending = capacity
      .reconcile()
      .catch(() => {
        app.log.warn(
          'Dependency capacity reconciliation could not prove termination; reservations remain protected',
        );
      })
      .finally(() => {
        running = false;
      });
  };
  reconcile();
  const timer = setInterval(reconcile, 60_000);
  timer.unref();
  app.addHook('onClose', async () => {
    closed = true;
    clearInterval(timer);
    await pending;
  });
}
