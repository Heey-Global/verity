import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import type { ProjectRecord } from '@verity/store';
import {
  listProjectGitHubIssues,
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
      store: { getProject: async () => project, listReadableProjectIds: async () => [] },
      list,
    });
    expect((await app.inject({ method: 'GET', url: '/projects/p/github/issues' })).statusCode).toBe(
      404,
    );
    expect(list).not.toHaveBeenCalled();
    await app.close();
  });
});
