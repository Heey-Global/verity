import { describe, expect, it, vi } from 'vitest';
import type { GitOutput } from './branches.js';
import {
  createGhTokenReader,
  createGitHubIssueService,
  createGitHubPrService,
  createGitHubReleaseService,
  openPullRequest,
  parseGitHubRemote,
  type HttpFetch,
  type HttpResponse,
} from './github.js';

describe('parseGitHubRemote', () => {
  it('parses every common GitHub remote form to { owner, repo }', () => {
    const want = { owner: 'Example-Org', repo: 'Example-Repo' };
    expect(parseGitHubRemote('git@github.com:Example-Org/Example-Repo.git')).toEqual(want);
    expect(parseGitHubRemote('git@github.com:Example-Org/Example-Repo')).toEqual(want);
    expect(parseGitHubRemote('https://github.com/Example-Org/Example-Repo.git')).toEqual(want);
    expect(parseGitHubRemote('https://github.com/Example-Org/Example-Repo')).toEqual(want);
    expect(parseGitHubRemote('ssh://git@github.com/Example-Org/Example-Repo.git')).toEqual(want);
    expect(parseGitHubRemote('https://github.com/Example-Org/Example-Repo/')).toEqual(want); // trailing /
  });

  it('skips an embedded credential and never returns it', () => {
    const got = parseGitHubRemote(
      'https://x-access-token:ghs_SECRET@github.com/Example-Org/Example-Repo.git',
    );
    expect(got).toEqual({ owner: 'Example-Org', repo: 'Example-Repo' });
    expect(JSON.stringify(got)).not.toContain('SECRET');
  });

  it('returns null for a non-GitHub or unparseable remote', () => {
    expect(parseGitHubRemote('git@gitlab.com:o/r.git')).toBeNull();
    expect(parseGitHubRemote('https://example.com/o/r')).toBeNull();
    expect(parseGitHubRemote('')).toBeNull();
    expect(parseGitHubRemote('not a url')).toBeNull();
  });

  it('rejects a look-alike host (substring / suffix) — the host must be exact', () => {
    expect(parseGitHubRemote('git@evilgithub.com:o/r.git')).toBeNull();
    expect(parseGitHubRemote('https://notgithub.com/o/r')).toBeNull();
    expect(parseGitHubRemote('https://github.com.evil.com/o/r')).toBeNull();
  });
});

const ok = (body: unknown): HttpResponse => ({
  ok: true,
  status: 200,
  json: () => Promise.resolve(body),
});
const okWithEtag = (body: unknown, etag: string): HttpResponse => ({
  ...ok(body),
  headers: { get: (name) => (name.toLowerCase() === 'etag' ? etag : null) },
});
const notModified = (): HttpResponse => ({
  ok: false,
  status: 304,
  json: () => Promise.resolve({}),
});
const fail = (status: number): HttpResponse => ({
  ok: false,
  status,
  json: () => Promise.resolve({}),
});

/** A fetch fake that returns the queued responses in order (repeating the last),
 * recording each url + headers. A queued thunk that throws models a network error. */
function fakeFetch(...responses: (HttpResponse | (() => Promise<HttpResponse>))[]): {
  fetch: HttpFetch;
  calls: {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    signal?: AbortSignal;
    body?: string;
  }[];
} {
  const calls: {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    signal?: AbortSignal;
    body?: string;
  }[] = [];
  let i = 0;
  const fetch: HttpFetch = (url, init) => {
    calls.push({
      url,
      ...(init?.method ? { method: init.method } : {}),
      ...(init?.headers ? { headers: init.headers } : {}),
      ...(init?.signal ? { signal: init.signal } : {}),
      ...(init?.body ? { body: init.body } : {}),
    });
    const r = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return typeof r === 'function' ? r() : Promise.resolve(r as HttpResponse);
  };
  return { fetch, calls };
}

const githubRemote: GitOutput = () =>
  Promise.resolve('git@github.com:Example-Org/Example-Repo.git\n');

