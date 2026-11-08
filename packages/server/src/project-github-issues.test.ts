import { InMemoryEventBus, type Conductor } from '@verity/session';
import { createTestDb } from '@verity/store/testing';
import { createAuthTokenRegistry } from './auth.js';
import { buildServer } from './server.js';
import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import type { ProjectRecord } from '@verity/store';
import type { ProjectRepositoryRecord } from '@verity/store';
import {
  listProjectGitHubIssues,
  listProjectIssues,
  registerProjectGitHubIssueRoutes,
} from './project-github-issues.js';

const project = { id: 'p', owner: 'acme', repo: 'app', kind: 'github' } as ProjectRecord;
const raw = (number: number) => ({
  number,
  title: `Issue ${String(number)}`,
  html_url: `https://github.com/acme/app/issues/${String(number)}`,
  labels: [{ name: 'bug' }],
  assignees: [{ login: 'alice' }],
});

const repository = (overrides: Partial<ProjectRepositoryRecord>): ProjectRepositoryRecord => ({
  id: 'default:p',
  projectId: 'p',
  name: 'app',
  kind: 'github',
  owner: 'acme',
  repo: 'app',
  forgeConnectionId: null,
  defaultBranch: null,
  isDefault: false,
  removedAt: null,
  ...overrides,
});
const issue = (number: number) => ({
  number,
  title: `Issue ${String(number)}`,
  url: `https://example.test/${String(number)}`,
  labels: [],
  assignees: [],
});

describe('issues of every project repository', () => {
  const repositories = [
    repository({ id: 'default:p', isDefault: true }),
    repository({
      id: 'site',
      name: 'Website',
      kind: 'forgejo',
      owner: 'acme',
      repo: 'site',
      forgeConnectionId: 'forgejo-1',
    }),
    repository({ id: 'docs', name: 'Docs', owner: 'acme', repo: 'docs' }),
    repository({ id: 'local', name: 'Scratch', kind: 'local', owner: '', repo: '' }),
    repository({ id: 'gone', name: 'Old', owner: 'acme', repo: 'old', removedAt: new Date() }),
  ];
  const store = { listProjectRepositories: async () => repositories };

  it('asks each code host with the project bound to that repository', async () => {
    const list = vi.fn(async (bound: ProjectRecord) => ({
      connected: true,
      viewerLogin: bound.kind === 'forgejo' ? 'me' : null,
      issues: [issue(bound.repo.length)],
    }));
    const result = await listProjectIssues(store, project, list);
    expect(result.map((entry) => [entry.id, entry.kind, entry.status])).toEqual([
      ['default:p', 'github', 'ok'],
      ['site', 'forgejo', 'ok'],
      ['docs', 'github', 'ok'],
    ]);
    // A repository listed with the default repository's binding would show the
    // default's issues under another heading.
    // The connection decides whose credentials are sent; the default
    // repository's would reach the wrong host.
    expect(
      list.mock.calls.map(([bound]) => [
        bound.kind,
        bound.owner,
        bound.repo,
        bound.forgeConnectionId,
      ]),
    ).toEqual([
      ['github', 'acme', 'app', null],
      ['forgejo', 'acme', 'site', 'forgejo-1'],
      ['github', 'acme', 'docs', null],
    ]);
    expect(result[0]).toMatchObject({ name: 'acme/app', isDefault: true });
    expect(result[1]).toMatchObject({ name: 'Website', viewerLogin: 'me', issues: [issue(4)] });
  });

  it('marks only the failing or silent host unavailable', async () => {
    const list = vi.fn(async (bound: ProjectRecord) => {
      if (bound.repo === 'site') throw new Error('down');
      if (bound.repo === 'docs') return new Promise<never>(() => undefined);
      return { connected: true, viewerLogin: null, issues: [issue(1)] };
    });
    const onError = vi.fn<(repositoryId: string, error: unknown) => void>();
    const result = await listProjectIssues(store, project, list, 20, onError);
    expect(result.map((entry) => entry.status)).toEqual(['ok', 'unavailable', 'unavailable']);
    // The entry only says unavailable; the reason goes to the server's log.
    expect(onError.mock.calls.map(([id]) => id).sort()).toEqual(['docs', 'site']);
    expect(result[0]).toMatchObject({ issues: [issue(1)] });
  });

  // Reported as unavailable, a repository without credentials would offer a
  // retry that can never succeed; the old route hid it as disconnected.
  it('leaves out repositories the server has no credentials for', async () => {
    const list = vi.fn(async (bound: ProjectRecord) => ({
      connected: bound.repo !== 'site',
      viewerLogin: null,
      issues: [],
    }));
    const result = await listProjectIssues(store, project, list);
    expect(result.map((entry) => entry.id)).toEqual(['default:p', 'docs']);
    expect(await listProjectIssues(store, project, undefined)).toEqual([]);
  });
});

