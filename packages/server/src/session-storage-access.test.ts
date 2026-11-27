import { describe, expect, it, vi } from 'vitest';
import { sessionStorageAccess } from './session-storage-access.js';

type Deps = Parameters<typeof sessionStorageAccess>[0];

function access(overrides: Partial<Deps> = {}) {
  const withStorageProjectMutation = vi.fn(async <T>(_id: string, run: () => Promise<T>) => run());
  const withSessionStorageMutation = vi.fn(async <T>(_id: string, run: () => Promise<T>) => run());
  const deps = {
    store: {
      getProject: async () => ({ id: 'p', state: 'active' }),
      listPublicPreviewShares: async () => [],
    },
    docker: {},
    provisioner: { withProjectExclusiveMutation: vi.fn() },
    withStorageProjectMutation,
    devServers: () => undefined,
    localPreviews: {
      list: () => [],
      listProject: () => [{}],
      withSessionStorageMutation,
    },
    preparedWorktreeImages: new Map(),
    defaultProjectImage: 'project:stable',
    maintenanceImages: undefined,
    projectTokenMint: async () => undefined,
    hostCloneRoot: '/clones',
    dockerBaseUrl: 'http://docker',
    dataVolume: undefined,
    dataVolumeRoot: undefined,
    ...overrides,
  } as unknown as Deps;
  return {
    storage: sessionStorageAccess(deps),
    withStorageProjectMutation,
    withSessionStorageMutation,
    deps,
  };
}

// The project storage mutation refuses while any session of the project has a
// preview, and the provisioner barrier while any has a turn. A session's own
// collection must use neither, or a busy project is never collected.
describe('session-scoped storage mutation', () => {
  it('fences only the collected session in a running project', async () => {
    const { storage, withStorageProjectMutation, withSessionStorageMutation, deps } = access();
    const operation = vi.fn(async () => {});
    await storage.mutateSession!('p', 's2', operation);
    expect(operation).toHaveBeenCalledOnce();
    expect(withSessionStorageMutation).toHaveBeenCalledWith('s2', expect.any(Function));
    expect(withStorageProjectMutation).not.toHaveBeenCalled();
    expect(deps.provisioner.withProjectExclusiveMutation).not.toHaveBeenCalled();
  });
  it('still refuses for a project-level public share and a sleeping project', async () => {
    const shared = access({
      store: {
        getProject: async () => ({ id: 'p', state: 'active' }),
        listPublicPreviewShares: async () => [{ state: 'active', sessionId: null }],
      } as unknown as Deps['store'],
    });
    await expect(shared.storage.mutateSession!('p', 's2', async () => {})).rejects.toThrow(
      'Public preview is active',
    );
    const sleeping = access({
      store: {
        getProject: async () => ({ id: 'p', state: 'sleeping' }),
        listPublicPreviewShares: async () => [],
      } as unknown as Deps['store'],
    });
    await expect(sleeping.storage.mutateSession!('p', 's2', async () => {})).rejects.toThrow(
      'not running',
    );
  });
});
