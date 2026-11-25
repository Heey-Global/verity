import type { ManagedDevServerInstanceRecord, ProjectRecord } from '@verity/store';
import { expect, it, vi } from 'vitest';

import type { PreviewShareManagerOptions } from './preview-share-manager.js';
import { assertManagedConnectorTarget } from './preview-target-activity.js';

const project = { id: 'p1', containerName: 'sandbox-shared' } as ProjectRecord;
const share = {
  projectId: 'p1',
  sessionId: 's1',
  managedInstanceId: 'instance',
  targetPort: 4100,
};

function options(instance: Partial<ManagedDevServerInstanceRecord>, listenerPort = 4100) {
  const current = {
    id: 'instance',
    projectId: 'p1',
    sessionId: 's1',
    state: 'running',
    sandboxPort: 4100,
    lastRunUserId: 'lena',
    lastRunSecretBindings: [],
    ...instance,
  } as unknown as ManagedDevServerInstanceRecord;
  return {
    store: {
      getProject: async () => project,
      managedDevServers: { getInstance: async () => current },
    },
    sandboxFor: async (_project: ProjectRecord, userId: string | null) => ({
      containerName: `sandbox-${userId}`,
      networkName: 'preview-net',
    }),
    listListeningProcesses: vi.fn(async () => [
      { instanceId: 'instance', port: listenerPort, bind: 'any' },
    ]),
  } as unknown as PreviewShareManagerOptions;
}

// The connector spec names a sandbox and port captured before Docker created it.
// If the instance restarted elsewhere meanwhile, a connector started on the
// strength of its Doppler authority alone would forward public traffic to
// whatever now listens at the old address.
it('starts a managed connector only at the address its instance still serves', async () => {
  await expect(
    assertManagedConnectorTarget(options({}), share, 'sandbox-lena'),
  ).resolves.toBeUndefined();
  for (const [changed, target] of [
    [options({ sandboxPort: 4101 }), 'sandbox-lena'],
    [options({ lastRunUserId: 'mia' }), 'sandbox-lena'],
    [options({}, 4101), 'sandbox-lena'],
    [options({ state: 'starting' }), 'sandbox-lena'],
  ] as const)
    await expect(assertManagedConnectorTarget(changed, share, target)).rejects.toThrow();
});

it('leaves connectors without a managed instance to their own checks', async () => {
  const unused = options({});
  await expect(
    assertManagedConnectorTarget(unused, { ...share, managedInstanceId: null }, 'any'),
  ).resolves.toBeUndefined();
  expect(unused.listListeningProcesses).not.toHaveBeenCalled();
});
