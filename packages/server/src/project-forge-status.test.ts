import { afterEach, expect, it, vi } from 'vitest';
import type { ProjectRecord } from '@verity/store';
import { createForgejoForgeProvider } from './forgejo-forge-provider.js';
import { createGitHubForgeProvider } from './github-forge-provider.js';
import type { HttpFetch } from './github.js';
import { ForgejoTransport } from './forgejo-transport.js';
import { createProjectForgeStatusReader } from './project-forge-status.js';

afterEach(() => vi.useRealTimers());

function fixture() {
  let credential = 'fixture-a';
  const transport = new ForgejoTransport('https://forge.test', async () => credential);
  const json = vi.spyOn(transport, 'json').mockImplementation(async (path) => {
    if (path.includes('/pulls?')) {
      return path.includes('page=1')
        ? Array.from({ length: 7 }, (_, index) => ({
            number: index + 1,
            head: { ref: `old-${index}`, repo: { full_name: 'owner/repo' } },
          }))
        : [];
    }
    return [];
  });
  let provider = createForgejoForgeProvider({
    transport,
    token: async () => credential,
    identityFor: () => async () => ({ owner: 'owner', repo: 'repo' }),
  });
  const project = {
    id: 'project',
    kind: 'forgejo',
    owner: 'owner',
    repo: 'repo',
    forgeConnectionId: 'forge',
  } as ProjectRecord;
  return {
    reader: createProjectForgeStatusReader(async () => provider),
    project,
    json,
    rotate: () => {
      credential = 'fixture-b';
    },
    replaceProvider: () => {
      provider = { ...provider };
    },
  };
}

it('shares a bound repository snapshot across sequential session branch checks', async () => {
  const { reader, project, json } = fixture();
  for (let index = 0; index < 27; index++) {
    expect(await reader.readProjectStatus(project, `branch-${index}`)).toBeNull();
  }
  expect(json).toHaveBeenCalledTimes(2);
});

it('shares concurrent readers but separates repository and connection bindings', async () => {
  const { reader, project, json } = fixture();
  await Promise.all(
    Array.from({ length: 27 }, (_, index) =>
      reader.readProjectStatus({ ...project, id: `session-project-${index}` }, `branch-${index}`),
    ),
  );
  expect(json).toHaveBeenCalledTimes(2);
  await reader.readProjectStatus({ ...project, repo: 'other' }, 'branch-0');
  await reader.readProjectStatus({ ...project, forgeConnectionId: 'other' }, 'branch-0');
  expect(json).toHaveBeenCalledTimes(6);
});

it('starts a fresh provider snapshot immediately after mutation or credential rotation', async () => {
  const { reader, project, json, rotate } = fixture();
  await reader.readProjectStatus(project, 'branch');
  json.mockRejectedValueOnce(new Error('offline'));
  reader.invalidateProjectStatus(project.id);
  await reader.readProjectStatus(project, 'branch');
  expect(json).toHaveBeenCalledTimes(3);
  rotate();
  await reader.readProjectStatus(project, 'branch');
  expect(json).toHaveBeenCalledTimes(5);
});

it('does not invalidate an additional repository in place of the default repository', async () => {
  const { reader, project, json } = fixture();
  await reader.readProjectStatus(project, 'branch');
  await reader.readProjectStatus({ ...project, repo: 'additional' }, 'branch', false);
  reader.invalidateProjectStatus(project.id);
  await reader.readProjectStatus(project, 'branch');
  await reader.readProjectStatus({ ...project, repo: 'additional' }, 'branch', false);
  expect(json).toHaveBeenCalledTimes(6);
});

it('does not reuse observations after connection configuration changes with the same token', async () => {
  const { reader, project, json, replaceProvider } = fixture();
  await reader.readProjectStatus(project, 'branch');
  replaceProvider();
  await reader.readProjectStatus(project, 'branch');
  expect(json).toHaveBeenCalledTimes(4);
});

it('keeps healthy GitHub PRs without CI fresh through the production reader', async () => {
  vi.useFakeTimers();
  const fetch = vi.fn<HttpFetch>(async (url) => ({
    ok: true,
    status: 200,
    json: async () =>
      url.includes('/check-runs')
        ? { check_runs: [], total_count: 0 }
        : url.includes('/status?')
          ? { statuses: [] }
          : url.includes('/pulls?')
            ? [{ number: 1, state: 'open', head: { sha: 'head' } }]
            : { mergeable: true, mergeable_state: 'clean' },
  }));
  const mint = async () => 'fixture';
  const provider = createGitHubForgeProvider({
    projectTokenMint: mint,
    issuesTokenMint: mint,
    installationToken: mint,
    fetch,
  });
  const reader = createProjectForgeStatusReader(async () => provider);
  const project = { id: 'github', kind: 'github', owner: 'owner', repo: 'repo' } as ProjectRecord;
  for (let round = 0; round < 4; round++) {
    expect(await reader.readProjectStatus(project, 'branch')).toMatchObject({
      number: 1,
      pipeline: 'unknown',
      checks: { total: 0 },
    });
    expect(fetch).toHaveBeenCalledTimes((round + 1) * 4);
    await vi.advanceTimersByTimeAsync(15_001);
  }
});
