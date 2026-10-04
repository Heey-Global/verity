import type { LocalPreviewShare } from './api.js';

/** Check the allocated edge, so a different service on a stale port cannot pass. */
export async function localPreviewReachable(
  share: Pick<LocalPreviewShare, 'id' | 'url'>,
  fetcher: typeof fetch = fetch,
  timeoutMs = 2000,
): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(new URL('/__verity/health', share.url), {
      signal: controller.signal,
      cache: 'no-store',
    });
    if (!response.ok) return false;
    const body: unknown = await response.json();
    return (
      typeof body === 'object' && body !== null && 'shareId' in body && body.shareId === share.id
    );
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}
