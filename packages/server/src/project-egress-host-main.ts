import { createDockerClient, DockerError } from './docker.js';
import { createHostProjectNetworks } from './project-egress-network-cleanup.js';
import { ProjectEgressInventoryError } from './project-egress-inventory-error.js';
import {
  createNativeProtectedBuildHost,
  protectedBuildBootstrapRules,
} from './project-egress-build-host.js';
import { openProjectEgressInventoryHistory } from './project-egress-inventory-history.js';
import { ProjectEgressHealthError } from './project-egress-health.js';
import { createManagedSystemInventory } from './project-egress-system-inventory.js';
import { z } from 'zod';
import { inspectEgressHostDirectTransport } from './project-egress-host-inspection.js';
import { createPostgresDb, ProjectEgressStore } from '@verity/store';
import {
  readEgressHostConfiguration,
  egressHostAuthority,
  egressHostDestinationAllowed,
  egressHostDirectChecks,
  unavailableEgressAuthority,
  verifyEgressHostAuthorityReady,
} from './project-egress-host-authority.js';
import { createProjectEgressHostEnforcement } from './project-egress-host-enforcement.js';
import { hostProjectDeadlineEnforcer } from './project-egress-deadline.js';
import { inspectProjectFenceAttachment } from './project-egress-attachment.js';
import { createProjectEgressResolvers } from './project-egress-resolver.js';
import {
  createProtectedAddressInventory,
  SYSTEM_DIRECT_TARGETS,
} from './project-egress-classification.js';
import { inspectEgressTransport } from './project-egress-transport.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  serveProjectEgressHost,
  verifyProjectEgressServiceManager,
  verifyProjectEgressDockerHost,
} from './project-egress-host-service.js';
import { egressRelayPolicy } from './project-egress-relay-policy.js';
/** Managed host entrypoint. Activation requires a validated runtime profile and complete inventory. */
import { readFile } from 'node:fs/promises';
import { ProjectEgressHost, projectEgressBootstrapRules } from './project-egress-host.js';
import {
  applyProjectFenceRules,
  projectFenceTable,
  type ProjectFenceDependencies,
} from './project-egress-fence.js';
import { listenProjectEgressHost } from './project-egress-host-control.js';
import {
  inspectEgressHostContainer,
  inspectEgressHostDirect,
  inspectEgressHostNetwork,
  openProjectEgressHostStore,
  projectEgressHostDocker,
  verifyEgressHostRuntime,
  createEgressHostRuntimeRegistrationGuard,
} from './project-egress-host-runtime.js';

if (process.platform !== 'linux' || process.getuid?.() !== 0)
  throw new Error('Project egress host service requires a Linux host service account');
const mode = process.argv[2];
if (!['deny', 'restore', 'serve'].includes(mode ?? ''))
  throw new Error('Expected deny, restore or serve');
// Paths are host installation constants, not request-controlled configuration.
await applyProjectFenceRules(projectEgressBootstrapRules());
// ExecStopPost must fence even a corrupt registry or missing Docker daemon.
if (mode === 'deny') {
  await applyProjectFenceRules(protectedBuildBootstrapRules());
  process.exit(0);
}
verifyProjectEgressServiceManager(
  (await promisify(execFile)('/usr/bin/systemctl', ['--version'], { timeout: 5000 })).stdout,
  await readFile('/proc/1/comm', 'utf8'),
);
const store = await openProjectEgressHostStore('/var/lib/verity-egress');
const rawRelay = await readEgressHostConfiguration('/etc/verity-egress/relay.json');
const relayPolicy = rawRelay === undefined ? undefined : egressRelayPolicy.parse(rawRelay);
const rawAuthority = await readEgressHostConfiguration('/etc/verity-egress/authority.json');
const authority = rawAuthority === undefined ? undefined : egressHostAuthority.parse(rawAuthority);
if (authority !== undefined && relayPolicy?.packetEnforcement !== true)
  throw new Error('Direct authority requires host packet enforcement');
const database = authority === undefined ? undefined : createPostgresDb(authority.databaseUrl);
const projectPolicy = database === undefined ? undefined : new ProjectEgressStore(database);
// Deny and pre-daemon restore paths never depend on a Docker registration read.
const servingRuntimeRegistration =
  mode === 'serve'
    ? createEgressHostRuntimeRegistrationGuard(
        JSON.parse(await projectEgressHostDocker('info', '--format', '{{json .Runtimes}}')),
      )
    : undefined;
