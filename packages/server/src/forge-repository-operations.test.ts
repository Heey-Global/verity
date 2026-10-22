// One contract, every code host: `verity-repo` promises agents the same
// behaviour on GitHub and Forgejo, so both implementations run the same cases
// against an in-memory forge that each fake translates into its own API.
import { describe, expect, it, vi } from 'vitest';

import type { ForgeRepositoryOperations } from './forge-provider.js';
import { ForgejoRequestError, ForgejoTransport } from './forgejo-transport.js';
import {
  createForgejoRepositoryOperations,
  withoutWipPrefix,
} from './forgejo-repository-operations.js';
import { createGitHubRepositoryOperations } from './github-repository-operations.js';
import type { HttpFetch } from './github.js';

interface Pull {
  number: number;
  title: string;
  state: 'open' | 'closed';
  merged: boolean;
  draft: boolean;
  head: string;
  headRepo: string;
  base: string;
  body: string;
  updated: string;
}
interface Issue {
  number: number;
  title: string;
  body: string;
  pull?: boolean;
}

interface Forge {
  pulls: Pull[];
  issues: Issue[];
  comments: { number: number; body: string }[];
  /** Write requests the fake received, as `METHOD path`. */
  writes: string[];
}

function emptyForge(): Forge {
  return {
    pulls: [
      {
        number: 1,
        title: 'Old attempt',
        state: 'closed',
        merged: false,
        draft: false,
        head: 'feat/7-search',
        headRepo: 'team/site',
        base: 'main',
        body: '',
        updated: '2026-01-01T00:00:00Z',
      },
      {
        number: 2,
        title: 'Fork change',
        state: 'open',
        merged: false,
        draft: false,
        head: 'feat/7-search',
        headRepo: 'someone/site',
        base: 'main',
        body: '',
        updated: '2026-03-01T00:00:00Z',
      },
    ],
    issues: [
      { number: 3, title: 'Search is slow', body: 'Details' },
      { number: 2, title: 'Fork change', body: '', pull: true },
    ],
    comments: [],
    writes: [],
  };
}

const project = { owner: 'team', repo: 'site' };

function forgejoFake(forge: Forge): ForgeRepositoryOperations {
  const transport = new ForgejoTransport('https://git.example.org', () => Promise.resolve('t'));
  const row = (pull: Pull) => ({
    number: pull.number,
    // Forgejo's only draft marker is the title.
    title: pull.draft ? `WIP: ${pull.title}` : pull.title,
    html_url: `https://git.example.org/team/site/pulls/${pull.number}`,
    state: pull.state,
    merged: pull.merged,
    body: pull.body,
    updated_at: pull.updated,
    head: { ref: pull.head, repo: { full_name: pull.headRepo } },
    base: { ref: pull.base },
  });
  vi.spyOn(transport, 'json').mockImplementation((path: string, method = 'GET', body?: unknown) => {
    const input = body as Record<string, string> | undefined;
    if (method !== 'GET') forge.writes.push(`${method} ${path}`);
    const base = '/repos/team/site';
    if (path === base) return Promise.resolve({ default_branch: 'main' });
    if (path === `${base}/pulls` && method === 'POST') {
      const pull: Pull = {
        number: forge.pulls.length + 10,
        title: withoutWipPrefix(input!.title!),
        state: 'open',
        merged: false,
        draft: /^\s*(wip:|\[wip\])/iu.test(input!.title!),
        head: input!.head!,
        headRepo: 'team/site',
        base: input!.base!,
        body: input!.body ?? '',
        updated: '2026-04-01T00:00:00Z',
      };
      forge.pulls.push(pull);
      return Promise.resolve(row(pull));
    }
    if (path.startsWith(`${base}/pulls?`))
      return Promise.resolve(path.includes('page=1') ? forge.pulls.map(row) : []);
    const pullMatch = /\/pulls\/(\d+)$/u.exec(path);
    if (pullMatch) {
      const pull = forge.pulls.find((entry) => entry.number === Number(pullMatch[1]));
      if (!pull) return Promise.reject(new ForgejoRequestError(404));
      if (method === 'PATCH') {
        pull.draft = /^\s*(wip:|\[wip\])/iu.test(input!.title!);
        pull.title = withoutWipPrefix(input!.title!);
      }
      return Promise.resolve(row(pull));
    }
    const commentMatch = /\/issues\/(\d+)\/comments$/u.exec(path);
    if (commentMatch) {
      forge.comments.push({ number: Number(commentMatch[1]), body: input!.body! });
      return Promise.resolve({ html_url: 'https://git.example.org/c/1' });
    }
    const issueMatch = /\/issues\/(\d+)$/u.exec(path);
    if (issueMatch) {
      const issue = forge.issues.find((entry) => entry.number === Number(issueMatch[1]));
      if (!issue) return Promise.reject(new ForgejoRequestError(404));
      return Promise.resolve({
        number: issue.number,
        title: issue.title,
        html_url: `https://git.example.org/team/site/issues/${issue.number}`,
        state: 'open',
        body: issue.body,
        labels: [{ name: 'bug' }],
        ...(issue.pull ? { pull_request: {} } : {}),
      });
    }
    return Promise.reject(new ForgejoRequestError(404));
  });
  return createForgejoRepositoryOperations(transport, project);
}

