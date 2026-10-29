import { constants } from 'node:fs';
import { dirname } from 'node:path';
import { egressRelayPolicy } from './project-egress-relay-policy.js';
/** Experimental host entrypoint. Not installed or enabled by production setup. */
import { readFile, lstat, realpath, open } from 'node:fs/promises';
import { ProjectEgressHost, projectEgressBootstrapRules } from './project-egress-host.js';
import { applyProjectFenceRules } from './project-egress-fence.js';
import { listenProjectEgressHost } from './project-egress-host-control.js';
import {
  inspectEgressHostContainer,
  inspectEgressHostNetwork,
  openProjectEgressHostStore,
  projectEgressHostDocker,
} from './project-egress-host-runtime.js';

if (process.platform !== 'linux' || process.getuid?.() !== 0)
  throw new Error('Project egress host service requires a Linux host service account');
const mode = process.argv[2];
if (!['restore', 'serve'].includes(mode ?? '')) throw new Error('Expected restore or serve');
// Paths are host installation constants, not request-controlled configuration.
await applyProjectFenceRules(projectEgressBootstrapRules());
const store = await openProjectEgressHostStore('/var/lib/verity-egress');
const policyPath = '/etc/verity-egress/relay.json';
const policyFile = await open(policyPath, constants.O_RDONLY | constants.O_NOFOLLOW).catch(
  (error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  },
);
let relayPolicy: import('./project-egress-relay-policy.js').EgressRelayPolicy | undefined;
if (policyFile) {
  try {
    const stat = await policyFile.stat();
    if (
      !stat.isFile() ||
      stat.uid !== 0 ||
      (stat.mode & 0o077) !== 0 ||
      stat.size > 8192 ||
      (await realpath(policyPath)) !== policyPath
    )
      throw new Error('Untrusted relay policy file');
    for (let path = dirname(policyPath); ; path = dirname(path)) {
      const parent = await lstat(path);
      if (
        !parent.isDirectory() ||
        parent.isSymbolicLink() ||
        parent.uid !== 0 ||
        (parent.mode & 0o022) !== 0
      )
        throw new Error('Untrusted relay policy directory');
      if (path === '/') break;
    }
    relayPolicy = egressRelayPolicy.parse(JSON.parse(await policyFile.readFile('utf8')));
  } finally {
    await policyFile.close();
  }
}

const controller = new ProjectEgressHost(await store.load(), {
  save: (state) => store.save(state),
  apply: applyProjectFenceRules,
  inspectNetwork: inspectEgressHostNetwork,
  inspectContainer: (binding, id, role) =>
    inspectEgressHostContainer(binding, id, role, relayPolicy),
  startContainer: async (id) => {
    await projectEgressHostDocker('container', 'start', id);
  },
  stopContainer: async (id) => {
    await projectEgressHostDocker('container', 'stop', '--time', '1', id);
  },
});
await controller.restore();
if (mode === 'serve') {
  const info = JSON.parse(await projectEgressHostDocker('info', '--format', '{{json .}}')) as {
    OSType?: string;
    LiveRestoreEnabled?: boolean;
    SecurityOptions?: string[];
  };
  if (
    info.OSType !== 'linux' ||
    info.LiveRestoreEnabled !== false ||
    info.SecurityOptions?.some((value) => value.includes('rootless'))
  )
    throw new Error('Unsupported project egress Docker host');
  await controller.revalidate();
  const token = (await readFile('/etc/verity-egress/control.key', 'utf8')).trim();
  await listenProjectEgressHost({ directory: '/run/verity-egress', token, controller });
}