let runtimeRegistrationCheck: Promise<void> | undefined;
const verifyServingRuntimeRegistration = (): Promise<void> => {
  if (!servingRuntimeRegistration) return Promise.resolve();
  runtimeRegistrationCheck ??= projectEgressHostDocker('info', '--format', '{{json .Runtimes}}')
    .then((reply) => servingRuntimeRegistration(JSON.parse(reply)))
    .finally(() => {
      runtimeRegistrationCheck = undefined;
    });
  return runtimeRegistrationCheck;
};

const policyStore: Pick<ProjectEgressStore, 'readForAdmission'> = {
  readForAdmission: async (...args) => {
    if (inventoryPersistenceFailed)
      throw new ProjectEgressHealthError('mandatory_inventory_incomplete');
    systemInventory.verify();
    await verifyServingRuntimeRegistration();
    return (projectPolicy ?? unavailableEgressAuthority).readForAdmission(...args);
  },
};
const { resolve, resolveProtected } =
  authority === undefined
    ? {
        resolve: () => Promise.reject(new Error('Host DNS authority is not configured')),
        resolveProtected: () => Promise.reject(new Error('Host DNS authority is not configured')),
      }
    : createProjectEgressResolvers({
        servers: authority.dnsServers,
        destinationAllowed: egressHostDestinationAllowed,
      });
const inventoryHistory = await openProjectEgressInventoryHistory('/var/lib/verity-egress');
let inventoryPersistenceFailed = false;
let inventoryPersistenceFailures = 0;
const resolveInventory: typeof resolveProtected = async (host) => {
  try {
    const result = await resolveProtected(host);
    try {
      await inventoryHistory.addAddresses(result.addresses);
    } catch (error) {
      inventoryPersistenceFailed = true;
      inventoryPersistenceFailures++;
      throw error;
    }
    return result;
  } catch (error) {
    const addresses =
      typeof error === 'object' && error !== null && 'publicAddresses' in error
        ? error.publicAddresses
        : undefined;
    if (
      Array.isArray(addresses) &&
      addresses.every((address): address is string => typeof address === 'string')
    ) {
      try {
        await inventoryHistory.addAddresses(addresses);
      } catch (failure) {
        inventoryPersistenceFailed = true;
        inventoryPersistenceFailures++;
        throw failure;
      }
    }
    throw error;
  }
};
// Addresses of broker/system destinations are never direct, whatever name points at them.
let protectedAddresses = createProtectedAddressInventory({
  resolve: resolveInventory,
  configuredHosts: [
    ...new Set([...inventoryHistory.hosts(), ...(authority?.mandatoryHosts ?? [])]),
  ],
  reportConfiguredFailure: () => {
    console.error('verity: protected inventory DNS refresh failed');
  },
});
const managedInventory = authority?.managedInventoryComplete === false;
const deploymentMandatoryHosts = [...(authority?.mandatoryHosts ?? [])];
const systemInventory = createManagedSystemInventory({
  managed: managedInventory,
  healthy: () => !inventoryPersistenceFailed,
  invalidate: () => {
    if (managedInventory && authority) authority.managedInventoryComplete = false;
  },
  replace: async (hosts, addresses) => {
    if (!authority) throw new ProjectEgressInventoryError('inventory_not_configured');
    try {
      await inventoryHistory.addHosts([...deploymentMandatoryHosts, ...hosts]);
      await inventoryHistory.addAddresses(addresses);
    } catch {
      inventoryPersistenceFailed = true;
      inventoryPersistenceFailures++;
      throw new ProjectEgressInventoryError('inventory_persistence_failed');
    }
    const next = createProtectedAddressInventory({
      resolve: resolveInventory,
      configuredHosts: inventoryHistory.dnsHosts([...deploymentMandatoryHosts, ...hosts]),
    });
    const persistenceFailuresBeforeRefresh = inventoryPersistenceFailures;
    try {
      await next.refresh();
    } catch {
      throw new ProjectEgressInventoryError(
        inventoryPersistenceFailures !== persistenceFailuresBeforeRefresh
          ? 'inventory_persistence_failed'
          : 'inventory_dns_failed',
      );
    }
    protectedAddresses = next;
    inventoryPersistenceFailed = false;
    authority.mandatoryHosts = inventoryHistory.hosts();
    authority.managedInventoryComplete = true;
  },
});
const deadline = hostProjectDeadlineEnforcer();
const fenceDependencies: Omit<ProjectFenceDependencies, 'policyCurrent' | 'deadline'> = {
  inspect: inspectProjectFenceAttachment,
  apply: applyProjectFenceRules,
  ...(() => {
    const checks = egressHostDirectChecks(authority, {
      allows: (address) => protectedAddresses.allows(address),
    });
    return {
      directTargetAllowed: async (host: string) =>
        !inventoryPersistenceFailed &&
        systemInventory.ready() &&
        (await checks.directTargetAllowed(host)),
      destinationAllowed: async (address: string) =>
        !inventoryPersistenceFailed &&
        systemInventory.ready() &&
        !inventoryHistory.protectedAddress(address) &&
        (await checks.destinationAllowed(address)),
    };
  })(),
  reportSystemFailure: (target, error) =>
    console.error(`System destination ${target.host} was not admitted`, error),
  resolve,
  existing: async (binding) => {
    const tables = z
      .object({
        nftables: z.array(
          z.object({ table: z.object({ family: z.string(), name: z.string() }).optional() }),
        ),
      })
      .parse(
        JSON.parse(
          (
            await promisify(execFile)('/usr/sbin/nft', ['-j', 'list', 'tables'], {
              timeout: 1000,
            })
          ).stdout,
        ),
      );
    return tables.nftables.some(
      (item) => item.table?.family === 'inet' && item.table.name === projectFenceTable(binding),
    );
  },
};
const enforcement = createProjectEgressHostEnforcement({
  deadline,
  store: policyStore,
  systemTargets: SYSTEM_DIRECT_TARGETS,
  ...(projectPolicy ? { requests: projectPolicy } : {}),
  reportRequestFailure: (error) => console.error('Destination request was not recorded', error),
  directAuthority: () => authority !== undefined,
  inspect: inspectEgressHostDirect,
  dependencies: fenceDependencies,
});

