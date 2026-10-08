import type { BrokeredHttpStreamTransport } from './brokered-http-stream.js';
import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { createGhcrForgeAdapter } from './brokered-forge-ghcr.js';
import type { ForgeAction } from './brokered-forge-github.js';
const binding = { projectId: 'p', owner: 'acme', repo: 'app' };
const actions = new Set<ForgeAction>(['packages-read']);
function harness() {
  const mint = vi.fn(async () => 'private-registry-source');
  const transport = vi.fn<BrokeredHttpStreamTransport>(
    async () =>
      Object.assign(Readable.from([JSON.stringify({ token: 'upstream-registry-bearer' })]), {
        statusCode: 200,
        headers: {},
      }) as IncomingMessage,
  );
  const adapter = createGhcrForgeAdapter({
    packages: async (project) => (project === 'p' ? ['acme/app/server'] : []),
    mint,
    transport,
  });
  return { adapter, mint, transport };
}
describe('GHCR provider policy', () => {
  it.each([
    '/v2/acme/app/server/tags/list?n=1000',
    '/v2/acme/app/server/manifests/v1.56.0',
    '/v2/acme/app/server/blobs/sha256:' + 'a'.repeat(64),
  ])('uses a server-side scoped registry bearer: %s', async (path) => {
    const h = harness();
    const auth = await h.adapter.authorize(
      { hostname: 'ghcr.io', method: 'GET', path },
      binding,
      actions,
      AbortSignal.timeout(1000),
    );
    expect(auth.authorization).toBe('Bearer upstream-registry-bearer');
    expect(h.transport.mock.calls[0]?.[0]).toMatchObject({
      hostname: 'ghcr.io',
      path: '/token?service=ghcr.io&scope=repository%3Aacme%2Fapp%2Fserver%3Apull',
    });
  });
  it('returns only a capability response marker for a client token exchange', async () => {
    const h = harness();
    const auth = await h.adapter.authorize(
      {
        hostname: 'ghcr.io',
        method: 'GET',
        path: '/token?service=ghcr.io&scope=repository:acme/app/server:pull',
      },
      binding,
      actions,
      AbortSignal.timeout(1000),
    );
    expect(auth).toMatchObject({ registryTokenResponse: true, authorization: '', credentials: [] });
    expect(h.mint).not.toHaveBeenCalled();
  });
  it.each([
    ['GET', '/v2/acme/other/tags/list'],
    ['POST', '/v2/acme/app/server/blobs/uploads/'],
    ['GET', '/token?service=ghcr.io&scope=repository:acme/app/server:pull,push'],
    [
      'GET',
      '/token?service=ghcr.io&scope=repository:acme/app/server:pull&scope=repository:acme/other:pull',
    ],
    ['GET', '/v2/acme/app/server/../other/tags/list'],
  ])('rejects foreign packages and writes before minting: %s %s', async (method, path) => {
    const h = harness();
    await expect(
      h.adapter.authorize(
        { hostname: 'ghcr.io', method, path },
        binding,
        actions,
        AbortSignal.timeout(1000),
      ),
    ).rejects.toThrow();
    expect(h.mint).not.toHaveBeenCalled();
    expect(h.transport).not.toHaveBeenCalled();
  });
});
