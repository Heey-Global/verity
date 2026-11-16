import { expect, it, vi } from 'vitest';
import { createGitHubForgeProvider } from './github-forge-provider.js';
import { createForgejoForgeProvider } from './forgejo-forge-provider.js';
import { ForgejoTransport } from './forgejo-transport.js';
import type { ForgePrService } from './forge-provider.js';
import type { HttpFetch } from './github.js';

const ref = { owner: 'owner', repo: 'repo' };
function github(offline: boolean): ForgePrService {
  const mint = async () => 'fixture';
  const fetch = vi.fn<HttpFetch>(async (url) => {
    const failed = offline || url.includes('owner%3Abroken');
    return {
      ok: !failed,
      status: failed ? 500 : 200,
      json: async () =>
        url.includes('/pulls?')
          ? [{ number: 1, state: 'open' }]
          : { mergeable: true, mergeable_state: 'clean' },
    };
  });
  return createGitHubForgeProvider({
    projectTokenMint: mint,
    issuesTokenMint: mint,
    installationToken: mint,
    fetch,
  }).repositoryPrService!(ref);
}

function forgejo(offline: boolean): ForgePrService {
  const transport = new ForgejoTransport('https://forge.test', async () => 'fixture');
  let lists = 0;
  vi.spyOn(transport, 'json').mockImplementation(async (path) => {
    if (offline) throw new Error('offline');
    if (path.includes('/pulls?')) {
      if (!path.includes('page=1')) return [];
      if (++lists === 2) throw new Error('one observation failed');
      return [
        {
          number: 1,
          title: 'Change',
          html_url: 'https://forge.test/1',
          state: 'open',
          merged: false,
          head: { ref: 'good', sha: 'head', repo: { full_name: 'owner/repo' } },
          base: { ref: 'main', sha: 'base' },
        },
      ];
    }
    if (path.includes('/actions/')) return { workflow_runs: [] };
    return [];
  });
  return createForgejoForgeProvider({
    transport,
    token: async () => 'fixture',
    identityFor: () => async () => ref,
  }).repositoryPrService!(ref);
}

it.each([
  { name: 'GitHub', create: github },
  { name: 'Forgejo', create: forgejo },
])('$name preserves successful branches in a mixed observation', async ({ create }) => {
  expect(await create(false).prStatusForBranches(['good', 'broken'])).toMatchObject({
    number: 1,
    phase: 'open',
  });
});

it.each([
  { name: 'GitHub', create: github },
  { name: 'Forgejo', create: forgejo },
])('$name keeps best-effort APIs non-throwing during an outage', async ({ create }) => {
  const service = create(true);
  expect(await service.prForBranch('good')).toBeNull();
  expect(await service.prStatusForBranches(['good', 'broken'])).toBeNull();
});