describe('project GitHub issues', () => {
  it('excludes pull requests and follows pages with repository-scoped credentials', async () => {
    const page = Array.from({ length: 100 }, (_, index) => ({
      ...raw(index + 1),
      pull_request: {},
    }));
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(page)))
      .mockResolvedValueOnce(new Response(JSON.stringify([raw(101)])));
    const mint = vi.fn().mockResolvedValue('test-token');
    expect(await listProjectGitHubIssues(project, mint, fetcher)).toEqual({
      connected: true,
      viewerLogin: null,
      issues: [
        {
          number: 101,
          title: 'Issue 101',
          url: 'https://github.com/acme/app/issues/101',
          labels: ['bug'],
          assignees: ['alice'],
        },
      ],
    });
    expect(mint).toHaveBeenCalledWith(project);
    expect(fetcher.mock.calls[1]?.[0]).toContain('page=2');
    expect(fetcher.mock.calls[0]?.[1]?.headers).toMatchObject({
      authorization: 'Bearer test-token',
    });
  });
  it('hides disconnected and local projects without a network request', async () => {
    const mint = vi.fn().mockResolvedValue(undefined);
    const fetcher = vi.fn<typeof fetch>();
    expect(await listProjectGitHubIssues(project, mint, fetcher)).toEqual({
      connected: false,
      viewerLogin: null,
      issues: [],
    });
    expect(await listProjectGitHubIssues({ ...project, kind: 'local' }, mint, fetcher)).toEqual({
      connected: false,
      viewerLogin: null,
      issues: [],
    });
    expect(mint).toHaveBeenCalledTimes(1);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('does not disguise a GitHub failure as an empty issue list', async () => {
    await expect(
      listProjectGitHubIssues(
        project,
        async () => 'test-token',
        vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 403 })),
      ),
    ).rejects.toThrow('Could not load GitHub issues');
  });
  it('checks project access before fetching private issue data', async () => {
    const app = Fastify();
    app.addHook('onRequest', async (request) => {
      request.localUserId = 'u';
    });
    const list = vi.fn().mockResolvedValue({ connected: true, viewerLogin: null, issues: [] });
    registerProjectGitHubIssueRoutes(app, {
      store: {
        getProject: async () => project,
        listReadableProjectIds: async () => [],
        listProjectRepositories: async () => [repository({ isDefault: true })],
      },
      list,
    });
    expect((await app.inject({ method: 'GET', url: '/projects/p/github/issues' })).statusCode).toBe(
      404,
    );
    expect((await app.inject({ method: 'GET', url: '/projects/p/issues' })).statusCode).toBe(404);
    expect(list).not.toHaveBeenCalled();
    await app.close();
  });
  // A local project has no code host; stray repository rows must not send its
  // request to one, as the default-repository route never did.
  it('lists no repositories for a local project', async () => {
    const app = Fastify();
    const list = vi.fn();
    registerProjectGitHubIssueRoutes(app, {
      store: {
        getProject: async () => ({ ...project, kind: 'local' }),
        listReadableProjectIds: async () => ['p'],
        listProjectRepositories: async () => [repository({ id: 'site', name: 'Website' })],
      },
      list,
    });
    expect((await app.inject({ method: 'GET', url: '/projects/p/issues' })).json()).toEqual({
      repositories: [],
    });
    expect(list).not.toHaveBeenCalled();
    await app.close();
  });
});

// Registering the handler without the paired route rule leaves project members
// blocked before the handler's own access check ever runs.
it('allows project readers through the paired auth gate and denies unrelated projects', async () => {
  const ctx = await createTestDb();
  const actual = await ctx.store.upsertProject({
    id: 'issues-project',
    owner: 'acme',
    repo: 'app',
    containerName: 'issues-project',
    state: 'active',
  });
  const registry = await createAuthTokenRegistry(ctx.store, { enabled: true });
  const token = await registry.mint('reader');
  vi.spyOn(ctx.store, 'isActiveAdministrator').mockResolvedValue(false);
  vi.spyOn(ctx.store, 'hasProjectPermission').mockImplementation(
    async (_userId, projectId, permission) => projectId === actual.id && permission === 'read',
  );
  vi.spyOn(ctx.store, 'listReadableProjectIds').mockResolvedValue([actual.id]);
  const list = vi.fn(async () => ({ connected: true, viewerLogin: null, issues: [] }));
  const app = buildServer({
    eventStore: ctx.store,
    bus: new InMemoryEventBus(),
    conductor: {} as Conductor,
    authRegistry: registry,
    listProjectGitHubIssues: list,
  });
  try {
    const headers = { authorization: `Bearer ${token.token}` };
    expect(
      (await app.inject({ url: `/projects/${actual.id}/github/issues`, headers })).statusCode,
    ).toBe(200);
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ id: actual.id }));
    list.mockClear();
    expect(
      (await app.inject({ url: '/projects/unrelated/github/issues', headers })).statusCode,
    ).toBe(403);
    expect(list).not.toHaveBeenCalled();
    const grouped = await app.inject({ url: `/projects/${actual.id}/issues`, headers });
    expect(grouped.statusCode).toBe(200);
    expect(grouped.json()).toMatchObject({
      repositories: [{ id: `default:${actual.id}`, status: 'ok', issues: [] }],
    });
    expect((await app.inject({ url: '/projects/unrelated/issues', headers })).statusCode).toBe(403);
  } finally {
    vi.restoreAllMocks();
    await app.close();
    await ctx.close();
  }
});
