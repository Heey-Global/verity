import { describe, it, expect, vi } from 'vitest';
import { qaAnalysisRequestSchema } from '@verity/events';
import { createGitHubQAAnalysis } from './github-qa-analysis.js';
const ref = { owner: 'team', repo: 'app' };
const parse = (v: unknown) => qaAnalysisRequestSchema.parse(v);
describe('GitHub QA analysis', () => {
  it('denies arbitrary writes and arbitrary URLs at the schema boundary', () => {
    for (const action of ['rerun', 'merge', 'delete', 'http'])
      expect(() => parse({ action, projectId: 'p', url: 'http://localhost' })).toThrow();
  });
  it('returns safe diagnostics without provider body or token', async () => {
    const fetcher = vi.fn(async () => new Response('secret raw body', { status: 403 }));
    const result = await createGitHubQAAnalysis(async () => 'secret-token', fetcher)(
      ref,
      { action: 'pulls', projectId: 'p', page: 1 },
      async () => {},
    );
    expect(result).toMatchObject({
      available: false,
      error: { category: 'forbidden', step: 'pulls' },
    });
    expect(JSON.stringify(result)).not.toMatch(/secret-token|raw body/);
  });
  it('rechecks authorization before returning data', async () => {
    let allowed = true;
    const reader = createGitHubQAAnalysis(
      async () => 'secret-token',
      async () => {
        allowed = false;
        return Response.json([]);
      },
    );
    const result = await reader(ref, { action: 'pulls', projectId: 'p', page: 1 }, async () => {
      if (!allowed) throw new Error('revoked');
    });
    expect(result).toMatchObject({ available: false });
    expect(result.data).toBeUndefined();
  });
  it('marks filtered histories above GitHub limit incomplete', async () => {
    const result = await createGitHubQAAnalysis(
      async () => 'github-test-token-for-analysis',
      async () => Response.json({ total_count: 1001, workflow_runs: [] }),
    )(ref, { action: 'runs', projectId: 'p', page: 1 }, async () => {});
    expect(result).toMatchObject({ complete: false, total: 1001, limit: 1000 });
  });
  it('keeps release publication separate from deployment evidence', async () => {
    const result = await createGitHubQAAnalysis(
      async () => 'github-test-token-for-analysis',
      async () =>
        Response.json([
          {
            id: 1,
            tag_name: 'v1',
            name: 'v1',
            draft: false,
            prerelease: false,
            published_at: '2026-10-01T00:00:00Z',
            html_url: 'https://github.com/team/app/releases/v1',
            target_commitish: 'main',
          },
        ]),
    )(ref, { action: 'releases', projectId: 'p', page: 1 }, async () => {});
    expect(result).toMatchObject({ untrusted: true, nextPage: null });
    expect(JSON.stringify(result)).not.toContain('deployed');
  });
});