function githubFake(forge: Forge): ForgeRepositoryOperations {
  const row = (pull: Pull) => ({
    number: pull.number,
    node_id: `PR_${pull.number}`,
    title: pull.title,
    html_url: `https://github.com/team/site/pull/${pull.number}`,
    state: pull.state,
    merged_at: pull.merged ? '2026-01-02T00:00:00Z' : null,
    draft: pull.draft,
    body: pull.body,
    updated_at: pull.updated,
    head: { ref: pull.head, repo: { full_name: pull.headRepo } },
    base: { ref: pull.base },
  });
  const respond = (status: number, body: unknown) =>
    Promise.resolve({ ok: status < 300, status, json: () => Promise.resolve(body) });
  const fetch: HttpFetch = (url, init) => {
    const method = init?.method ?? 'GET';
    const path = url.replace('https://api.github.com', '');
    const input = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    if (method !== 'GET') forge.writes.push(`${method} ${path}`);
    const base = '/repos/team/site';
    if (path === base) return respond(200, { default_branch: 'main' });
    if (path === '/graphql') {
      const id = (input!.variables as { id: string }).id;
      const pull = forge.pulls.find((entry) => `PR_${entry.number}` === id);
      if (pull) pull.draft = false;
      return respond(200, { data: {} });
    }
    if (path === `${base}/pulls` && method === 'POST') {
      const pull: Pull = {
        number: forge.pulls.length + 10,
        title: input!.title as string,
        state: 'open',
        merged: false,
        draft: input!.draft === true,
        head: input!.head as string,
        headRepo: 'team/site',
        base: input!.base as string,
        body: (input!.body as string) ?? '',
        updated: '2026-04-01T00:00:00Z',
      };
      forge.pulls.push(pull);
      return respond(201, row(pull));
    }
    if (path.startsWith(`${base}/pulls?`)) {
      // GitHub filters by `owner:branch` itself; the fake leaves forks in to
      // prove the client does not trust that filter alone.
      return respond(200, forge.pulls.map(row));
    }
    const pullMatch = /\/pulls\/(\d+)$/u.exec(path);
    if (pullMatch) {
      const pull = forge.pulls.find((entry) => entry.number === Number(pullMatch[1]));
      return pull ? respond(200, row(pull)) : respond(404, { message: 'Not Found' });
    }
    const commentMatch = /\/issues\/(\d+)\/comments$/u.exec(path);
    if (commentMatch) {
      forge.comments.push({ number: Number(commentMatch[1]), body: input!.body as string });
      return respond(201, { html_url: 'https://github.com/c/1' });
    }
    const issueMatch = /\/issues\/(\d+)$/u.exec(path);
    if (issueMatch) {
      const issue = forge.issues.find((entry) => entry.number === Number(issueMatch[1]));
      if (!issue) return respond(404, { message: 'Not Found' });
      return respond(200, {
        number: issue.number,
        title: issue.title,
        html_url: `https://github.com/team/site/issues/${issue.number}`,
        state: 'open',
        body: issue.body,
        labels: [{ name: 'bug' }],
        ...(issue.pull ? { pull_request: {} } : {}),
      });
    }
    return respond(404, { message: 'Not Found' });
  };
  return createGitHubRepositoryOperations({ project, token: () => Promise.resolve('t'), fetch });
}

describe.each([
  ['Forgejo', forgejoFake],
  ['GitHub', githubFake],
] as const)('%s repository operations', (_host, make) => {
  it('opens ready pull requests only, even when asked for a draft title', async () => {
    const forge = emptyForge();
    const ops = make(forge);
    const opened = await ops.createPullRequest({
      head: 'feat/7-search',
      base: await ops.defaultBranch(),
      title: 'WIP: Add search',
      body: 'Closes #7',
    });
    expect(opened).toMatchObject({ draft: false, state: 'open', base: 'main', body: 'Closes #7' });
    expect(forge.pulls.at(-1)?.draft).toBe(false);
  });

  it("finds the branch's own pull request, open first, never a fork's", async () => {
    const forge = emptyForge();
    const ops = make(forge);
    expect(await ops.findPullRequest({ head: 'feat/7-search' })).toMatchObject({
      number: 1,
      state: 'closed',
    });
    await ops.createPullRequest({
      head: 'feat/7-search',
      base: 'main',
      title: 'Add search',
      body: '',
    });
    expect(await ops.findPullRequest({ head: 'feat/7-search' })).toMatchObject({ state: 'open' });
    expect(await ops.findPullRequest({ head: 'feat/none' })).toBeNull();
    expect(await ops.findPullRequest({ number: 99 })).toBeNull();
  });

  it('marks a draft ready and leaves a ready pull request untouched', async () => {
    const forge = emptyForge();
    forge.pulls.push({
      ...forge.pulls[0]!,
      number: 5,
      state: 'open',
      draft: true,
      title: 'Search',
    });
    const ops = make(forge);
    expect(await ops.markPullRequestReady(5)).toMatchObject({
      number: 5,
      draft: false,
      title: 'Search',
    });
    expect(forge.pulls.find((pull) => pull.number === 5)?.draft).toBe(false);
    const writes = forge.writes.length;
    expect(await ops.markPullRequestReady(5)).toMatchObject({ draft: false });
    expect(forge.writes).toHaveLength(writes);
  });

  it('reads issues but not pull requests through the issue view, and comments', async () => {
    const ops = make(emptyForge());
    expect(await ops.viewIssue(3)).toMatchObject({ title: 'Search is slow', labels: ['bug'] });
    expect(await ops.viewIssue(2)).toBeNull();
    expect(await ops.viewIssue(42)).toBeNull();
    const forge = emptyForge();
    await make(forge).commentOnIssue(3, 'On it');
    expect(forge.comments).toEqual([{ number: 3, body: 'On it' }]);
  });
});

it('strips every stacked Forgejo WIP prefix', () => {
  expect(withoutWipPrefix('WIP: [WIP] wip:  Add search')).toBe('Add search');
  expect(withoutWipPrefix('Wipe cache')).toBe('Wipe cache');
});
