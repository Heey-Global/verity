import type { LocalPreviewManager } from './local-preview-manager.js';
import type { PreviewShareManager } from './preview-share-manager.js';

/** Drain creations under both fences before capturing or retiring either connector set. */
export async function withPreviewProjectMutation<T>(
  projectId: string,
  mutation: () => Promise<T>,
  managers: {
    local?: Pick<LocalPreviewManager, 'beginSessionMove' | 'retireProjectShares'> | undefined;
    public?: Pick<PreviewShareManager, 'beginSessionMove' | 'retireProjectShares'> | undefined;
  },
  beforeRetire?: () => Promise<void>,
): Promise<T> {
  const releaseLocal = await managers.local?.beginSessionMove(projectId);
  let releasePublic: (() => void) | undefined;
  try {
    releasePublic = await managers.public?.beginSessionMove(projectId);
    await beforeRetire?.();
    await managers.local?.retireProjectShares(projectId);
    await managers.public?.retireProjectShares(projectId);
    return await mutation();
  } finally {
    releasePublic?.();
    releaseLocal?.();
  }
}
