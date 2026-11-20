import type { EventStore } from '@verity/store';
import { readFileSync } from 'node:fs';
import type { EmbeddedServerConfig } from './embedded-types.js';
import { ProjectEgressInventoryError } from './project-egress-inventory-error.js';
import { createProjectEgressHostClient } from './project-egress-host-client.js';
import { createProjectEgressInventorySynchronizer } from './project-egress-system-inventory.js';

export async function startEmbeddedSystemInventory(
  config: Pick<
    EmbeddedServerConfig,
    'projectEgressSocketPath' | 'projectEgressKeyPath' | 'projectEgressInventoryRequired'
  >,
  eventStore: EventStore,
): Promise<() => void> {
  const systemInventorySync =
    config.projectEgressSocketPath && config.projectEgressKeyPath
      ? createProjectEgressInventorySynchronizer({
          enabled: config.projectEgressInventoryRequired ?? (() => false),
          command: createProjectEgressHostClient({
            socketPath: config.projectEgressSocketPath,
            token: () => readFileSync(config.projectEgressKeyPath!, 'utf8').trim(),
          }),
          readUrls: () => eventStore.readEgressDestinationUrls(),
          transaction: (action) => eventStore.withEgressDestinationTransaction(action),
        })
      : undefined;
  if (systemInventorySync) eventStore.setEgressDestinationMutation(systemInventorySync.mutate);
  // A controller restart starts incomplete; periodic re-synchronization repairs
  // that state. Configuration writes always use the synchronous prechange barrier.
  const synchronizeSystemInventory = () =>
    systemInventorySync?.refresh().catch((error: unknown) => {
      console.warn('verity: system destination inventory synchronization unavailable', {
        operation: 'inventory-refresh',
        reason: error instanceof ProjectEgressInventoryError ? error.reason : 'host_not_ready',
        ...(error instanceof ProjectEgressInventoryError && error.correlationId
          ? { correlationId: error.correlationId }
          : {}),
      });
    });
  await synchronizeSystemInventory();
  const systemInventoryTimer = systemInventorySync
    ? setInterval(() => void synchronizeSystemInventory(), 10_000)
    : undefined;
  systemInventoryTimer?.unref();

  return () => clearInterval(systemInventoryTimer);
}
