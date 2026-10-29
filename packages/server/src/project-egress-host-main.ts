/** Experimental host entrypoint. Not installed or enabled by production setup. */
import { readFile } from 'node:fs/promises';
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
const controller = new ProjectEgressHost(await store.load(), {
  save: (state) => store.save(state),
  apply: applyProjectFenceRules,
  inspectNetwork: inspectEgressHostNetwork,
  inspectContainer: inspectEgressHostContainer,
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
  const token = (await readFile('/etc/verity-egress/control.key', 'utf8')).trim();
  await listenProjectEgressHost({ directory: '/run/verity-egress', token, controller });
}