const verifyHost = async () => {
  const info: unknown = JSON.parse(await projectEgressHostDocker('info', '--format', '{{json .}}'));
  verifyProjectEgressDockerHost(info);
};
const hostNetworkDocker = createDockerClient({
  baseUrl: 'unix:///var/run/docker.sock:/v1.47',
  timeoutMs: 3000,
});
const controller = new ProjectEgressHost(await store.load(), {
  ...createHostProjectNetworks(
    createDockerClient({ baseUrl: 'unix:///var/run/docker.sock:/v1.47', timeoutMs: 250 }),
    hostNetworkDocker,
  ),
  ...(managedInventory ? { systemInventory } : {}),
  verifyHealth: async () => {
    if (inventoryPersistenceFailed)
      throw new ProjectEgressHealthError('mandatory_inventory_incomplete');
    systemInventory.verify();
    await verifyServingRuntimeRegistration();
    verifyEgressHostAuthorityReady(authority);
    await verifyHost();
    const runtimes: unknown = JSON.parse(
      await projectEgressHostDocker('info', '--format', '{{json .Runtimes}}'),
    );
    verifyEgressHostRuntime(runtimes, 'sandbox');
    verifyEgressHostRuntime(runtimes, 'relay');
  },
  ...(relayPolicy?.packetEnforcement === true
    ? { enforcement, bootId: (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim() }
    : {}),
  save: (state) => store.save(state),
  apply: applyProjectFenceRules,
  inspectNetwork: inspectEgressHostNetwork,
  inspectContainer: (binding, id, role, restoring) =>
    inspectEgressHostContainer(binding, id, role, relayPolicy, restoring),
  inspectDirectTransport: (binding, ids) => {
    if (!relayPolicy) throw new Error('Relay host policy is not configured');
    return inspectEgressHostDirectTransport(binding, ids, relayPolicy);
  },
  inspectTransport: (binding, ids) => {
    if (!relayPolicy) throw new Error('Relay host policy is not configured');
    return inspectEgressTransport(binding, ids, relayPolicy.codexSubpath !== undefined);
  },
  startContainer: async (id) => {
    await projectEgressHostDocker('container', 'start', id);
  },
  stopContainer: async (id) => {
    try {
      await projectEgressHostDocker('container', 'stop', '--time', '1', id);
    } catch (error) {
      // A concurrent retired-generation cleanup may already have removed this exact ID.
      try {
        await hostNetworkDocker.inspectContainer(id);
      } catch (inspectionError) {
        if (
          inspectionError instanceof DockerError &&
          inspectionError.kind === 'container_not_found'
        )
          return;
      }
      throw error;
    }
  },
});
const builds =
  relayPolicy?.packetEnforcement === true
    ? await createNativeProtectedBuildHost({
        imageRef: relayPolicy.image,
        ...(relayPolicy.previousImage === undefined
          ? {}
          : { cleanupImageRef: relayPolicy.previousImage }),
        dataVolume: relayPolicy.dataVolume,
        dependencies: { ...fenceDependencies, deadline },
        verifyReady: async () => {
          systemInventory.verify();
          if (inventoryPersistenceFailed)
            throw new ProjectEgressHealthError('mandatory_inventory_incomplete');
          verifyEgressHostAuthorityReady(authority);
          await verifyServingRuntimeRegistration();
          await verifyHost();
        },
      })
    : undefined;
if (mode === 'restore') {
  await builds?.restore();
  await controller.restore(relayPolicy?.packetEnforcement === true);
  deadline.close();
  await database?.destroy();
} else {
  const refreshProtected = () =>
    protectedAddresses.refresh().catch(() => {
      // The previous complete inventory ages out; direct admission then fails closed.
      console.error('verity: protected destination inventory refresh failed', {
        reason: inventoryPersistenceFailed
          ? 'inventory_persistence_failed'
          : 'inventory_dns_failed',
      });
    });
  if (authority !== undefined) await refreshProtected();
  const inventoryTimer =
    authority === undefined ? undefined : setInterval(() => void refreshProtected(), 60_000);
  inventoryTimer?.unref();
  const service = await serveProjectEgressHost({
    restore: async () => {
      await builds?.restore();
      await controller.restore();
    },
    deny: async () => {
      await Promise.all([builds?.close(), controller.shutdown()]);
    },
    verifyHost,
    revalidate: async () => {
      await builds?.controller.revalidate();
      await controller.revalidate();
    },
    listen: async () => {
      const token = (await readFile('/etc/verity-egress/control.key', 'utf8')).trim();
      return listenProjectEgressHost({
        directory: '/run/verity-egress',
        token,
        controller,
        ...(builds ? { builds: builds.controller } : {}),
      });
    },
    notifyReady: async () => {
      if (!process.env.NOTIFY_SOCKET) throw new Error('Systemd readiness channel is required');
      await promisify(execFile)('/usr/bin/systemd-notify', ['--ready'], {
        timeout: 5000,
        env: { PATH: '/usr/bin:/bin', NOTIFY_SOCKET: process.env.NOTIFY_SOCKET },
      });
    },
  });
  let networkSweepRunning = false;
  const sweepNetworks = async () => {
    if (networkSweepRunning) return;
    networkSweepRunning = true;
    try {
      await controller.cleanupNetworks();
    } catch (error) {
      console.error('Project network cleanup deferred', error);
    } finally {
      networkSweepRunning = false;
    }
  };
  await sweepNetworks();
  const networkSweep = setInterval(() => void sweepNetworks(), 60_000);
  networkSweep.unref();
  let sweeping = false;
  const buildSweep = builds
    ? setInterval(() => {
        if (sweeping) return;
        sweeping = true;
        void builds.controller
          .revalidate()
          .catch((error: unknown) => {
            console.error('Protected build supervision failed', error);
          })
          .finally(() => {
            sweeping = false;
          });
      }, 1000)
    : undefined;
  buildSweep?.unref();
  const stop = () => {
    clearInterval(buildSweep);
    clearInterval(networkSweep);
    clearInterval(inventoryTimer);
    void service.stop().then(
      async () => {
        deadline.close();
        await database?.destroy();
        process.exit(0);
      },
      () => {
        deadline.close();
        process.exit(1);
      },
    );
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}
