import { expect, it } from 'vitest';
import { startOfflinePreviewServer } from './offline-server.js';

it('serves an uncached offline page for every path without a sandbox target', async () => {
  const server = await startOfflinePreviewServer();
  try {
    const response = await fetch(`${server.origin}/a/deep/link`);
    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).toContain('Currently offline');
  } finally {
    await server.close();
  }
});
