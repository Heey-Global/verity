import type { LocalPreviewManager } from './local-preview-manager.js';
import type { PreviewShareManager } from './preview-share-manager.js';

/** Acquire both preview fences in lifecycle order. Capacity GC must skip busy
 * fences rather than holding the shared capacity request behind a preview. */
export function withPreviewStorageMutation<T>(
  projectId: string,
  mutation: () => Promise<T>,
  options: {
    local?: Pick<LocalPreviewManager, 'withProjectStorageMutation'> | undefined;
    public?: Pick<PreviewShareManager, 'withProjectStorageMutation'> | undefined;
    waitForIdle?: boolean;
  },
): Promise<T> {
  const barrier = { waitForIdle: options.waitForIdle ?? true };
  const runPublic = () =>
    options.public
      ? options.public.withProjectStorageMutation(projectId, mutation, barrier)
      : mutation();
  return options.local
    ? options.local.withProjectStorageMutation(projectId, runPublic, barrier)
    : runPublic();
}