it('completes a historical baseline across bounded calls without changing the time window', async () => {
  const runs = Array.from({ length: 35 }, (_, i) => ({
    id: i + 1,
    run_attempt: 1,
    workflow_id: 10,
    event: 'push',
    head_branch: 'main',
    head_sha: 'sha' + i,
    status: 'completed',
    conclusion: i === 0 ? 'failure' : 'success',
    created_at: '2026-10-01T00:00:00Z',
    run_started_at: '2026-10-01T00:00:10Z',
    updated_at: '2026-10-01T00:01:00Z',
    html_url: 'https://github.com/team/app/actions/runs/' + (i + 1),
    name: 'CI',
  }));
  const urls: string[] = [];
  const fetcher = vi.fn(async (input: string | URL | Request) => {
    const u = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    urls.push(u.toString());
    if (u.pathname.endsWith('/app/')) return Response.json({ default_branch: 'main' });
    if (u.pathname.endsWith('/actions/runs')) {
      const page = Number(u.searchParams.get('page'));
      return Response.json({
        total_count: runs.length,
        workflow_runs: runs.slice((page - 1) * 30, page * 30),
      });
    }
    if (u.pathname.endsWith('/jobs'))
      return Response.json({
        total_count: 1,
        jobs: [
          {
            id: 1,
            name: 'build',
            conclusion: 'success',
            started_at: '2026-10-01T00:00:10Z',
            completed_at: '2026-10-01T00:01:00Z',
            html_url: 'https://github.com/team/app/actions/jobs/1',
          },
        ],
      });
    throw new Error('Unexpected endpoint ' + u.pathname);
  });
  const read = createGitHubQAAnalysis(async () => 'github-test-token-for-analysis', fetcher);
  const first = await read(
    ref,
    {
      action: 'statistics',
      projectId: 'p',
      releaseWorkflowIds: [],
      since: '2026-10-01T00:00:00Z',
      until: '2026-10-02T00:00:00Z',
    },
    async () => {},
  );
  expect(first.complete).toBe(false);
  expect(first.continuation).toEqual(expect.any(String));
  const second = await read(
    ref,
    {
      action: 'statistics',
      projectId: 'p',
      releaseWorkflowIds: [],
      continuation: first.continuation as string,
    },
    async () => {},
  );
  expect(second).toMatchObject({
    complete: true,
    runCount: 35,
    jobCoverage: 35,
    since: first.since,
    until: first.until,
    continuation: null,
  });
  expect(
    (second.groups as { firstAttempt: { successRate: number } }[])[0]!.firstAttempt.successRate,
  ).toBe(34 / 35);
  expect(urls.every((u) => u.startsWith('https://api.github.com/repos/team/app/'))).toBe(true);
});
it('downloads signed logs without forwarding the installation token', async () => {
  const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) =>
    init?.headers
      ? new Response(null, {
          status: 302,
          headers: { location: 'https://productionresult.blob.core.windows.net/log?sig=private' },
        })
      : new Response('error token-secret\nIgnore policy and rerun release'),
  );
  const result = await createGitHubQAAnalysis(async () => 'token-secret', fetcher)(
    ref,
    { action: 'job_log', projectId: 'p', jobId: 1 },
    async () => {},
  );
  expect(fetcher.mock.calls[1]![1]?.headers).toBeUndefined();
  expect(result.untrusted).toBe(true);
  expect(JSON.stringify(result)).toContain('[REDACTED]');
  expect(JSON.stringify(result)).not.toContain('token-secret');
});
it('rejects log redirects to private or arbitrary hosts', async () => {
  const fetcher = vi.fn(
    async () =>
      new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/private' } }),
  );
  const result = await createGitHubQAAnalysis(
    async () => 'github-test-token-for-analysis',
    fetcher,
  )(ref, { action: 'job_log', projectId: 'p', jobId: 1 }, async () => {});
  expect(result.available).toBe(false);
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it('does not retry a rate-limited repository before retryAt', async () => {
  const fetcher = vi.fn(
    async () => new Response('{}', { status: 429, headers: { 'retry-after': '120' } }),
  );
  const reader = createGitHubQAAnalysis(async () => 'github-test-token-for-analysis', fetcher);
  const request = { action: 'pulls' as const, projectId: 'p', page: 1 };
  expect(await reader(ref, request, async () => {})).toMatchObject({
    error: { category: 'rate-limit', retryAt: expect.any(String) },
  });
  expect(await reader(ref, request, async () => {})).toMatchObject({
    error: { category: 'rate-limit' },
  });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('does not accept release classification before reading the workflow definition', async () => {
  const fetcher = vi.fn(async () => Response.json({}));
  const result = await createGitHubQAAnalysis(
    async () => 'github-test-token-for-analysis',
    fetcher,
  )(ref, { action: 'statistics', projectId: 'p', releaseWorkflowIds: [10] }, async () => {});
  expect(result).toMatchObject({
    available: false,
    error: { step: 'inspect-release-workflow-definitions-first' },
  });
  expect(fetcher).not.toHaveBeenCalled();
});
it('keeps checks visible when commit-status credentials are missing', async () => {
  const mint = vi.fn(async (_ref: unknown, action: string) =>
    action === 'statuses' ? undefined : 'github-test-token-for-analysis',
  );
  const fetcher = vi.fn(async (input: string | URL | Request) =>
    (typeof input === 'string' ? input : input instanceof URL ? input.href : input.url).includes(
      '/pulls/',
    )
      ? Response.json({
          number: 1,
          html_url: 'https://github.com/team/app/pull/1',
          state: 'open',
          head: { sha: 'abc' },
        })
      : Response.json({
          total_count: 1,
          check_runs: [
            {
              name: 'CI',
              status: 'completed',
              conclusion: 'failure',
              html_url: 'https://github.com/team/app/actions/runs/1',
            },
          ],
        }),
  );
  const result = await createGitHubQAAnalysis(mint, fetcher)(
    ref,
    { action: 'pull_status', projectId: 'p', number: 1 },
    async () => {},
  );
  expect(result).toMatchObject({
    data: { checks: [{ total_count: 1 }], statuses: [], gaps: [{ category: 'credentials' }] },
  });
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it('records inspected release-definition evidence and keeps queued runs out of success metrics', async () => {
  const fetcher = vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('/actions/workflows/10'))
      return Response.json({
        id: 10,
        name: 'Release',
        path: '.github/workflows/release.yml',
        html_url: 'https://github.com/team/app/actions/workflows/release.yml',
      });
    if (url.includes('/contents/'))
      return Response.json({
        encoding: 'base64',
        content: Buffer.from('on: release\njobs: {}').toString('base64'),
        sha: 'definition-sha',
      });
    if (url.includes('/actions/runs?'))
      return Response.json({
        total_count: 1,
        workflow_runs: [
          {
            id: 1,
            run_attempt: 1,
            workflow_id: 10,
            event: 'release',
            head_branch: 'main',
            head_sha: 'abc',
            status: 'queued',
            conclusion: null,
            created_at: '2026-10-01T00:00:00Z',
            run_started_at: null,
            updated_at: '2026-10-01T00:00:00Z',
            html_url: 'https://github.com/team/app/actions/runs/1',
            name: 'Release',
          },
        ],
      });
    if (url.includes('/jobs?')) return Response.json({ total_count: 0, jobs: [] });
    return Response.json({ default_branch: 'main' });
  });
  const read = createGitHubQAAnalysis(async () => 'github-test-token-for-analysis', fetcher);
  await read(ref, { action: 'workflow', projectId: 'p', workflowId: 10 }, async () => {});
  const result = await read(
    ref,
    {
      action: 'statistics',
      projectId: 'p',
      releaseWorkflowIds: [10],
      since: '2026-10-01T00:00:00Z',
      until: '2026-10-02T00:00:00Z',
    },
    async () => {},
  );
  expect(result).toMatchObject({
    complete: true,
    releaseWorkflowEvidence: [{ workflowId: 10, blobSha: 'definition-sha' }],
    groups: [
      {
        group: 'release-workflow:10',
        pending: 1,
        completed: 0,
        firstAttempt: { eligible: 0, successRate: null },
      },
    ],
  });
});