describe('createGitHubPrService', () => {
  it('returns the open PR number for a branch, with the right query + auth header', async () => {
    const { fetch, calls } = fakeFetch(ok([{ number: 119 }]));
    const svc = createGitHubPrService({ repoDir: '/r', token: 'tok', git: githubRemote, fetch });

    expect(await svc.prForBranch('feat/122-x')).toBe(119);
    expect(calls[0]?.url).toBe(
      'https://api.github.com/repos/Example-Org/Example-Repo/pulls' +
        '?head=Example-Org%3Afeat%2F122-x&state=all&sort=updated&direction=desc&per_page=1',
    );
    expect(calls[0]?.headers?.Authorization).toBe('Bearer tok');
    // A timeout signal is passed so a hung connection can't stall the endpoint.
    expect(calls[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('returns null when there is no open PR for the branch', async () => {
    const { fetch } = fakeFetch(ok([]));
    const svc = createGitHubPrService({ repoDir: '/r', token: 'tok', git: githubRemote, fetch });
    expect(await svc.prForBranch('feat/122-x')).toBeNull();
  });

  it('returns compact PR status with aggregate check counts', async () => {
    const { fetch, calls } = fakeFetch(
      ok([
        {
          number: 119,
          state: 'open',
          title: 'Ship the footer strip',
          html_url: 'https://github.com/Example-Org/Example-Repo/pull/119',
          head: { sha: 'abc123' },
        },
      ]),
      ok({
        check_runs: [
          { status: 'completed', conclusion: 'success' },
          { status: 'completed', conclusion: 'failure' },
          { status: 'in_progress', conclusion: null },
        ],
      }),
      ok({ statuses: [] }),
    );
    const svc = createGitHubPrService({ repoDir: '/r', token: 'tok', git: githubRemote, fetch });

    expect(await svc.prStatusForBranch('feat/122-x')).toEqual({
      number: 119,
      title: 'Ship the footer strip',
      url: 'https://github.com/Example-Org/Example-Repo/pull/119',
      phase: 'open',
      headSha: 'abc123',
      // A failed check surfaces as 'failure' immediately, even while a job is still
      // in progress (fail-fast) — it must not read as 'running'. mergeability is not
      // queried for a non-green pipeline, so mergeable is unknown (null).
      pipeline: 'failure',
      checks: { completed: 2, total: 3, successful: 1, failed: 1, pending: 1 },
      mergeable: null,
    });
    expect(calls[1]?.url).toBe(
      'https://api.github.com/repos/Example-Org/Example-Repo/commits/abc123/check-runs?per_page=100',
    );
    // Legacy commit statuses are read alongside check-runs so a status-only failure
    // can't hide behind green check-runs.
    expect(calls[2]?.url).toBe(
      'https://api.github.com/repos/Example-Org/Example-Repo/commits/abc123/status?per_page=100',
    );
  });

  it('reports a failed commit status even when every check-run is green', async () => {
    const { fetch } = fakeFetch(
      ok([
        {
          number: 122,
          state: 'open',
          title: 'External CI',
          html_url: 'https://github.com/Example-Org/Example-Repo/pull/122',
          head: { sha: 'abc123' },
        },
      ]),
      ok({ check_runs: [{ status: 'completed', conclusion: 'success' }] }),
      ok({ statuses: [{ state: 'success' }, { state: 'failure' }] }),
    );
    const svc = createGitHubPrService({ repoDir: '/r', token: 'tok', git: githubRemote, fetch });

    expect(await svc.prStatusForBranch('feat/ext')).toMatchObject({
      pipeline: 'failure',
      checks: { completed: 3, total: 3, successful: 2, failed: 1, pending: 0 },
      mergeable: null,
    });
  });

  it('keeps the PR status visible when GitHub App tokens cannot read legacy commit statuses', async () => {
    const { fetch } = fakeFetch(
      ok([
        {
          number: 125,
          state: 'open',
          title: 'App-token status access',
          html_url: 'https://github.com/Example-Org/Example-Repo/pull/125',
          head: { sha: 'abc123' },
        },
      ]),
      ok({ check_runs: [{ status: 'completed', conclusion: 'success' }] }),
      fail(403),
      ok({ mergeable: true }),
    );
    const svc = createGitHubPrService({ repoDir: '/r', token: 'tok', git: githubRemote, fetch });

    expect(await svc.prStatusForBranch('feat/app-token')).toMatchObject({
      number: 125,
      phase: 'open',
      pipeline: 'success',
      checks: { completed: 1, total: 1, successful: 1, failed: 0, pending: 0 },
      mergeable: true,
    });
  });

  it('reports running while a commit status is still pending', async () => {
    const { fetch } = fakeFetch(
      ok([
        {
          number: 123,
          state: 'open',
          title: 'External CI pending',
          html_url: 'https://github.com/Example-Org/Example-Repo/pull/123',
          head: { sha: 'abc123' },
        },
      ]),
      ok({ check_runs: [{ status: 'completed', conclusion: 'success' }] }),
      ok({ statuses: [{ state: 'pending' }] }),
    );
    const svc = createGitHubPrService({ repoDir: '/r', token: 'tok', git: githubRemote, fetch });

    expect(await svc.prStatusForBranch('feat/ext')).toMatchObject({
      pipeline: 'running',
      checks: { completed: 1, total: 2, successful: 1, failed: 0, pending: 1 },
    });
  });

  it('uses GitHub mergeability for open PRs whose checks passed', async () => {
    const { fetch, calls } = fakeFetch(
      ok([
        {
          number: 121,
          state: 'open',
          title: 'Resolve conflicts',
          html_url: 'https://github.com/Example-Org/Example-Repo/pull/121',
          head: { sha: 'abc123' },
        },
      ]),
      ok({ check_runs: [{ status: 'completed', conclusion: 'success' }] }),
      ok({ statuses: [] }),
      ok({ mergeable: false }),
    );
    const svc = createGitHubPrService({ repoDir: '/r', token: 'tok', git: githubRemote, fetch });

    expect(await svc.prStatusForBranch('fix/conflict')).toMatchObject({
      number: 121,
      phase: 'open',
      pipeline: 'success',
      mergeable: false,
    });
    // [0] pulls list, [1] check-runs, [2] commit status, [3] PR mergeability detail.
    expect(calls[3]?.url).toBe('https://api.github.com/repos/Example-Org/Example-Repo/pulls/121');
  });

  it('reports unknown (null) mergeability while GitHub is still computing it', async () => {
    // GitHub returns `mergeable: null` for a few seconds after any push while it runs
    // the merge check. That must stay `null` (unknown), NOT be coerced to `false` —
    // a false here flashed a just-fixed, now-green PR red as "merge blocked".
    const { fetch } = fakeFetch(
      ok([
        {
          number: 121,
          state: 'open',
          title: 'Resolve conflicts',
          html_url: 'https://github.com/Example-Org/Example-Repo/pull/121',
          head: { sha: 'abc123' },
        },
      ]),
      ok({ check_runs: [{ status: 'completed', conclusion: 'success' }] }),
      ok({ statuses: [] }),
      ok({ mergeable: null }),
    );
    const svc = createGitHubPrService({ repoDir: '/r', token: 'tok', git: githubRemote, fetch });

    expect(await svc.prStatusForBranch('fix/conflict')).toMatchObject({
      pipeline: 'success',
      mergeable: null,
    });
  });

  it('detects a conflicting PR that GitHub never started any checks for', async () => {
    // The conflict trap: with a dirty PR GitHub builds no merge ref, so the
    // `pull_request` workflows never start and the PR reports ZERO checks. Without
    // the mergeability call on the no-checks path the bar could only say "status
    // unavailable" and nothing could react to the conflict.
    const { fetch, calls } = fakeFetch(
      ok([
        {
          number: 1325,
          state: 'open',
          title: 'fix(broker): hold exec',
          html_url: 'https://github.com/Example-Org/Example-Repo/pull/1325',
          head: { sha: 'abc123' },
          base: { ref: 'main', sha: 'base789' },
        },
      ]),
      ok({ check_runs: [] }),
      ok({ statuses: [] }),
      ok({ mergeable: false, mergeable_state: 'dirty' }),
    );
    const svc = createGitHubPrService({ repoDir: '/r', token: 'tok', git: githubRemote, fetch });

    expect(await svc.prStatusForBranch('fix/broker-exec')).toEqual({
      number: 1325,
      title: 'fix(broker): hold exec',
      url: 'https://github.com/Example-Org/Example-Repo/pull/1325',
      phase: 'open',
      headSha: 'abc123',
      pipeline: 'unknown',
      checks: { completed: 0, total: 0, successful: 0, failed: 0, pending: 0 },
      mergeable: false,
      mergeState: 'dirty',
      baseRef: 'main',
      // Carried so the repair automation can key on the head/base PAIR: the base
      // moving is what introduces a conflict without the head changing.
      baseSha: 'base789',
    });
    expect(calls[3]?.url).toBe('https://api.github.com/repos/Example-Org/Example-Repo/pulls/1325');
  });

  it('detects a conflicting PR whose push-triggered checks are failing', async () => {
    // A branch with `on: push` workflows keeps reporting checks while it conflicts,
    // because those runs use the branch head and need no merge ref. That is the only
    // way a PR is red AND dirty at once, and it is why the mergeability call cannot be
    // limited to green/checkless PRs: without it the conflict hides behind a CI
    // failure the agent cannot fix without merging the base in first, and the
    // conflict-before-CI repair precedence would never be reachable.
    const { fetch, calls } = fakeFetch(
      ok([
        {
          number: 1332,
          state: 'open',
          title: 'feat(push): branch workflow',
          html_url: 'https://github.com/Example-Org/Example-Repo/pull/1332',
          head: { sha: 'redsha1' },
          base: { ref: 'main', sha: 'base789' },
        },
      ]),
      ok({ check_runs: [{ status: 'completed', conclusion: 'failure' }] }),
      ok({ statuses: [] }),
      ok({ mergeable: false, mergeable_state: 'dirty' }),
    );
    const svc = createGitHubPrService({ repoDir: '/r', token: 'tok', git: githubRemote, fetch });

    expect(await svc.prStatusForBranch('feat/push-checks')).toMatchObject({
      pipeline: 'failure',
      mergeable: false,
      mergeState: 'dirty',
      baseRef: 'main',
      baseSha: 'base789',
    });
    expect(calls[3]?.url).toBe('https://api.github.com/repos/Example-Org/Example-Repo/pulls/1332');
  });

  it('skips the mergeability call while checks are running', async () => {
    // The API-saving rule: mergeability is only worth a request once the pipeline has
    // SETTLED. Running is the state a busy PR polls in most often, nothing can act on
    // a conflict until the checks land anyway, and the poll right after they do picks
    // it up — so this is the one open-PR state that costs no extra request.
    const { fetch, calls } = fakeFetch(
      ok([
        {
          number: 126,
          state: 'open',
          title: 'Still running',
          html_url: 'https://github.com/Example-Org/Example-Repo/pull/126',
          head: { sha: 'abc123' },
          base: { ref: 'main' },
        },
      ]),
      ok({ check_runs: [{ status: 'in_progress', conclusion: null }] }),
      ok({ statuses: [] }),
    );
    const svc = createGitHubPrService({ repoDir: '/r', token: 'tok', git: githubRemote, fetch });

    expect(await svc.prStatusForBranch('feat/running')).toMatchObject({
      pipeline: 'running',
      mergeable: null,
      baseRef: 'main',
    });
    expect(await svc.prStatusForBranch('feat/running')).not.toHaveProperty('mergeState');
    expect(calls).toHaveLength(3);
  });

  it('omits mergeState while GitHub is still computing it', async () => {
    const { fetch } = fakeFetch(
      ok([
        {
          number: 127,
          state: 'open',
          title: 'Just pushed',
          html_url: 'https://github.com/Example-Org/Example-Repo/pull/127',
          head: { sha: 'abc123' },
        },
      ]),
      ok({ check_runs: [] }),
      ok({ statuses: [] }),
      ok({ mergeable: null, mergeable_state: 'unknown' }),
    );
    const svc = createGitHubPrService({ repoDir: '/r', token: 'tok', git: githubRemote, fetch });

    const status = await svc.prStatusForBranch('feat/just-pushed');
    expect(status).toMatchObject({ pipeline: 'unknown', mergeable: null });
    expect(status).not.toHaveProperty('mergeState');
  });

  it('treats a mergeability request failure on a green PR as an unavailable refresh', async () => {
    const { fetch, calls } = fakeFetch(
      ok([
        {
          number: 121,
          state: 'open',
          title: 'Resolve conflicts',
          html_url: 'https://github.com/Example-Org/Example-Repo/pull/121',
          head: { sha: 'abc123' },
        },
      ]),
      ok({ check_runs: [{ status: 'completed', conclusion: 'success' }] }),
      ok({ statuses: [] }),
      fail(503),
    );
    const svc = createGitHubPrService({ repoDir: '/r', token: 'tok', git: githubRemote, fetch });

    expect(await svc.prStatusForBranch('fix/conflict')).toBeNull();
    expect(calls).toHaveLength(4);
    expect(await svc.prStatusForBranch('fix/conflict')).toBeNull();
    expect(calls).toHaveLength(4); // mergeability failure activated cooldown
  });

  it('keeps a checkless PR visible when the conflict probe fails', async () => {
    // Every freshly opened PR passes through "open, zero checks", so the conflict
    // probe runs on the most common state there is. If a failed probe dropped the
    // whole status, one bad detail response would make the session's PR chip vanish
    // — much worse than simply not knowing yet whether the branch conflicts. The
    // probe is therefore best-effort: no mergeState, PR still reported.
    const { fetch, calls } = fakeFetch(
      ok([
        {
          number: 122,
          state: 'open',
          title: 'Fresh PR',
          html_url: 'https://github.com/Example-Org/Example-Repo/pull/122',
          head: { sha: 'abc123' },
          base: { ref: 'main' },
        },
      ]),
      ok({ check_runs: [] }),
      ok({ statuses: [] }),
      fail(503),
    );
    const svc = createGitHubPrService({ repoDir: '/r', token: 'tok', git: githubRemote, fetch });

    const status = await svc.prStatusForBranch('feat/fresh');
    expect(status).toMatchObject({
      number: 122,
      phase: 'open',
      pipeline: 'unknown',
      mergeable: null,
      baseRef: 'main',
    });
    expect(status).not.toHaveProperty('mergeState');
    expect(calls).toHaveLength(4);
  });

  it('returns merged PR status with aggregate Actions run counts', async () => {
    const { fetch, calls } = fakeFetch(
      ok([
        {
          number: 120,
          state: 'closed',
          merged_at: '2026-06-29T12:00:00Z',
          merge_commit_sha: 'def456',
          title: 'Ship deployment',
          html_url: 'https://github.com/Example-Org/Example-Repo/pull/120',
          head: { sha: 'oldhead' },
        },
      ]),
      ok({
        workflow_runs: [
          { status: 'completed', conclusion: 'success' },
          { status: 'completed', conclusion: 'skipped' },
          { status: 'completed', conclusion: 'cancelled' },
        ],
      }),
    );
    const svc = createGitHubPrService({ repoDir: '/r', token: 'tok', git: githubRemote, fetch });

    expect(await svc.prStatusForBranch('feat/120-x')).toMatchObject({
      number: 120,
      phase: 'merged',
      mergeCommitSha: 'def456',
      pipeline: 'success',
      checks: { completed: 2, total: 2, successful: 2, failed: 0, pending: 0 },
      mergeable: null,
    });
    expect(calls[1]?.url).toBe(
      'https://api.github.com/repos/Example-Org/Example-Repo/actions/runs?head_sha=def456&per_page=100',
    );
  });

  it('ignores cancelled Actions runs without hiding real failures', async () => {
    const { fetch } = fakeFetch(
      ok([
        {
          number: 121,
          state: 'closed',
          merged_at: '2026-06-29T12:00:00Z',
          merge_commit_sha: 'def789',
          title: 'Ship deployment',
          html_url: 'https://github.com/Example-Org/Example-Repo/pull/121',
          head: { sha: 'oldhead' },
        },
      ]),
      ok({
        workflow_runs: [
          { status: 'completed', conclusion: 'failure' },
          { status: 'completed', conclusion: 'cancelled' },
        ],
      }),
    );
    const svc = createGitHubPrService({ repoDir: '/r', token: 'tok', git: githubRemote, fetch });

    expect(await svc.prStatusForBranch('feat/121-x')).toMatchObject({
      pipeline: 'failure',
      checks: { completed: 1, total: 1, successful: 0, failed: 1, pending: 0 },
    });
  });

  it('reports an unknown pipeline when every Actions run was cancelled', async () => {
    const { fetch } = fakeFetch(
      ok([
        {
          number: 122,
          state: 'closed',
          merged_at: '2026-06-29T12:00:00Z',
          merge_commit_sha: 'def890',
          title: 'Ship deployment',
          html_url: 'https://github.com/Example-Org/Example-Repo/pull/122',
          head: { sha: 'oldhead' },
        },
      ]),
      ok({ workflow_runs: [{ status: 'completed', conclusion: 'cancelled' }] }),
    );
    const svc = createGitHubPrService({ repoDir: '/r', token: 'tok', git: githubRemote, fetch });

    expect(await svc.prStatusForBranch('feat/122-x')).toMatchObject({
      pipeline: 'unknown',
      checks: { completed: 0, total: 0, successful: 0, failed: 0, pending: 0 },
    });
  });

  it('refreshes an open PR to merged and switches from checks to Actions runs after the TTL', async () => {
    const now = vi.fn<() => number>(() => 1000);
    const { fetch } = fakeFetch(
      ok([
        {
          number: 120,
          state: 'open',
          title: 'Ship deployment',
          html_url: 'https://github.com/Example-Org/Example-Repo/pull/120',
          head: { sha: 'oldhead' },
        },
      ]),
      ok({ check_runs: [{ status: 'in_progress', conclusion: null }] }),
      ok({ statuses: [] }),
      ok([
        {
          number: 120,
          state: 'closed',
          merged_at: '2026-06-29T12:00:00Z',
          merge_commit_sha: 'def456',
          title: 'Ship deployment',
          html_url: 'https://github.com/Example-Org/Example-Repo/pull/120',
          head: { sha: 'oldhead' },
        },
      ]),
      ok({ workflow_runs: [{ status: 'completed', conclusion: 'success' }] }),
    );
    const svc = createGitHubPrService({
      repoDir: '/r',
      token: 'tok',
      git: githubRemote,
      fetch,
      ttlMs: 15_000,
      now,
    });

    expect(await svc.prStatusForBranch('feat/120-x')).toMatchObject({
      phase: 'open',
      pipeline: 'running',
      checks: { total: 1, pending: 1 },
    });

    now.mockReturnValue(1000 + 15_001);
    expect(await svc.prStatusForBranch('feat/120-x')).toMatchObject({
      phase: 'merged',
      pipeline: 'success',
      checks: { completed: 1, total: 1, successful: 1, failed: 0, pending: 0 },
    });
  });

  // A fetch fake that dispatches by URL substring (the per-branch lookups run in
  // parallel, so a queue-ordered fake would be racy). An unmatched pulls query
  // resolves to "no PR" ([]).
  function byUrl(routes: Record<string, unknown>): HttpFetch {
    return (url) => {
      for (const key of Object.keys(routes)) {
        if (url.includes(key)) return Promise.resolve(ok(routes[key]));
      }
      return Promise.resolve(ok([]));
    };
  }
  const openPr = (number: number, sha: string, updatedAt: string) => [
    {
      number,
      state: 'open',
      title: `PR #${String(number)}`,
      html_url: `https://github.com/Example-Org/Example-Repo/pull/${String(number)}`,
      updated_at: updatedAt,
      head: { sha },
    },
  ];
  const greenChecks = { check_runs: [{ status: 'completed', conclusion: 'success' }] };

  describe('prStatusForBranches (multi-branch session)', () => {
    it('surfaces the most-recently-updated OPEN PR across the branches', async () => {
      // The worktree HEAD (agent/x) has NO PR; two feature branches each have an open
      // PR. The more recently updated one (phase5) must win — this is the multi-branch
      // repro where the session's PR lives on a branch other than the worktree HEAD.
      const fetch = byUrl({
        'agent%2Fx&state': [],
        'phase5&state': openPr(1510, 'sha5', '2026-07-02T10:00:00Z'),
        'phase4&state': openPr(1400, 'sha4', '2026-07-01T10:00:00Z'),
        'commits/sha5/check-runs': greenChecks,
        'commits/sha5/status': { statuses: [] },
        'commits/sha4/check-runs': greenChecks,
        'commits/sha4/status': { statuses: [] },
        'pulls/1510': { mergeable: true },
        'pulls/1400': { mergeable: true },
      });
      const svc = createGitHubPrService({ repoDir: '/r', token: 'tok', git: githubRemote, fetch });
      const status = await svc.prStatusForBranches([
        'agent/x',
        'security/audit-phase5',
        'security/audit-phase4',
      ]);
      expect(status?.number).toBe(1510);
      expect(status?.phase).toBe('open');
    });

    it('prefers a later-updated open PR even when the HEAD branch has its own open PR', async () => {
      const fetch = byUrl({
        'agent%2Fx&state': openPr(1, 'shaHead', '2026-07-01T00:00:00Z'),
        'phase5&state': openPr(1510, 'sha5', '2026-07-02T00:00:00Z'),
        'commits/shaHead/check-runs': greenChecks,
        'commits/shaHead/status': { statuses: [] },
        'commits/sha5/check-runs': greenChecks,
        'commits/sha5/status': { statuses: [] },
        'pulls/1': { mergeable: true },
        'pulls/1510': { mergeable: true },
      });
      const svc = createGitHubPrService({ repoDir: '/r', token: 'tok', git: githubRemote, fetch });
      const status = await svc.prStatusForBranches(['agent/x', 'security/audit-phase5']);
      expect(status?.number).toBe(1510);
    });

    it('falls back to the HEAD branch status when no branch has an open PR', async () => {
      // No open PR anywhere → return the FIRST branch's own status unchanged (here a
      // merged PR on the HEAD branch), so single-branch behavior is preserved and a
      // stale merged PR on another branch never shadows the HEAD.
      const fetch = byUrl({
        'agent%2Fx&state': [
          {
            number: 42,
            state: 'closed',
            merged_at: '2026-06-30T00:00:00Z',
            merge_commit_sha: 'mergedsha',
            title: 'Merged HEAD PR',
            html_url: 'https://github.com/Example-Org/Example-Repo/pull/42',
            head: { sha: 'h' },
          },
        ],
        'phase2&state': [], // an old branch with no PR
        'actions/runs': { workflow_runs: [{ status: 'completed', conclusion: 'success' }] },
      });
      const svc = createGitHubPrService({ repoDir: '/r', token: 'tok', git: githubRemote, fetch });
      const status = await svc.prStatusForBranches(['agent/x', 'security/audit-phase2']);
      expect(status?.number).toBe(42);
      expect(status?.phase).toBe('merged');
    });

    it('is equivalent to prStatusForBranch for a single-branch session', async () => {
      const fetch = byUrl({
        'feat%2Fx&state': openPr(7, 'sha7', '2026-07-02T00:00:00Z'),
        'commits/sha7/check-runs': greenChecks,
        'commits/sha7/status': { statuses: [] },
        'pulls/7': { mergeable: true },
      });
      const svc = createGitHubPrService({ repoDir: '/r', token: 'tok', git: githubRemote, fetch });
      expect(await svc.prStatusForBranches(['feat/x'])).toEqual(
        await svc.prStatusForBranch('feat/x'),
      );
    });

    it('returns null for an empty branch list', async () => {
      const { fetch, calls } = fakeFetch(ok([]));
      const svc = createGitHubPrService({ repoDir: '/r', token: 'tok', git: githubRemote, fetch });
      expect(await svc.prStatusForBranches([])).toBeNull();
      expect(calls).toHaveLength(0); // no lookup fired
    });
  });

  it('merges a PR through the GitHub merge endpoint', async () => {
    const { fetch, calls } = fakeFetch(ok({ merged: true }));
    const svc = createGitHubPrService({ repoDir: '/r', token: 'tok', git: githubRemote, fetch });

    expect(await svc.mergePr(119)).toBe(true);
    expect(calls[0]?.url).toBe(
      'https://api.github.com/repos/Example-Org/Example-Repo/pulls/119/merge',
    );
    expect(calls[0]?.method).toBe('PUT');
    expect(calls[0]?.body).toBe(JSON.stringify({ merge_method: 'merge' }));
  });

  it('sends the approved head SHA as an atomic merge precondition', async () => {
    const { fetch, calls } = fakeFetch(ok({ merged: true }));
    const svc = createGitHubPrService({ repoDir: '/r', token: 'tok', git: githubRemote, fetch });
    const headSha = 'a'.repeat(40);

    expect(await svc.mergePr(119, headSha)).toBe(true);
    expect(calls[0]?.body).toBe(JSON.stringify({ merge_method: 'merge', sha: headSha }));
  });

  it('uses an async token provider for merging when no sync token exists', async () => {
    const { fetch, calls } = fakeFetch(ok({ merged: true }));
    const asyncToken = vi.fn(() => Promise.resolve('app-installation-token'));
    const svc = createGitHubPrService({ repoDir: '/r', asyncToken, git: githubRemote, fetch });

    expect(await svc.mergePr(119)).toBe(true);
    expect(asyncToken).toHaveBeenCalledWith('Example-Org', 'Example-Repo');
    expect(calls[0]?.headers?.Authorization).toBe('Bearer app-installation-token');
  });

  /** The post-merge worktree reset re-reads the PR to learn the branch it actually
   *  merged into (`POST /sessions/:id/pull-request/merge`). That read is only fresh
   *  because a successful merge drops this cache — otherwise it would replay the
   *  pre-merge row for the rest of the TTL and the reset could target a base the PR
   *  was retargeted away from. */
  it('drops the cached branch statuses after a successful merge', async () => {
    const now = vi.fn<() => number>(() => 1000);
    const { fetch, calls } = fakeFetch(
      ok([{ number: 119 }]), // the pre-merge lookup
      ok({ merged: true }), // the merge itself
      ok([{ number: 119 }]), // only reached if the merge dropped the cache
    );
    const svc = createGitHubPrService({
      repoDir: '/r',
      token: 'tok',
      git: githubRemote,
      fetch,
      ttlMs: 60_000,
      now,
    });

    expect(await svc.prForBranch('feat/122-x')).toBe(119);
    expect(await svc.mergePr(119)).toBe(true);
    expect(await svc.prForBranch('feat/122-x')).toBe(119); // WELL inside the TTL
    expect(calls).toHaveLength(3); // re-fetched rather than served from before the merge
  });

  it('keeps the cache when GitHub refuses the merge', async () => {
    const { fetch, calls } = fakeFetch(ok([{ number: 119 }]), fail(405), ok([{ number: 119 }]));
    const svc = createGitHubPrService({
      repoDir: '/r',
      token: 'tok',
      git: githubRemote,
      fetch,
      ttlMs: 60_000,
      now: () => 1000,
    });

    expect(await svc.prForBranch('feat/122-x')).toBe(119);
    expect(await svc.mergePr(119)).toBe(false);
    expect(await svc.prForBranch('feat/122-x')).toBe(119);
    expect(calls).toHaveLength(2); // nothing changed on GitHub — no third lookup
  });

  it('caches within the TTL and re-fetches after it', async () => {
    const now = vi.fn<() => number>(() => 1000);
    const { fetch, calls } = fakeFetch(ok([{ number: 119 }]));
    const svc = createGitHubPrService({
      repoDir: '/r',
      token: 'tok',
      git: githubRemote,
      fetch,
      ttlMs: 60_000,
      now,
    });

    expect(await svc.prForBranch('feat/122-x')).toBe(119);
    expect(await svc.prForBranch('feat/122-x')).toBe(119); // served from cache
    expect(calls).toHaveLength(1);

    now.mockReturnValue(1000 + 60_001); // past the TTL
    expect(await svc.prForBranch('feat/122-x')).toBe(119);
    expect(calls).toHaveLength(2); // re-fetched
  });

  it('expires a "no PR" answer fast (negativeTtlMs) but holds a found PR for the full ttl', async () => {
    const now = vi.fn<() => number>(() => 1000);
    // First lookup: no PR for the branch. After the agent opens one, GitHub returns it.
    const { fetch, calls } = fakeFetch(ok([]), ok([{ number: 7 }]));
    const svc = createGitHubPrService({
      repoDir: '/r',
      token: 'tok',
      git: githubRemote,
      fetch,
      ttlMs: 60_000,
      negativeTtlMs: 4_000,
      now,
    });

    expect(await svc.prForBranch('feat/1-x')).toBeNull(); // no PR yet
    expect(await svc.prForBranch('feat/1-x')).toBeNull(); // served from the negative cache
    expect(calls).toHaveLength(1);

    now.mockReturnValue(1000 + 4_001); // past negativeTtlMs, WELL within ttlMs
    expect(await svc.prForBranch('feat/1-x')).toBe(7); // re-fetched → freshly opened PR shows
    expect(calls).toHaveLength(2);

    // The found PR now holds for the FULL ttlMs — the short negative window doesn't
    // force a needless re-fetch once we actually have a PR.
    now.mockReturnValue(1000 + 4_001 + 4_001); // another negativeTtl on, still < ttlMs
    expect(await svc.prForBranch('feat/1-x')).toBe(7);
    expect(calls).toHaveLength(2); // still cached
  });

  it('is inert without a token — never calls GitHub', async () => {
    const { fetch, calls } = fakeFetch(ok([{ number: 5 }]));
    const svc = createGitHubPrService({ repoDir: '/r', git: githubRemote, fetch });
    expect(await svc.prForBranch('feat/1-x')).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('uses an async token provider when no sync token exists', async () => {
    const { fetch, calls } = fakeFetch(ok([{ number: 5 }]));
    const asyncToken = vi.fn(() => Promise.resolve('app-installation-token'));
    const svc = createGitHubPrService({ repoDir: '/r', asyncToken, git: githubRemote, fetch });
    expect(await svc.prForBranch('feat/1-x')).toBe(5);
    expect(asyncToken).toHaveBeenCalledWith('Example-Org', 'Example-Repo');
    expect(calls[0]?.headers?.Authorization).toBe('Bearer app-installation-token');
  });

  it('degrades async token mint failures to null without calling GitHub', async () => {
    const { fetch, calls } = fakeFetch(ok([{ number: 5 }]));
    const svc = createGitHubPrService({
      repoDir: '/r',
      asyncToken: () => Promise.reject(new Error('sealed')),
      git: githubRemote,
      fetch,
    });
    expect(await svc.prForBranch('feat/1-x')).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('returns null for a non-GitHub origin remote (no fetch)', async () => {
    const gitlab: GitOutput = () => Promise.resolve('git@gitlab.com:o/r.git\n');
    const { fetch, calls } = fakeFetch(ok([{ number: 5 }]));
    const svc = createGitHubPrService({ repoDir: '/r', token: 'tok', git: gitlab, fetch });
    expect(await svc.prForBranch('feat/1-x')).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('keeps cached PR identity but clears stale check progress on a network error', async () => {
    const now = vi.fn<() => number>(() => 1000);
    const { fetch, calls } = fakeFetch(ok([{ number: 119 }]), () =>
      Promise.reject(new Error('net')),
    );
    const svc = createGitHubPrService({
      repoDir: '/r',
      token: 'tok',
      git: githubRemote,
      fetch,
      ttlMs: 100,
      now,
    });
    expect(await svc.prForBranch('b')).toBe(119); // cached
    now.mockReturnValue(2000); // past TTL → re-fetch → throws → stale served
    expect(await svc.prForBranch('b')).toBe(119);
    expect(await svc.prStatusForBranch('b')).toMatchObject({
      number: 119,
      pipeline: 'unknown',
      checks: { completed: 0, total: 0, successful: 0, failed: 0, pending: 0 },
    });
    expect(calls).toHaveLength(2); // third call is suppressed by failure backoff
  });

  it('does not cache a non-ok response (retries on the next call)', async () => {
    const { fetch, calls } = fakeFetch(fail(403), ok([{ number: 7 }]));
    const svc = createGitHubPrService({
      repoDir: '/r',
      token: 'tok',
      git: githubRemote,
      fetch,
      failureBackoffMs: 0,
    });
    expect(await svc.prForBranch('b')).toBeNull(); // 403 → null, not cached
    expect(await svc.prForBranch('b')).toBe(7); // retried, got the PR
    expect(calls).toHaveLength(2);
  });

  it('reuses ETagged REST bodies on 304 responses', async () => {
    const now = vi.fn<() => number>(() => 1000);
    const pr = [
      {
        number: 7,
        state: 'open',
        title: 'Conditional status',
        html_url: 'https://github.com/Example-Org/Example-Repo/pull/7',
        head: { sha: 'abc123' },
      },
    ];
    const { fetch, calls } = fakeFetch(
      okWithEtag(pr, '"pr-v1"'),
      okWithEtag({ check_runs: [{ status: 'in_progress', conclusion: null }] }, '"checks-v1"'),
      okWithEtag({ statuses: [] }, '"statuses-v1"'),
      notModified(),
      notModified(),
      notModified(),
    );
    const svc = createGitHubPrService({
      repoDir: '/r',
      token: 'tok',
      git: githubRemote,
      fetch,
      ttlMs: 100,
      now,
    });

    expect(await svc.prStatusForBranch('b')).toMatchObject({ pipeline: 'running' });
    now.mockReturnValue(1101);
    expect(await svc.prStatusForBranch('b')).toMatchObject({ pipeline: 'running' });
    expect(calls[3]?.headers?.['If-None-Match']).toBe('"pr-v1"');
    expect(calls[4]?.headers?.['If-None-Match']).toBe('"checks-v1"');
    expect(calls[5]?.headers?.['If-None-Match']).toBe('"statuses-v1"');
  });

  it('backs off when all check sources fail after the PR list succeeds', async () => {
    const now = vi.fn<() => number>(() => 1000);
    const pr = [
      {
        number: 7,
        state: 'open',
        title: 'Partially rate limited status',
        html_url: 'https://github.com/Example-Org/Example-Repo/pull/7',
        head: { sha: 'abc123' },
      },
    ];
    const { fetch, calls } = fakeFetch(
      okWithEtag(pr, '"pr-v1"'),
      okWithEtag({ check_runs: [{ status: 'in_progress', conclusion: null }] }, '"checks-v1"'),
      okWithEtag({ statuses: [] }, '"statuses-v1"'),
      notModified(),
      fail(403),
      fail(403),
    );
    const svc = createGitHubPrService({
      repoDir: '/r',
      token: 'tok',
      git: githubRemote,
      fetch,
      ttlMs: 100,
      failureBackoffMs: 1000,
      now,
    });

    expect(await svc.prStatusForBranch('b')).toMatchObject({ pipeline: 'running' });
    now.mockReturnValue(1101);
    expect(await svc.prStatusForBranch('b')).toMatchObject({
      number: 7,
      pipeline: 'unknown',
      checks: { total: 0, pending: 0 },
    });
    expect(calls).toHaveLength(6);

    now.mockReturnValue(1500);
    await svc.prStatusForBranch('b');
    expect(calls).toHaveLength(6); // total check-signal failure activated shared backoff
  });

  it('shares a failure cooldown across session services', async () => {
    const now = vi.fn<() => number>(() => 1000);
    const cooldowns = new Map<string, { until: number }>();
    const failureCooldownFor = (owner: string, repo: string): { until: number } => {
      const key = `${owner}/${repo}`;
      const existing = cooldowns.get(key);
      if (existing !== undefined) return existing;
      const created = { until: 0 };
      cooldowns.set(key, created);
      return created;
    };
    const first = fakeFetch(fail(403));
    const second = fakeFetch(ok([{ number: 7 }]));
    const common = {
      repoDir: '/r',
      token: 'tok',
      git: githubRemote,
      failureBackoffMs: 1000,
      failureCooldownFor,
      now,
    };
    const firstSvc = createGitHubPrService({ ...common, fetch: first.fetch });
    const secondSvc = createGitHubPrService({ ...common, fetch: second.fetch });

    expect(await firstSvc.prForBranch('one')).toBeNull();
    expect(await secondSvc.prForBranch('two')).toBeNull();
    expect(second.calls).toHaveLength(0);

    now.mockReturnValue(2001);
    expect(await secondSvc.prForBranch('two')).toBe(7);
    expect(second.calls).toHaveLength(1);
  });

  it('allows only one repository probe when a shared cooldown expires', async () => {
    const now = vi.fn<() => number>(() => 2001);
    const cooldown = { until: 2000 };
    let finishProbe: ((response: HttpResponse) => void) | undefined;
    const pendingFailure = new Promise<HttpResponse>((resolve) => {
      finishProbe = resolve;
    });
    const first = fakeFetch(() => pendingFailure);
    const second = fakeFetch(ok([{ number: 7 }]));
    const common = {
      repoDir: '/r',
      token: 'tok',
      git: githubRemote,
      failureBackoffMs: 1000,
      failureCooldownFor: () => cooldown,
      now,
    };
    const firstSvc = createGitHubPrService({ ...common, fetch: first.fetch });
    const secondSvc = createGitHubPrService({ ...common, fetch: second.fetch });

    const firstLookup = firstSvc.prForBranch('one');
    const secondLookup = secondSvc.prForBranch('two');
    await vi.waitFor(() => expect(first.calls).toHaveLength(1));
    expect(second.calls).toHaveLength(0);

    finishProbe?.(fail(403));
    await expect(firstLookup).resolves.toBeNull();
    await expect(secondLookup).resolves.toBeNull();
    expect(second.calls).toHaveLength(0);
  });

  it('releases repository refreshes after a successful recovery probe', async () => {
    const now = vi.fn<() => number>(() => 2001);
    const cooldown = { until: 2000 };
    let finishFirst: ((response: HttpResponse) => void) | undefined;
    const pendingSuccess = new Promise<HttpResponse>((resolve) => {
      finishFirst = resolve;
    });
    const first = fakeFetch(() => pendingSuccess);
    const second = fakeFetch(ok([]));
    const common = {
      repoDir: '/r',
      token: 'tok',
      git: githubRemote,
      failureCooldownFor: () => cooldown,
      now,
    };
    const firstSvc = createGitHubPrService({ ...common, fetch: first.fetch });
    const secondSvc = createGitHubPrService({ ...common, fetch: second.fetch });

    const firstLookup = firstSvc.prForBranch('one');
    const secondLookup = secondSvc.prForBranch('two');
    await vi.waitFor(() => expect(first.calls).toHaveLength(1));
    expect(second.calls).toHaveLength(0);

    finishFirst?.(ok([]));
    await expect(firstLookup).resolves.toBeNull();
    await expect(secondLookup).resolves.toBeNull();
    expect(second.calls).toHaveLength(1);
    expect(cooldown.until).toBe(0);
  });

  it('keeps normal repository refreshes concurrent', async () => {
    const cooldown = { until: 0 };
    let finishFirst: ((response: HttpResponse) => void) | undefined;
    const pendingSuccess = new Promise<HttpResponse>((resolve) => {
      finishFirst = resolve;
    });
    const first = fakeFetch(() => pendingSuccess);
    const second = fakeFetch(ok([]));
    const common = {
      repoDir: '/r',
      token: 'tok',
      git: githubRemote,
      failureCooldownFor: () => cooldown,
    };
    const firstSvc = createGitHubPrService({ ...common, fetch: first.fetch });
    const secondSvc = createGitHubPrService({ ...common, fetch: second.fetch });

    const firstLookup = firstSvc.prForBranch('one');
    const secondLookup = secondSvc.prForBranch('two');
    await vi.waitFor(() => expect(first.calls).toHaveLength(1));
    await expect(secondLookup).resolves.toBeNull();
    expect(second.calls).toHaveLength(1);

    finishFirst?.(ok([]));
    await expect(firstLookup).resolves.toBeNull();
  });

  it('coalesces token-provider failures during recovery', async () => {
    const now = vi.fn<() => number>(() => 2001);
    const cooldown = { until: 2000 };
    let rejectToken: ((reason: Error) => void) | undefined;
    const pendingToken = new Promise<string>((_resolve, reject) => {
      rejectToken = reject;
    });
    const firstToken = vi.fn(() => pendingToken);
    const secondToken = vi.fn(async () => 'token');
    const common = {
      repoDir: '/r',
      git: githubRemote,
      failureBackoffMs: 1000,
      failureCooldownFor: () => cooldown,
      now,
    };
    const firstSvc = createGitHubPrService({ ...common, asyncToken: firstToken });
    const secondSvc = createGitHubPrService({ ...common, asyncToken: secondToken });

    const firstLookup = firstSvc.prForBranch('one');
    const secondLookup = secondSvc.prForBranch('two');
    await vi.waitFor(() => expect(firstToken).toHaveBeenCalledOnce());
    expect(secondToken).not.toHaveBeenCalled();

    rejectToken?.(new Error('token broker unavailable'));
    await expect(firstLookup).resolves.toBeNull();
    await expect(secondLookup).resolves.toBeNull();
    expect(secondToken).not.toHaveBeenCalled();
    expect(cooldown.until).toBe(3001);
  });

  it('marks cached checks unknown and backs off when normal token minting fails', async () => {
    const now = vi.fn<() => number>(() => 1000);
    const asyncToken = vi
      .fn<() => Promise<string | undefined>>()
      .mockResolvedValueOnce('token')
      .mockRejectedValueOnce(new Error('token broker unavailable'));
    const { fetch, calls } = fakeFetch(
      ok([
        {
          number: 7,
          state: 'open',
          title: 'Token outage',
          html_url: 'https://github.com/Example-Org/Example-Repo/pull/7',
          head: { sha: 'abc123' },
        },
      ]),
      ok({ check_runs: [{ status: 'in_progress', conclusion: null }] }),
      ok({ statuses: [] }),
    );
    const svc = createGitHubPrService({
      repoDir: '/r',
      asyncToken,
      git: githubRemote,
      fetch,
      ttlMs: 100,
      failureBackoffMs: 1000,
      now,
    });

    expect(await svc.prStatusForBranch('b')).toMatchObject({ pipeline: 'running' });
    now.mockReturnValue(1101);
    expect(await svc.prStatusForBranch('b')).toMatchObject({
      pipeline: 'unknown',
      checks: { total: 0, pending: 0 },
    });
    expect(asyncToken).toHaveBeenCalledTimes(2);
    expect(calls).toHaveLength(3);

    now.mockReturnValue(1500);
    await svc.prStatusForBranch('b');
    expect(asyncToken).toHaveBeenCalledTimes(2);
  });

  it('marks stale checks unknown and backs off after a failed refresh', async () => {
    const now = vi.fn<() => number>(() => 1000);
    const { fetch, calls } = fakeFetch(
      ok([
        {
          number: 7,
          state: 'open',
          title: 'Rate limited status',
          html_url: 'https://github.com/Example-Org/Example-Repo/pull/7',
          head: { sha: 'abc123' },
        },
      ]),
      ok({ check_runs: [{ status: 'in_progress', conclusion: null }] }),
      ok({ statuses: [] }),
      fail(403),
      ok([]),
    );
    const svc = createGitHubPrService({
      repoDir: '/r',
      token: 'tok',
      git: githubRemote,
      fetch,
      ttlMs: 100,
      failureBackoffMs: 1000,
      now,
    });

    expect(await svc.prStatusForBranch('b')).toMatchObject({
      pipeline: 'running',
      checks: { total: 1, pending: 1 },
    });
    now.mockReturnValue(1101);
    expect(await svc.prStatusForBranch('b')).toMatchObject({
      number: 7,
      pipeline: 'unknown',
      checks: { total: 0, pending: 0 },
      mergeable: null,
    });
    expect(calls).toHaveLength(4);

    now.mockReturnValue(1500);
    await svc.prStatusForBranch('b');
    expect(calls).toHaveLength(4); // still in failure backoff

    now.mockReturnValue(2102);
    expect(await svc.prStatusForBranch('b')).toBeNull();
    expect(calls).toHaveLength(5); // backoff elapsed, lookup retried
  });

  it('re-resolves a token PROVIDER per lookup — inert until a token appears (#131)', async () => {
    let current: string | undefined = undefined;
    const { fetch, calls } = fakeFetch(ok([{ number: 9 }]));
    const svc = createGitHubPrService({
      repoDir: '/r',
      token: () => current,
      git: githubRemote,
      fetch,
    });
    expect(await svc.prForBranch('feat/1-x')).toBeNull(); // no token yet → inert, no fetch
    expect(calls).toHaveLength(0);
    current = 'tok'; // token appears (e.g. heey-token-mint wrote the file)
    expect(await svc.prForBranch('feat/1-x')).toBe(9); // now looked up
    expect(calls[0]?.headers?.Authorization).toBe('Bearer tok');
  });

  it("uses the provider's CURRENT token on each lookup (rotation, #131)", async () => {
    let current = 'old';
    const { fetch, calls } = fakeFetch(ok([{ number: 1 }]));
    const svc = createGitHubPrService({
      repoDir: '/r',
      token: () => current,
      git: githubRemote,
      fetch,
    });
    await svc.prForBranch('feat/1-x');
    expect(calls[0]?.headers?.Authorization).toBe('Bearer old');
    current = 'new'; // rotated
    await svc.prForBranch('feat/2-y'); // different branch → cache miss → fresh lookup
    expect(calls[1]?.headers?.Authorization).toBe('Bearer new');
  });
});

describe('createGhTokenReader (#131)', () => {
  it('reads the trimmed token from the file', () => {
    const read = createGhTokenReader({ path: '/x/.gh-token', readFile: () => 'ghs_abc\n' });
    expect(read()).toBe('ghs_abc');
  });

  it('falls back to env when the file is absent or blank', () => {
    expect(
      createGhTokenReader({ path: '/x', readFile: () => undefined, env: () => 'pat_env' })(),
    ).toBe('pat_env');
    expect(
      createGhTokenReader({ path: '/x', readFile: () => '   \n', env: () => 'pat_env' })(),
    ).toBe('pat_env');
  });

  it('prefers the (always-fresh) file over the (possibly-stale) env value', () => {
    const read = createGhTokenReader({
      path: '/x',
      readFile: () => 'file_tok',
      env: () => 'env_tok',
    });
    expect(read()).toBe('file_tok');
  });

  it('returns undefined when neither file nor env yields a token', () => {
    expect(createGhTokenReader({ path: '/x', readFile: () => undefined })()).toBeUndefined();
  });

  it('caches within the ttl, then re-reads so a rotated token is picked up', () => {
    const now = vi.fn<() => number>(() => 1000);
    let fileVal = 'tok_A';
    const readFile = vi.fn(() => fileVal);
    const read = createGhTokenReader({ path: '/x', readFile, ttlMs: 30_000, now });
    expect(read()).toBe('tok_A');
    fileVal = 'tok_B';
    expect(read()).toBe('tok_A'); // still cached — file not re-read
    expect(readFile).toHaveBeenCalledTimes(1);
    now.mockReturnValue(1000 + 30_001); // ttl elapsed
    expect(read()).toBe('tok_B'); // re-read picks up the rotation
    expect(readFile).toHaveBeenCalledTimes(2);
  });
});

describe('createGitHubIssueService (#137)', () => {
  // Two issues + one PR (the issues endpoint returns PRs too — they carry a
  // `pull_request` field and must be filtered out).
  const page = [
    { number: 137, title: 'Issues on overview', body: 'do it', html_url: 'https://gh/137' },
    {
      number: 99,
      title: 'A pull request',
      body: 'pr',
      html_url: 'https://gh/99',
      pull_request: {},
    },
    { number: 42, title: 'Another', body: '', html_url: 'https://gh/42' },
  ];

  it('lists open issues (PRs excluded) with the right query + auth header', async () => {
    const { fetch, calls } = fakeFetch(ok(page));
    const svc = createGitHubIssueService({ repoDir: '/r', token: 'tok', git: githubRemote, fetch });

    expect(await svc.listOpenIssues()).toEqual([
      { number: 137, title: 'Issues on overview', body: 'do it', url: 'https://gh/137' },
      { number: 42, title: 'Another', body: '', url: 'https://gh/42' },
    ]);
    expect(calls[0]?.url).toBe(
      'https://api.github.com/repos/Example-Org/Example-Repo/issues' +
        '?state=open&sort=updated&direction=desc&per_page=50',
    );
    expect(calls[0]?.headers?.Authorization).toBe('Bearer tok');
    expect(calls[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('clamps per_page into GitHub 1..100', async () => {
    const { fetch, calls } = fakeFetch(ok([]));
    const svc = createGitHubIssueService({
      repoDir: '/r',
      token: 'tok',
      git: githubRemote,
      fetch,
      perPage: 9999,
    });
    await svc.listOpenIssues();
    expect(calls[0]?.url).toContain('per_page=100');
  });

  it('drops malformed rows (missing/ill-typed number or title) rather than crashing', async () => {
    const { fetch } = fakeFetch(
      ok([
        { number: 1, title: 'ok', body: 'b', html_url: 'u' },
        { number: 'x', title: 'bad number' },
        { number: 2 }, // missing title
        { title: 'no number' },
      ]),
    );
    const svc = createGitHubIssueService({ repoDir: '/r', token: 'tok', git: githubRemote, fetch });
    expect(await svc.listOpenIssues()).toEqual([{ number: 1, title: 'ok', body: 'b', url: 'u' }]);
  });

  it('is inert without a token — never calls GitHub', async () => {
    const { fetch, calls } = fakeFetch(ok(page));
    const svc = createGitHubIssueService({ repoDir: '/r', git: githubRemote, fetch });
    expect(await svc.listOpenIssues()).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('returns [] for a non-GitHub origin remote (no fetch)', async () => {
    const gitlab: GitOutput = () => Promise.resolve('git@gitlab.com:o/r.git\n');
    const { fetch, calls } = fakeFetch(ok(page));
    const svc = createGitHubIssueService({ repoDir: '/r', token: 'tok', git: gitlab, fetch });
    expect(await svc.listOpenIssues()).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('caches within the TTL and re-fetches after it', async () => {
    const now = vi.fn<() => number>(() => 1000);
    const { fetch, calls } = fakeFetch(ok(page));
    const svc = createGitHubIssueService({
      repoDir: '/r',
      token: 'tok',
      git: githubRemote,
      fetch,
      ttlMs: 60_000,
      now,
    });
    await svc.listOpenIssues();
    await svc.listOpenIssues(); // cache hit
    expect(calls).toHaveLength(1);
    now.mockReturnValue(1000 + 60_001);
    await svc.listOpenIssues();
    expect(calls).toHaveLength(2);
  });

  it('degrades to the last good list on a network error', async () => {
    const now = vi.fn<() => number>(() => 1000);
    const { fetch } = fakeFetch(ok(page), () => Promise.reject(new Error('net')));
    const svc = createGitHubIssueService({
      repoDir: '/r',
      token: 'tok',
      git: githubRemote,
      fetch,
      ttlMs: 100,
      now,
    });
    expect((await svc.listOpenIssues()).map((i) => i.number)).toEqual([137, 42]); // cached good
    now.mockReturnValue(2000); // past TTL → re-fetch throws → serve stale
    expect((await svc.listOpenIssues()).map((i) => i.number)).toEqual([137, 42]);
  });

  it('returns [] on a non-2xx response', async () => {
    const { fetch } = fakeFetch(fail(403));
    const svc = createGitHubIssueService({ repoDir: '/r', token: 'tok', git: githubRemote, fetch });
    expect(await svc.listOpenIssues()).toEqual([]);
  });
});

describe('createGitHubReleaseService', () => {
  // Let the fire-and-forget background refresh settle (fetch + json = a couple of
  // microtask ticks) before asserting the now-populated cache.
  const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  const release = {
    tag_name: 'v1.4.0',
    name: 'Release 1.4.0',
    html_url: 'https://github.com/heey-global/verity/releases/tag/v1.4.0',
    published_at: '2026-07-01T10:00:00Z',
  };

  it('serves the latest release from the background refresh (cold → undefined, then cached)', async () => {
    const { fetch, calls } = fakeFetch(ok([release]));
    const svc = createGitHubReleaseService({ token: 'tok', fetch });
    // First call is cold: returns undefined (UNKNOWN, not "no release") immediately
    // and kicks a background fetch.
    expect(svc.latestRelease('heey-global', 'verity')).toBeUndefined();
    await tick();
    expect(svc.latestRelease('heey-global', 'verity')).toEqual({
      tag: 'v1.4.0',
      name: 'Release 1.4.0',
      url: 'https://github.com/heey-global/verity/releases/tag/v1.4.0',
      publishedAt: '2026-07-01T10:00:00Z',
    });
    expect(calls[0]?.url).toBe(
      'https://api.github.com/repos/heey-global/verity/releases?per_page=100',
    );
  });

  it('uses the newest visible release from the releases list, including prereleases', async () => {
    const { fetch } = fakeFetch(
      ok([
        { ...release, tag_name: 'draft-only', draft: true },
        { ...release, tag_name: 'pkg-a@2.0.0-beta.1', prerelease: true },
      ]),
    );
    const svc = createGitHubReleaseService({ token: 'tok', fetch });
    svc.latestRelease('heey-global', 'verity');
    await tick();
    expect(svc.latestRelease('heey-global', 'verity')?.tag).toBe('pkg-a@2.0.0-beta.1');
  });

  it('walks release pages before concluding that a repo has no visible release', async () => {
    const { fetch, calls } = fakeFetch(
      {
        ...ok([{ ...release, tag_name: 'draft-only', draft: true }, { name: 'malformed' }]),
        headers: {
          get: (name: string) =>
            name.toLowerCase() === 'link'
              ? '<https://api.github.com/repos/heey-global/verity/releases?per_page=100&page=2>; rel="next"'
              : null,
        },
      },
      ok([{ ...release, tag_name: 'pkg-b@3.0.0' }]),
    );
    const svc = createGitHubReleaseService({ token: 'tok', fetch });
    await expect(svc.refreshLatestRelease('heey-global', 'verity')).resolves.toMatchObject({
      tag: 'pkg-b@3.0.0',
    });
    expect(calls.map((c) => c.url)).toEqual([
      'https://api.github.com/repos/heey-global/verity/releases?per_page=100',
      'https://api.github.com/repos/heey-global/verity/releases?per_page=100&page=2',
    ]);
  });

  it('can await a cold refresh when a caller needs an immediate answer', async () => {
    const { fetch, calls } = fakeFetch(ok([release]));
    const svc = createGitHubReleaseService({ token: 'tok', fetch });
    await expect(svc.refreshLatestRelease('heey-global', 'verity')).resolves.toMatchObject({
      tag: 'v1.4.0',
    });
    expect(svc.latestRelease('heey-global', 'verity')?.tag).toBe('v1.4.0');
    expect(calls).toHaveLength(1);
  });

  it('uses the async token provider for awaited refreshes when no sync token exists', async () => {
    const { fetch, calls } = fakeFetch(ok([release]));
    const asyncToken = vi.fn(() => Promise.resolve('app-installation-token'));
    const svc = createGitHubReleaseService({ token: undefined, asyncToken, fetch });
    expect(svc.latestRelease('heey-global', 'verity')).toBeUndefined();
    await expect(svc.refreshLatestRelease('heey-global', 'verity')).resolves.toMatchObject({
      tag: 'v1.4.0',
    });
    expect(asyncToken).toHaveBeenCalledWith('heey-global', 'verity');
    expect(calls[0]?.headers?.Authorization).toBe('Bearer app-installation-token');
  });

  it('treats async token mint failures as unknown instead of throwing', async () => {
    const { fetch, calls } = fakeFetch(ok([release]));
    const svc = createGitHubReleaseService({
      token: undefined,
      asyncToken: () => Promise.reject(new Error('mint failed')),
      fetch,
    });
    await expect(svc.refreshLatestRelease('heey-global', 'verity')).resolves.toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it('hits GitHub at most once per repo within the TTL, even across many polls', async () => {
    const now = vi.fn(() => 1000);
    const { fetch, calls } = fakeFetch(ok([release]));
    const svc = createGitHubReleaseService({ token: 'tok', fetch, ttlMs: 300_000, now });
    // A burst of overlapping cold polls must dedupe to a single in-flight fetch.
    svc.latestRelease('heey-global', 'verity');
    svc.latestRelease('heey-global', 'verity');
    await tick();
    svc.latestRelease('heey-global', 'verity'); // fresh cache → no new fetch
    await tick();
    expect(calls).toHaveLength(1);
  });

  it('re-fetches once the TTL has elapsed', async () => {
    const now = vi.fn(() => 1000);
    const { fetch, calls } = fakeFetch(ok([release]));
    const svc = createGitHubReleaseService({ token: 'tok', fetch, ttlMs: 100, now });
    svc.latestRelease('heey-global', 'verity');
    await tick();
    now.mockReturnValue(2000); // past TTL
    svc.latestRelease('heey-global', 'verity');
    await tick();
    expect(calls).toHaveLength(2);
  });

  it('distinguishes a cold cache (undefined) from a confirmed empty release list (null), without hammering GitHub', async () => {
    const { fetch, calls } = fakeFetch(ok([]));
    const svc = createGitHubReleaseService({ token: 'tok', fetch });
    // Cold: UNKNOWN → undefined (a persisting caller keeps its stored value).
    expect(svc.latestRelease('heey-global', 'verity')).toBeUndefined();
    await tick();
    // Settled empty list: CONFIRMED no release → null (a persisting caller may clear).
    expect(svc.latestRelease('heey-global', 'verity')).toBeNull();
    await tick();
    expect(calls).toHaveLength(1); // Empty list is settled — not retried each poll.
  });

  it('is inert without a resolvable token — returns undefined (UNKNOWN, not null) and never fetches', async () => {
    const { fetch, calls } = fakeFetch(ok([release]));
    const svc = createGitHubReleaseService({ token: undefined, fetch });
    // UNKNOWN, not "no release": a token-less window must not let a caller clear a
    // previously-persisted release.
    expect(svc.latestRelease('heey-global', 'verity')).toBeUndefined();
    await tick();
    expect(calls).toHaveLength(0);
  });

  it('keeps the last good value on a transient failure past the TTL', async () => {
    const now = vi.fn(() => 1000);
    const { fetch } = fakeFetch(ok([release]), fail(500));
    const svc = createGitHubReleaseService({ token: 'tok', fetch, ttlMs: 100, now });
    svc.latestRelease('heey-global', 'verity');
    await tick();
    now.mockReturnValue(2000); // past TTL → background re-fetch returns 500
    svc.latestRelease('heey-global', 'verity');
    await tick();
    // The 5xx didn't overwrite the cache — the prior release survives.
    expect(svc.latestRelease('heey-global', 'verity')?.tag).toBe('v1.4.0');
  });
});

describe('openPullRequest', () => {
  const target = { owner: 'acme', repo: 'published' };
  const pr = {
    head: 'verity/import-main',
    base: 'main',
    title: 'Import the my-project history',
    body: 'body',
  };

  it('posts head/base to the repo and returns the number + html_url', async () => {
    const { fetch, calls } = fakeFetch(
      ok({ number: 42, html_url: 'https://github.com/acme/published/pull/42' }),
    );
    await expect(openPullRequest(target, 'tok', pr, { fetch })).resolves.toEqual({
      number: 42,
      url: 'https://github.com/acme/published/pull/42',
    });
    expect(calls[0]?.url).toBe('https://api.github.com/repos/acme/published/pulls');
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.headers?.Authorization).toBe('Bearer tok');
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({
      title: pr.title,
      body: pr.body,
      head: 'verity/import-main',
      base: 'main',
    });
  });

  it("surfaces GitHub's own explanation when it declines", async () => {
    const { fetch } = fakeFetch({
      ok: false,
      status: 422,
      json: () => Promise.resolve({ message: 'No commits between main and verity/import-main' }),
    });
    // The reason has to reach the operator verbatim: "could not open a pull request"
    // is the message that sent us hunting through server logs in the first place.
    await expect(openPullRequest(target, 'tok', pr, { fetch })).rejects.toThrow(
      /No commits between main and verity\/import-main/,
    );
  });

  it('reports a transport failure as a pull-request failure, not a crash', async () => {
    const { fetch } = fakeFetch(() => Promise.reject(new Error('socket hang up')));
    await expect(openPullRequest(target, 'tok', pr, { fetch })).rejects.toThrow(/socket hang up/);
  });

  it('falls back to a derived url when GitHub omits html_url', async () => {
    const { fetch } = fakeFetch(ok({ number: 9 }));
    await expect(openPullRequest(target, 'tok', pr, { fetch })).resolves.toEqual({
      number: 9,
      url: 'https://github.com/acme/published/pull/9',
    });
  });

  it('rejects a response without a usable number rather than inventing one', async () => {
    const { fetch } = fakeFetch(ok({ html_url: 'https://github.com/acme/published/pull/0' }));
    await expect(openPullRequest(target, 'tok', pr, { fetch })).rejects.toThrow(/without a number/);
  });
});
