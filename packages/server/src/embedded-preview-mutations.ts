import type { LocalPreviewManager } from './local-preview-manager.js';
import type { PreviewShareManager } from './preview-share-manager.js';
import { withPreviewProjectMutation as mutatePreviewProject } from './preview-project-mutation.js';
import { withPreviewStorageMutation } from './preview-storage-mutation.js';

type MutationManagerMethods =
  'beginSessionMove' | 'retireProjectShares' | 'withProjectStorageMutation';

export function createEmbeddedPreviewMutations(managers: {
  local: () => Pick<LocalPreviewManager, MutationManagerMethods> | undefined;
  public: () => Pick<PreviewShareManager, MutationManagerMethods> | undefined;
}) {
  const withPreviewProjectMutation = async <T>(
    projectId: string,
    mutation: () => Promise<T>,
    beforeRetire?: () => Promise<void>,
  ): Promise<T> =>
    mutatePreviewProject(
      projectId,
      mutation,
      { local: managers.local(), public: managers.public() },
      beforeRetire,
    );
  const withStorageProjectMutation = async <T>(
    projectId: string,
    mutation: () => Promise<T>,
    options: { waitForIdle?: boolean } = {},
  ): Promise<T> =>
    withPreviewStorageMutation(projectId, mutation, {
      local: managers.local(),
      public: managers.public(),
      waitForIdle: options.waitForIdle ?? true,
    });
  return { withPreviewProjectMutation, withStorageProjectMutation };
}
