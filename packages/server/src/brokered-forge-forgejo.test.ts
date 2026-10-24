import { expect, it, vi } from 'vitest';
import { createForgejoForgeAdapter } from './brokered-forge-forgejo.js';
import type { ForgeAction } from './brokered-forge-github.js';

const binding = {
  projectId: 'project',
  owner: 'owner',
  repo: 'repo',
  forgeConnectionId: 'first',
  containerGeneration: 'generation',
};
const signal = new AbortController().signal;
const actions = new Set<ForgeAction>([
  'git-read',
  'git-write',
  'pulls-write',
  'pulls-read',
  'issues-read',
]);
function fixture() {
  const credentials = vi.fn(() => Promise.resolve({ token: 'server-only-fixture', login: 'user' }));
  const adapter = createForgejoForgeAdapter({
    connectionId: 'first',
    baseUrl: 'https://forge.test:8443/prefix',
    customCaPem: 'ca-fixture',
    credentials,
  });
  return { adapter, credentials };
}
it('binds credentials to connection, repository, authority and reverse-proxy prefix', async () => {
  const { adapter, credentials } = fixture();
  const authorized = await adapter.authorize(
    {
      hostname: 'forge.test:8443',
      method: 'POST',
      path: '/prefix/api/v1/repos/owner/repo/pulls',
      body: Buffer.from('{}'),
    },
    binding,
    actions,
    signal,
  );
  expect(authorized.authorization).toBe('token server-only-fixture');
  expect(authorized.upstream).toEqual({
    hostname: 'forge.test',
    port: 8443,
    ca: 'ca-fixture',
    allowPrivateAddress: true,
  });
  for (const [host, path, connection] of [
    ['other.test:8443', '/prefix/api/v1/repos/owner/repo/pulls', 'first'],
    ['forge.test:8443', '/api/v1/repos/owner/repo/pulls', 'first'],
    ['forge.test:8443', '/prefix/api/v1/repos/owner/other/pulls', 'first'],
    ['forge.test:8443', '/prefix/api/v1/repos/owner/repo/pulls', 'second'],
  ])
    await expect(
      adapter.authorize(
        { hostname: host!, method: 'GET', path: path! },
        { ...binding, forgeConnectionId: connection! },
        actions,
        signal,
      ),
    ).rejects.toThrow('rejected');
  expect(credentials).toHaveBeenCalledOnce();
});
it('allows Git Smart HTTP only for the bound repository and granted action', async () => {
  const { adapter, credentials } = fixture();
  const request = {
    hostname: 'forge.test:8443',
    method: 'GET',
    path: '/prefix/owner/repo.git/info/refs?service=git-upload-pack',
  };
  const auth = await adapter.authorize(request, binding, actions, signal);
  expect(auth.action).toBe('git-read');
  expect(auth.authorization).toBe(
    `Basic ${Buffer.from('user:server-only-fixture').toString('base64')}`,
  );
  await expect(
    adapter.authorize(
      { ...request, path: request.path.replace('upload', 'receive') },
      binding,
      new Set(['git-read']),
      signal,
    ),
  ).rejects.toThrow();
  expect(credentials).toHaveBeenCalledOnce();
});
it('rejects traversal, credentials in query strings and unknown API methods before credential resolution', async () => {
  const { adapter, credentials } = fixture();
  for (const path of [
    '/prefix/api/v1/repos/owner/repo/../other/pulls',
    '/prefix/api/v1/repos/owner/repo/%2e%2e/pulls',
    '/prefix/api/v1/repos/owner/repo%2fother/pulls',
    '/prefix/api/v1/repos/owner/repo/pulls?sudo=admin',
    '/prefix/api/v1/repos/owner/repo/pulls?access_token=foreign',
    '/prefix/api/v1/repos/owner/repo/settings',
    '//other.test/prefix/api/v1/repos/owner/repo/pulls',
  ])
    await expect(
      adapter.authorize(
        { hostname: 'forge.test:8443', method: 'POST', path },
        binding,
        actions,
        signal,
      ),
    ).rejects.toThrow();
  expect(credentials).not.toHaveBeenCalled();
});
