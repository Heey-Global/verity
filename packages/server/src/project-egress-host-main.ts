import { z } from 'zod';
import { createPostgresDb, ProjectEgressStore } from '@verity/store';
import {
  readEgressHostConfiguration,
  egressHostAuthority,
  egressHostDestinationAllowed,
  unavailableEgressAuthority,
} from './project-egress-host-authority.js';
import { createProjectEgressHostEnforcement } from './project-egress-host-enforcement.js';
import { hostProjectDeadlineEnforcer } from './project-egress-deadline.js';
import { inspectProjectFenceAttachment } from './project-egress-attachment.js';
import { createProjectEgressResolver } from './project-egress-resolver.js';
import { inspectEgressTransport } from './project-egress-transport.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  serveProjectEgressHost,
  verifyProjectEgressServiceManager,
  verifyProjectEgressDockerHost,
} from './project-egress-host-service.js';
import { egressRelayPolicy } from './project-egress-relay-policy.js';
/** Experimental host entrypoint. Not installed or enabled by production setup. */
import { readFile } from 'node:fs/promises';
import { ProjectEgressHost, projectEgressBootstrapRules } from './project-egress-host.js';
import { applyProjectFenceRules, projectFenceTable } from './project-egress-fence.js';
import { listenProjectEgressHost } from './project-egress-host-control.js';
import {
  inspectEgressHostContainer,
  inspectEgressHostDirect,
  inspectEgressHostNetwork,
  openProjectEgressHostStore,
  projectEgressHostDocker,
} from './project-egress-host-runtime.js';

if (process.platform !== 'linux' || process.getuid?.() !== 0)
  throw new Error('Project egress host service requires a Linux host service account');
const mode = process.argv[2];
if (!['deny', 'restore', 'serve'].includes(mode ?? ''))
  throw new Error('Expected deny, restore or serve');
// Paths are host installation constants, not request-controlled configuration.
await applyProjectFenceRules(projectEgressBootstrapRules());
// ExecStopPost must fence even a corrupt registry or missing Docker daemon.
if (mode === 'deny') process.exit(0);
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
const policyStore =
  database === undefined ? unavailableEgressAuthority : new ProjectEgressStore(database);
const resolve =
  authority === undefined
    ? () => Promise.reject(new Error('Host DNS authority is not configured'))
    : createProjectEgressResolver({
        servers: authority.dnsServers,
        destinationAllowed: egressHostDestinationAllowed,
      });
const deadline = hostProjectDeadlineEnforcer();
const enforcement = createProjectEgressHostEnforcement({
  deadline,
  store: policyStore,
  directAuthority: (binding) => authority?.projectSponsors[binding.projectId] !== undefined,
  sponsor: (binding) => authority?.projectSponsors[binding.projectId] ?? '__unconfigured__',
  inspect: inspectEgressHostDirect,
  dependencies: {
    inspect: inspectProjectFenceAttachment,
    apply: applyProjectFenceRules,
    directTargetAllowed: (host) => Promise.resolve(authority?.directHosts.includes(host) === true),
    destinationAllowed: egressHostDestinationAllowed,
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
  },
});

const controller = new ProjectEgressHost(await store.load(), {
  ...(relayPolicy?.packetEnforcement === true
    ? { enforcement, bootId: (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim() }
    : {}),
  save: (state) => store.save(state),
  apply: applyProjectFenceRules,
  inspectNetwork: inspectEgressHostNetwork,
  inspectContainer: (binding, id, role, restoring) =>
    inspectEgressHostContainer(binding, id, role, relayPolicy, restoring),
  inspectTransport: (binding, ids) => {
    if (!relayPolicy) throw new Error('Relay host policy is not configured');
    return inspectEgressTransport(binding, ids, relayPolicy.codexSubpath !== undefined);
  },
  startContainer: async (id) => {
    await projectEgressHostDocker('container', 'start', id);
  },
  stopContainer: async (id) => {
    await projectEgressHostDocker('container', 'stop', '--time', '1', id);
  },
});
if (mode === 'restore') {
  await controller.restore(relayPolicy?.packetEnforcement === true);
  deadline.close();
  await database?.destroy();
} else {
  const service = await serveProjectEgressHost({
    restore: () => controller.restore(),
    deny: () => controller.shutdown(),
    verifyHost: async () => {
      const info: unknown = JSON.parse(
        await projectEgressHostDocker('info', '--format', '{{json .}}'),
      );
      verifyProjectEgressDockerHost(info);
    },
    revalidate: () => controller.revalidate(),
    listen: async () => {
      const token = (await readFile('/etc/verity-egress/control.key', 'utf8')).trim();
      return listenProjectEgressHost({ directory: '/run/verity-egress', token, controller });
    },
    notifyReady: async () => {
      if (!process.env.NOTIFY_SOCKET) throw new Error('Systemd readiness channel is required');
      await promisify(execFile)('/usr/bin/systemd-notify', ['--ready'], {
        timeout: 5000,
        env: { PATH: '/usr/bin:/bin', NOTIFY_SOCKET: process.env.NOTIFY_SOCKET },
      });
    },
  });
  const stop = () => {
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
