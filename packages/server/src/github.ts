import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import type { GitOutput } from './branches.js';

const execFileAsync = promisify(execFile);
const defaultGit: GitOutput = async (args) => (await execFileAsync('git', [...args])).stdout;

/**
 * Looks up the open PR number for a branch from GitHub (issue #125), so the mobile
 * header can show `PR #N` alongside the branch-derived `Issue #N`. Independent of
 * the issue chip: a branch may have a PR but no parseable issue, or vice versa.
 *
 * Degrades gracefully to `null` on every failure path (no token, no GitHub remote,
 * API error, branch with no open PR) — the header simply shows no PR chip and never
 * errors. Results are cached per branch with a TTL so the branch endpoint can be hit
 * repeatedly without hammering the API / burning rate limit.
 */
export interface GitHubPrService {
  /** The open PR number whose head is `branch`, or null if there's no open PR / the
   *  lookup couldn't run. Never throws. Cached per branch for the configured TTL. */
  prForBranch(branch: string): Promise<number | null>;
  /** Compact live status for the open PR whose head is `branch`, or null if absent /
   * unavailable. Includes title, URL and aggregate check-run counts for the head SHA. */
  prStatusForBranch(branch: string): Promise<PullRequestStatus | null>;
  /**
   * The PR that best represents a session spanning SEVERAL branches (issue: the PR
   * bar stays empty when a session's PR is on a branch other than its worktree HEAD).
   * Looks each branch up (reusing the per-branch cache) and returns the most-recently-
   * updated OPEN PR among them, so a multi-phase session that pushed a differently-
   * named branch than its worktree HEAD still surfaces its PR. With no open PR
   * anywhere it falls back to the FIRST branch's own status (caller passes the
   * worktree HEAD first) — so a single-branch session behaves exactly as
   * {@link prStatusForBranch}. Never throws.
   */
  prStatusForBranches(branches: readonly string[]): Promise<PullRequestStatus | null>;
  /** Merge an open PR by number. Returns false when GitHub rejects or is unavailable. */
  mergePr(number: number, expectedHeadSha?: string): Promise<boolean>;
}

export interface PullRequestStatus {
  number: number;
  title: string;
  url: string;
  phase: 'open' | 'merged' | 'closed';
  /** The PR's `updated_at` (ISO 8601, UTC `Z`), when GitHub reported it. Used to rank
   * open PRs across a multi-branch session's branches — ISO UTC strings sort
   * chronologically. Omitted when absent from the row. */
  updatedAt?: string;
  /** Head commit SHA for the PR branch, used to dedupe per-commit automation. */
  headSha?: string;
  /** Merge commit whose workflow runs back the post-merge status. Kept separate from
   * `headSha`: the latter is the old PR branch tip and cannot identify the commit on
   * the base branch whose Actions Verity is reporting. */
  mergeCommitSha?: string;
  pipeline: 'pending' | 'running' | 'success' | 'failure' | 'unknown';
  checks: {
    completed: number;
    total: number;
    successful: number;
    failed: number;
    pending: number;
  };
  /** Tri-state: `true` = GitHub confirmed the PR merges cleanly, `false` = a genuine
   * conflict / blocked merge, `null` = unknown — not applicable (not open, checks not
   * green) OR GitHub is still computing mergeability (the seconds-long window right
   * after a push). `null` must NOT be rendered as "blocked": that flashes a freshly
   * green PR red until GitHub finishes the background merge check. */
  mergeable: boolean | null;
  /** GitHub's `mergeable_state` for the PR, when it was queried. `'dirty'` is the
   * one state the UI and the repair automation act on: the head branch CONFLICTS
   * with the base, so GitHub builds no merge ref and never starts the
   * `pull_request` workflows — the PR then reports zero checks and would otherwise
   * read as "status unavailable" forever. Omitted when mergeability wasn't queried
   * (not open, or the cheap path skipped the detail call). */
  mergeState?: 'clean' | 'dirty' | 'blocked' | 'behind' | 'unstable' | 'draft' | 'unknown';
  /** The PR's base branch (e.g. `main`), so the conflict UI and the repair prompt can
   * name the branch to merge in. Omitted when absent from the row. */
  baseRef?: string;
  /** Tip commit of that base branch, as GitHub reports it on the PR row (it tracks the
   * branch, it is not frozen at PR creation). A conflict is a property of the PAIR, so
   * the repair automation keys on this alongside the head SHA: the base moving is what
   * can introduce a conflict without the head changing at all. Free — same row as
   * `baseRef`, no extra request. Omitted when absent from the row. */
  baseSha?: string;
}

/** Minimal structural subset of the WHATWG `fetch` response the service needs —
 * narrow so tests can supply a fake without constructing a real `Response`.
 * `headers` is optional so single-page fixtures can omit it; the installation-
 * repo service reads `Link` for pagination and degrades to one page without it. */
export interface HttpResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  /** Raw response body as text. Optional because most callers only need
   *  `json()`; the Docker `/images/create` stream (NDJSON progress, not a
   *  single JSON document) is read via this so the client can scan each line
   *  for an in-stream `{"error":...}` object (see {@link DockerClient.pullImage}).
   *  The global `fetch` Response provides this natively; the unix-socket
   *  transport buffers the full body and exposes it here too. */
  text?(): Promise<string>;
  /** Raw response bytes. Docker log framing must be decoded before UTF-8 text conversion. */
  arrayBuffer?(): Promise<ArrayBuffer>;
  headers?: { get(name: string): string | null };
  /** Native fetch response body. Security-sensitive clients use it for bounded streaming reads. */
  body?: ReadableStream<Uint8Array> | null;
}
export type HttpFetch = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    signal?: AbortSignal;
    body?: string;
  },
) => Promise<HttpResponse>;

/**
 * The GitHub token, provided at the composition root (never read from `process.env`
 * here, never logged). Either a static string OR a provider fn re-consulted on EACH
 * lookup — the provider lets the server track a rotating token (the fleet's ~1h
 * `~/.gh-token`, refreshed by `heey-token-mint`, #131) without a restart, since the
 * service reads it freshly per lookup instead of capturing it once at startup. When
 * it resolves to absent the service is inert (every lookup returns null) until a
 * token appears.
 */
export type GitHubTokenSource = string | (() => string | undefined);

export interface GitHubPrServiceOptions {
  /** The repo whose `origin` remote identifies the GitHub owner/name (e.g. /work). */
  repoDir: string;
  /** GitHub token or token provider — see {@link GitHubTokenSource}. */
  token?: GitHubTokenSource | undefined;
  /** Async GitHub token provider, used when no sync token resolves. */
  asyncToken?: ((owner: string, repo: string) => Promise<string | undefined>) | undefined;
  /** Injected git runner (tests); defaults to the real `git`. */
  git?: GitOutput;
  /** Injected fetch (tests); defaults to the global `fetch`. */
  fetch?: HttpFetch;
  /** Per-branch cache TTL in ms (default 15s — matches the settled PR status poll). */
  ttlMs?: number;
  /** TTL in ms for a NEGATIVE ("no PR for this branch yet") answer (default 4s,
   * capped at `ttlMs`). Kept short on purpose: a PR the agent opens mid-session must
   * not stay pinned as "none" for the full TTL — that was why the PR bar only showed
   * up after a full app reload. A found PR still caches for the full `ttlMs`. */
  negativeTtlMs?: number;
  /** Retry backoff after GitHub rejects/fails a lookup (default 60s). Prevents a
   * rate-limited installation token from being hammered by every UI poll. */
  failureBackoffMs?: number;
  /** Returns mutable failure state shared by services for the same repository. */
  failureCooldownFor?: (owner: string, repo: string) => { until: number; inFlight?: Promise<void> };
  /** Per-request timeout in ms (default 8s) so a hung GitHub connection can't stall
   * the branches endpoint past the platform's socket default. A timeout aborts the
   * fetch, which degrades to null like any other failure. */
  timeoutMs?: number;
  /** Clock seam (tests). */
  now?: () => number;
}

/**
 * Extract `{ owner, repo }` from an `origin` remote URL — handles the SCP-style
 * `git@github.com:owner/repo.git`, `ssh://git@github.com/owner/repo`, and
 * `https://github.com/owner/repo(.git)` forms (with or without an embedded
 * `user:token@` credential, which is matched-past and discarded — never returned).
 * Returns null for any non-GitHub or unparseable remote.
 */
export function parseGitHubRemote(remoteUrl: string): { owner: string; repo: string } | null {
  let url = remoteUrl.trim();
  if (url.endsWith('.git')) url = url.slice(0, -4);
  const scp = /^(?:[^@/]+@)?github\.com:([^/]+)\/([^/]+?)\/?$/.exec(url);
  let match = scp;
  if (match === null) {
    try {
      const parsed = new URL(url);
      if (!['https:', 'ssh:', 'git:'].includes(parsed.protocol) || parsed.hostname !== 'github.com')
        return null;
      match = /^\/([^/]+)\/([^/]+?)\/?$/.exec(parsed.pathname);
    } catch {
      return null;
    }
  }
  if (match === null) return null;
  const [, owner, repo] = match;
  if (owner === undefined || repo === undefined || owner === '' || repo === '') return null;
  return { owner, repo };
}

/** GitHub repo identity (owner/name) resolved from the `origin` remote. */
export type GitHubIdentity = { owner: string; repo: string };

/** A memoized lookup of the repo's `{ owner, repo }` GitHub identity — see
 *  {@link makeIdentityResolver}. Returns null when there's no GitHub `origin`. */
export type GitHubIdentityResolver = () => Promise<GitHubIdentity | null>;

/**
 * A memoized resolver for the repo's `{ owner, repo }` from its `origin` remote.
 * The origin URL is stable for the server's lifetime, so it's read once and cached.
 * Returns null when there's no origin or it isn't a GitHub remote. Shared by the PR
 * and issue services so both parse the remote identically (and only once each).
 */
function makeIdentityResolver(git: GitOutput, repoDir: string): GitHubIdentityResolver {
  let identityPromise: Promise<GitHubIdentity | null> | undefined;
  return () => {
    identityPromise ??= (async () => {
      try {
        const url = (await git(['-C', repoDir, 'remote', 'get-url', 'origin'])).trim();
        return parseGitHubRemote(url);
      } catch {
        return null;
      }
    })();
    return identityPromise;
  };
}

/**
 * A standalone, memoized {@link GitHubIdentityResolver} for the repo at `repoDir`,
 * for callers that need the `{ owner, repo }` without a PR/issue service — e.g. the
 * branches route, which surfaces owner/repo so the mobile header can build tappable
 * GitHub URLs for its Issue/PR chips (#161). Parses the `origin` remote with the same
 * {@link parseGitHubRemote} the services use (no duplicated parsing), and returns null
 * for a non-GitHub / absent origin so the chips degrade to non-tappable.
 */
export function createGitHubIdentityResolver(
  repoDir: string,
  git: GitOutput = defaultGit,
): GitHubIdentityResolver {
  return makeIdentityResolver(git, repoDir);
}

/**
 * Resolve a {@link GitHubTokenSource} to a usable token freshly on each call — a
 * provider fn is re-consulted (it may rotate, #131); a string source is constant.
 * Empty/whitespace reads as absent (`undefined`), which makes the caller inert.
 *
 * Exported so the GraphQL task service (`github-tasks.ts`) resolves the rotating
 * token identically — same inert-when-absent semantics — without duplicating it.
 */
export function makeTokenResolver(token: GitHubTokenSource | undefined): () => string | undefined {
  return () => {
    const raw = typeof token === 'function' ? token() : token;
    const trimmed = raw?.trim();
    return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined;
  };
}

/** The Authorization + content-negotiation headers every GitHub REST call needs.
 * The token is never logged. */
function githubHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'verity-server',
  };
}

/** A pull request Verity opened itself. */
export interface OpenedPullRequest {
  number: number;
  /** `html_url` — the page an operator opens, not the API url. */
  url: string;
}

/** Raised when GitHub declines to open the pull request. `message` carries GitHub's
 *  own explanation (e.g. "No commits between main and verity/import-…"), never the
 *  token: only `body.message` is read, and the request is never echoed back. */
class PullRequestCreateError extends Error {}

/**
 * Open a pull request with a ONE-SHOT token, outside {@link createGitHubPrService}'s
 * caching read path: linking a local project mints a token scoped to the target repo
 * for that single operation, and there is no `repoDir` whose `origin` identifies it
 * yet — the repository is precisely what the project does not have.
 */
export async function openPullRequest(
  target: { owner: string; repo: string },
  token: string,
  pr: { head: string; base: string; title: string; body: string },
  opts: { fetch?: HttpFetch; timeoutMs?: number } = {},
): Promise<OpenedPullRequest> {
  const doFetch: HttpFetch = opts.fetch ?? ((url, init) => fetch(url, init));
  const url = `https://api.github.com/repos/${target.owner}/${target.repo}/pulls`;
  let res: HttpResponse;
  try {
    res = await doFetch(url, {
      method: 'POST',
      headers: githubHeaders(token),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
      body: JSON.stringify({ title: pr.title, body: pr.body, head: pr.head, base: pr.base }),
    });
  } catch (cause) {
    throw new PullRequestCreateError(
      `opening the pull request failed: ${cause instanceof Error ? cause.message : 'network error'}`,
    );
  }
  const body: unknown = await res.json().catch(() => null);
  const fields =
    body !== null && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  if (!res.ok) {
    const detail = typeof fields.message === 'string' ? fields.message : `HTTP ${res.status}`;
    throw new PullRequestCreateError(`GitHub declined to open the pull request: ${detail}`);
  }
  const number = fields.number;
  const htmlUrl = fields.html_url;
  if (typeof number !== 'number' || !Number.isInteger(number) || number <= 0) {
    throw new PullRequestCreateError('GitHub returned a pull request without a number');
  }
  return {
    number,
    url:
      typeof htmlUrl === 'string' && htmlUrl.length > 0
        ? htmlUrl
        : `https://github.com/${target.owner}/${target.repo}/pull/${String(number)}`,
  };
}

export function createGitHubPrService(opts: GitHubPrServiceOptions): GitHubPrService {
  const git = opts.git ?? defaultGit;
  const doFetch: HttpFetch = opts.fetch ?? ((url, init) => fetch(url, init));
  const ttlMs = opts.ttlMs ?? 15_000;
  const negativeTtlMs = Math.min(opts.negativeTtlMs ?? 4_000, ttlMs);
  const failureBackoffMs = opts.failureBackoffMs ?? 60_000;
  const timeoutMs = opts.timeoutMs ?? 8_000;
  const now = opts.now ?? ((): number => Date.now());
  // Resolve the token freshly each time (a provider may rotate it, #131).
  const resolveToken = makeTokenResolver(opts.token);
  // Resolve the repo identity once and memoize it (the origin remote is stable).
  const identity = makeIdentityResolver(git, opts.repoDir);

  const cache = new Map<string, { status: PullRequestStatus | null; at: number }>();
  const lastCacheByBranch = new Map<string, { status: PullRequestStatus | null; at: number }>();
  const localFailureCooldown: { until: number; inFlight?: Promise<void> } = { until: 0 };
  // Conditional REST responses do not consume the primary GitHub rate limit when
  // GitHub answers 304. PR polling repeatedly reads the same small set of URLs, so
  // retaining each response's ETag avoids spending several requests per session on
  // unchanged data while preserving the existing refresh cadence.
  const responseCache = new Map<string, { etag: string; body: unknown }>();
  const credentialId = (token: string): string =>
    createHash('sha256').update(token).digest('base64url');
  const emptyChecks = { completed: 0, total: 0, successful: 0, failed: 0, pending: 0 };

  const fetchJson = async (url: string, token: string): Promise<{ ok: boolean; body: unknown }> => {
    try {
      const responseKey = `${credentialId(token)}\0${url}`;
      const cachedResponse = responseCache.get(responseKey);
      const res = await doFetch(url, {
        headers: {
          ...githubHeaders(token),
          ...(cachedResponse === undefined ? {} : { 'If-None-Match': cachedResponse.etag }),
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status === 304 && cachedResponse !== undefined) {
        return { ok: true, body: cachedResponse.body };
      }
      if (!res.ok) return { ok: false, body: null };
      const body = await res.json();
      const etag = res.headers?.get('etag');
      if (etag !== undefined && etag !== null && etag !== '') {
        responseCache.set(responseKey, { etag, body });
      }
      return { ok: true, body };
    } catch {
      return { ok: false, body: null };
    }
  };

  const pipelineFromChecks = (
    checks: PullRequestStatus['checks'],
  ): PullRequestStatus['pipeline'] => {
    if (checks.total === 0) return 'unknown';
    // A failure is a failure even while other jobs are still queued — surface red
    // immediately (fail-fast) rather than hiding it behind a spinner until every
    // job finishes. Otherwise a PR that has already failed reads as "still running".
    if (checks.failed > 0) return 'failure';
    if (checks.pending > 0) return 'running';
    return 'success';
  };

  const countsFromRuns = (runs: unknown[]): PullRequestStatus['checks'] => {
    let completed = 0;
    let successful = 0;
    let failed = 0;
    let ignored = 0;
    for (const run of runs) {
      if (run === null || typeof run !== 'object' || Array.isArray(run)) continue;
      const r = run as Record<string, unknown>;
      if (r.status === 'completed') {
        if (r.conclusion === 'cancelled') {
          ignored += 1;
          continue;
        }
        completed += 1;
        const conclusion = r.conclusion;
        if (conclusion === 'success' || conclusion === 'neutral' || conclusion === 'skipped') {
          successful += 1;
        } else {
          failed += 1;
        }
      }
    }
    // Cancellation is not a CI result Verity asks the user to act on. Omit it from
    // both the aggregate shown to the user and the automation fed by that aggregate.
    const total = runs.length - ignored;
    return { completed, total, successful, failed, pending: Math.max(total - completed, 0) };
  };

  // GitHub reports commit signals through TWO independent systems: the Checks API
  // (check-runs) and the legacy Commit Statuses API. Many external CIs (and branch
  // "required status checks") only ever post the latter, so a PR can be red under
  // commit statuses while its check-runs are all green — reading only check-runs
  // would show that failed PR as passing. We count both and merge them.
  const countsFromStatuses = (statuses: unknown[]): PullRequestStatus['checks'] => {
    let completed = 0;
    let successful = 0;
    let failed = 0;
    let pending = 0;
    for (const status of statuses) {
      if (status === null || typeof status !== 'object' || Array.isArray(status)) continue;
      const state = (status as Record<string, unknown>).state;
      if (state === 'success') {
        completed += 1;
        successful += 1;
      } else if (state === 'failure' || state === 'error') {
        completed += 1;
        failed += 1;
      } else if (state === 'pending') {
        pending += 1;
      }
    }
    return { completed, total: statuses.length, successful, failed, pending };
  };

  const mergeChecks = (
    a: PullRequestStatus['checks'],
    b: PullRequestStatus['checks'],
  ): PullRequestStatus['checks'] => ({
    completed: a.completed + b.completed,
    total: a.total + b.total,
    successful: a.successful + b.successful,
    failed: a.failed + b.failed,
    pending: a.pending + b.pending,
  });

  type CheckCountsResult = { ok: true; checks: PullRequestStatus['checks'] } | { ok: false };

  const checkRunCounts = async (
    id: GitHubIdentity,
    sha: string,
    token: string,
  ): Promise<CheckCountsResult> => {
    const runs: unknown[] = [];
    for (let page = 1; page <= 100; page += 1) {
      const url =
        `https://api.github.com/repos/${id.owner}/${id.repo}/commits/${encodeURIComponent(sha)}` +
        `/check-runs?per_page=100${page === 1 ? '' : `&page=${String(page)}`}`;
      const res = await fetchJson(url, token);
      if (!res.ok || res.body === null || typeof res.body !== 'object' || Array.isArray(res.body)) {
        return { ok: false };
      }
      const pageRuns = (res.body as Record<string, unknown>).check_runs;
      if (!Array.isArray(pageRuns)) return { ok: false };
      for (const run of pageRuns) runs.push(run);
      const total = (res.body as Record<string, unknown>).total_count;
      if (pageRuns.length < 100 || (typeof total === 'number' && runs.length >= total)) break;
      if (page === 100) return { ok: false };
    }
    return { ok: true, checks: countsFromRuns(runs) };
  };

  const commitStatusCounts = async (
    id: GitHubIdentity,
    sha: string,
    token: string,
  ): Promise<CheckCountsResult> => {
    const statuses: unknown[] = [];
    // `statuses` is empty when the repo uses no legacy statuses; the endpoint's own
    // rollup `state` is 'pending' in that case, so we count the array (0 → no-op),
    // never the rollup — otherwise a check-runs-only repo would look forever pending.
    for (let page = 1; page <= 100; page += 1) {
      const url =
        `https://api.github.com/repos/${id.owner}/${id.repo}/commits/${encodeURIComponent(sha)}` +
        `/status?per_page=100${page === 1 ? '' : `&page=${String(page)}`}`;
      const res = await fetchJson(url, token);
      if (!res.ok || res.body === null || typeof res.body !== 'object' || Array.isArray(res.body)) {
        return { ok: false };
      }
      const pageStatuses = (res.body as Record<string, unknown>).statuses;
      if (!Array.isArray(pageStatuses)) return { ok: false };
      for (const status of pageStatuses) statuses.push(status);
      if (pageStatuses.length < 100) break;
      if (page === 100) return { ok: false };
    }
    return { ok: true, checks: countsFromStatuses(statuses) };
  };

  const checkCounts = async (
    id: GitHubIdentity,
    sha: string,
    token: string,
  ): Promise<CheckCountsResult> => {
    const [runs, statuses] = await Promise.all([
      checkRunCounts(id, sha, token),
      commitStatusCounts(id, sha, token),
    ]);
    if (runs.ok && statuses.ok)
      return { ok: true, checks: mergeChecks(runs.checks, statuses.checks) };
    // GitHub App installation tokens can read check-runs while the legacy combined
    // commit-status endpoint returns 403 for the same repo. Do not hide the PR bar
    // in that case; use whichever signal source is available.
    if (runs.ok) return runs;
    if (statuses.ok) return statuses;
    return { ok: false };
  };

  const workflowRunCounts = async (
    id: GitHubIdentity,
    sha: string,
    token: string,
  ): Promise<CheckCountsResult> => {
    const runs: unknown[] = [];
    for (let page = 1; page <= 100; page += 1) {
      const url =
        `https://api.github.com/repos/${id.owner}/${id.repo}/actions/runs` +
        `?head_sha=${encodeURIComponent(sha)}&per_page=100${page === 1 ? '' : `&page=${String(page)}`}`;
      const res = await fetchJson(url, token);
      if (!res.ok || res.body === null || typeof res.body !== 'object' || Array.isArray(res.body)) {
        return { ok: false };
      }
      const pageRuns = (res.body as Record<string, unknown>).workflow_runs;
      if (!Array.isArray(pageRuns)) return { ok: false };
      for (const run of pageRuns as unknown[]) runs.push(run);
      const total = (res.body as Record<string, unknown>).total_count;
      if (pageRuns.length < 100 || (typeof total === 'number' && runs.length >= total)) break;
      if (page === 100) return { ok: false };
    }
    return { ok: true, checks: countsFromRuns(runs) };
  };

  const MERGE_STATES: readonly NonNullable<PullRequestStatus['mergeState']>[] = [
    'clean',
    'dirty',
    'blocked',
    'behind',
    'unstable',
    'draft',
    'unknown',
  ];
  const mergeStateOf = (body: Record<string, unknown>): PullRequestStatus['mergeState'] => {
    const raw = body.mergeable_state;
    return typeof raw === 'string' &&
      (MERGE_STATES as readonly string[]).includes(raw) &&
      raw !== 'unknown'
      ? (raw as NonNullable<PullRequestStatus['mergeState']>)
      : undefined;
  };

  const openPrMergeable = async (
    id: GitHubIdentity,
    number: number,
    token: string,
  ): Promise<
    { ok: true; value: boolean | null; mergeState: PullRequestStatus['mergeState'] } | { ok: false }
  > => {
    const url = `https://api.github.com/repos/${id.owner}/${id.repo}/pulls/${String(number)}`;
    const res = await fetchJson(url, token);
    if (!res.ok || res.body === null || typeof res.body !== 'object' || Array.isArray(res.body)) {
      return { ok: false };
    }
    const body = res.body as Record<string, unknown>;
    const mergeable = body.mergeable;
    return mergeable === null || typeof mergeable === 'boolean'
      ? { ok: true, value: mergeable, mergeState: mergeStateOf(body) }
      : { ok: false };
  };

  // One GitHub query. Distinguishes a successful answer (200, possibly "no PR" =
  // null) from a hard failure, so only real answers get cached — a transient error
  // doesn't pin a stale null for the whole TTL.
  const lookup = async (
    id: GitHubIdentity,
    branch: string,
    token: string,
  ): Promise<{ ok: boolean; status: PullRequestStatus | null }> => {
    try {
      const head = encodeURIComponent(`${id.owner}:${branch}`);
      const url =
        `https://api.github.com/repos/${id.owner}/${id.repo}/pulls` +
        `?head=${head}&state=all&sort=updated&direction=desc&per_page=100`;
      const res = await fetchJson(url, token);
      if (!res.ok) return { ok: false, status: null };
      const body = res.body;
      if (!Array.isArray(body) || body.length === 0) return { ok: true, status: null };
      const rows: unknown[] = body;
      const raw =
        rows.find(
          (candidate) =>
            candidate !== null &&
            typeof candidate === 'object' &&
            !Array.isArray(candidate) &&
            (candidate as Record<string, unknown>).state === 'open',
        ) ?? rows[0];
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        return { ok: true, status: null };
      }
      const pr = raw as Record<string, unknown>;
      const num = pr.number;
      const title = pr.title;
      const htmlUrl = pr.html_url;
      const stateRaw = pr.state;
      const updatedAt = pr.updated_at;
      const mergedAt = pr.merged_at;
      const mergeCommitSha = pr.merge_commit_sha;
      const headObj = pr.head;
      const sha =
        headObj !== null && typeof headObj === 'object' && !Array.isArray(headObj)
          ? (headObj as Record<string, unknown>).sha
          : undefined;
      const baseObj =
        pr.base !== null && typeof pr.base === 'object' && !Array.isArray(pr.base)
          ? (pr.base as Record<string, unknown>)
          : undefined;
      const baseRef = baseObj?.ref;
      const baseSha = baseObj?.sha;
      if (typeof num !== 'number' || !Number.isInteger(num) || num <= 0) {
        return { ok: true, status: null };
      }
      const phase: PullRequestStatus['phase'] =
        stateRaw === 'open'
          ? 'open'
          : typeof mergedAt === 'string' && mergedAt.length > 0
            ? 'merged'
            : 'closed';
      const statusSha =
        phase === 'merged' && typeof mergeCommitSha === 'string' && mergeCommitSha.length > 0
          ? mergeCommitSha
          : typeof sha === 'string'
            ? sha
            : undefined;
      const checksResult: CheckCountsResult =
        statusSha === undefined
          ? { ok: true, checks: emptyChecks }
          : phase === 'merged'
            ? await workflowRunCounts(id, statusSha, token)
            : await checkCounts(id, statusSha, token);
      if (!checksResult.ok) return { ok: false, status: null };
      const checks = checksResult.checks;
      const pipeline = pipelineFromChecks(checks);
      // Ask GitHub for mergeability on every SETTLED open PR — green, red, or with no
      // checks at all — and never while checks are still running.
      //
      // Green is the merge-button path: mergeability decides whether it lights up.
      //
      // No checks at all is the conflict trap this feature exists for: a PR that
      // conflicts with its base gets no merge ref, so GitHub never starts the
      // `pull_request` workflows, `checks.total` stays 0 and the pipeline reads
      // `unknown` forever. Without this call the bar could only say "status
      // unavailable" and nothing could react to the conflict.
      //
      // Red matters because a branch with `on: push` workflows keeps reporting checks
      // even while it conflicts — the workflows run on the branch head, which needs no
      // merge ref. Such a PR has a real conflict AND real failures at once, and it is
      // the only way that pair can arise. Skipping it would leave the conflict
      // invisible behind a CI failure the agent cannot fix without merging the base
      // first, and would make the conflict-before-CI repair precedence unreachable.
      //
      // Running/pending stays off the path deliberately: that is the state a busy PR
      // polls in most often, nothing can act on either signal until checks settle, and
      // the poll right after they do picks the conflict up.
      //
      // Keep the raw tri-state: `openPrMergeable` returns `null` while GitHub is still
      // computing it, which must stay `null` — coercing it to `false` here is what made
      // a just-fixed, now-green PR read as "blocked".
      const greenPath = phase === 'open' && pipeline === 'success';
      const conflictProbe =
        phase === 'open' && !greenPath && (checks.total === 0 || pipeline === 'failure');
      const mergeability =
        greenPath || conflictProbe
          ? await openPrMergeable(id, num, token)
          : { ok: true as const, value: null, mergeState: undefined };
      // A failed lookup is only fatal on the green path, where mergeability decides
      // whether the merge button lights up. The conflict probe is BEST-EFFORT: it fires
      // on states every PR passes through normally — no checks yet is how each one
      // starts — and dropping the whole status because the detail call hiccuped would
      // make the PR chip disappear from the session, a far worse failure than not yet
      // knowing whether it conflicts. Degrade to "no conflict signal", retry next poll.
      if (!mergeability.ok && greenPath) return { ok: false, status: null };
      const mergeable = mergeability.ok ? mergeability.value : null;
      const mergeState = mergeability.ok ? mergeability.mergeState : undefined;
      return {
        ok: true,
        status: {
          number: num,
          title: typeof title === 'string' && title.length > 0 ? title : `PR #${String(num)}`,
          url:
            typeof htmlUrl === 'string' && htmlUrl.length > 0
              ? htmlUrl
              : `https://github.com/${id.owner}/${id.repo}/pull/${String(num)}`,
          phase,
          ...(typeof updatedAt === 'string' && updatedAt.length > 0 ? { updatedAt } : {}),
          ...(typeof sha === 'string' && sha.length > 0 ? { headSha: sha } : {}),
          ...(phase === 'merged' && typeof mergeCommitSha === 'string' && mergeCommitSha.length > 0
            ? { mergeCommitSha }
            : {}),
          pipeline,
          checks,
          mergeable,
          ...(mergeState === undefined ? {} : { mergeState }),
          ...(typeof baseRef === 'string' && baseRef.length > 0 ? { baseRef } : {}),
          ...(typeof baseSha === 'string' && baseSha.length > 0 ? { baseSha } : {}),
        },
      };
    } catch {
      return { ok: false, status: null };
    }
  };

  const prStatusForBranch = async (branch: string): Promise<PullRequestStatus | null> => {
    if (branch === '') return null;
    const id = await identity();
    if (id === null) return null;
    let cached = lastCacheByBranch.get(branch);
    const unavailableCachedStatus = (): PullRequestStatus | null => {
      if (cached?.status === undefined || cached.status === null) return null;
      // Drop every live signal, `mergeState` included: while GitHub is unreachable we
      // can't know whether a cached conflict still stands, and a stale `dirty` would
      // keep the conflict UI red (and re-arm the repair automation) on no evidence.
      const stale = { ...cached.status };
      delete stale.mergeState;
      return {
        ...stale,
        pipeline: 'unknown',
        checks: emptyChecks,
        mergeable: null,
      };
    };
    const failureCooldown = opts.failureCooldownFor?.(id.owner, id.repo) ?? localFailureCooldown;
    if (now() < failureCooldown.until) {
      return unavailableCachedStatus();
    }
    let releaseProbe: (() => void) | undefined;
    let probe: Promise<void> | undefined;
    // Normal refreshes remain concurrent. Only the first request after an expired
    // failure cooldown becomes the recovery probe; waiters either observe its new
    // cooldown or are released together when it succeeds and resets `until`.
    if (failureCooldown.until > 0) {
      while (failureCooldown.inFlight !== undefined) {
        await failureCooldown.inFlight;
        if (now() < failureCooldown.until) return unavailableCachedStatus();
        if (failureCooldown.until === 0) break;
      }
      if (failureCooldown.until > 0) {
        probe = new Promise<void>((resolve) => {
          releaseProbe = resolve;
        });
        failureCooldown.inFlight = probe;
      }
    }
    try {
      const tokenUnavailable = (): PullRequestStatus | null => {
        failureCooldown.until = Math.max(failureCooldown.until, now() + failureBackoffMs);
        return unavailableCachedStatus();
      };
      let token: string | undefined;
      if (opts.asyncToken !== undefined) {
        try {
          token = await opts.asyncToken(id.owner, id.repo);
        } catch {
          // Fall through to the explicitly configured legacy token source.
        }
      }
      token ??= resolveToken();
      if (token === undefined) {
        return opts.asyncToken === undefined ? (cached?.status ?? null) : tokenUnavailable();
      }
      const cacheKey = `${credentialId(token)}\0${branch}`;
      cached = cache.get(cacheKey);
      if (cached !== undefined) {
        const ttl = cached.status === null ? negativeTtlMs : ttlMs;
        if (now() - cached.at < ttl) return cached.status;
      }
      const result = await lookup(id, branch, token);
      if (result.ok) {
        if (probe !== undefined) failureCooldown.until = 0;
        const entry = { status: result.status, at: now() };
        cache.set(cacheKey, entry);
        lastCacheByBranch.set(branch, entry);
        return result.status;
      }
      // Do not keep presenting an old in-progress count as live forever when GitHub
      // is unavailable or rate-limited. Preserve the PR identity/bar, but make its
      // check state explicitly unknown until a later refresh succeeds.
      failureCooldown.until = Math.max(failureCooldown.until, now() + failureBackoffMs);
      return unavailableCachedStatus();
    } finally {
      if (probe !== undefined && failureCooldown.inFlight === probe) {
        delete failureCooldown.inFlight;
      }
      releaseProbe?.();
    }
  };

  const prStatusForBranches = async (
    branches: readonly string[],
  ): Promise<PullRequestStatus | null> => {
    // Dedupe while preserving order — the caller lists the worktree HEAD first, then
    // the session's other branches most-recently-active first.
    const ordered: string[] = [];
    const seen = new Set<string>();
    for (const b of branches) {
      if (b !== '' && !seen.has(b)) {
        seen.add(b);
        ordered.push(b);
      }
    }
    if (ordered.length === 0) return null;
    const statuses = await Promise.all(ordered.map((b) => prStatusForBranch(b)));
    // Prefer an OPEN PR — the actionable one for a session. Among opens, the most
    // recently updated on GitHub wins; a tie (or a missing `updatedAt`) keeps the
    // earlier — i.e. more-recently-active-in-this-worktree — branch. This is what
    // surfaces a PR on a branch OTHER than the worktree HEAD for multi-branch sessions.
    let best: PullRequestStatus | null = null;
    for (const s of statuses) {
      if (s === null || s.phase !== 'open') continue;
      if (best === null || (s.updatedAt ?? '') > (best.updatedAt ?? '')) best = s;
    }
    if (best !== null) return best;
    // No open PR on any branch → preserve the single-branch answer exactly: the
    // worktree HEAD's own status (a merged/closed PR, or null). Other branches'
    // merged/closed PRs are intentionally ignored so single-branch behavior is
    // unchanged and a stale phase-2 PR can't shadow the session's real HEAD state.
    return statuses[0] ?? null;
  };

  return {
    async prForBranch(branch: string): Promise<number | null> {
      const status = await prStatusForBranch(branch);
      return status?.number ?? null;
    },
    prStatusForBranch,
    prStatusForBranches,
    async mergePr(number: number, expectedHeadSha?: string): Promise<boolean> {
      const id = await identity();
      let token: string | undefined;
      if (id !== null && opts.asyncToken !== undefined) {
        try {
          token = await opts.asyncToken(id.owner, id.repo);
        } catch {
          // Fall through to the explicitly configured legacy token source.
        }
      }
      token ??= resolveToken();
      if (token === undefined || id === null || !Number.isInteger(number) || number <= 0) {
        return false;
      }
      try {
        const url = `https://api.github.com/repos/${id.owner}/${id.repo}/pulls/${String(number)}/merge`;
        const res = await doFetch(url, {
          method: 'PUT',
          headers: githubHeaders(token),
          signal: AbortSignal.timeout(timeoutMs),
          body: JSON.stringify({
            merge_method: 'merge',
            ...(expectedHeadSha !== undefined ? { sha: expectedHeadSha } : {}),
          }),
        });
        if (!res.ok) return false;
        cache.clear();
        return true;
      } catch {
        return false;
      }
    },
  };
}

export interface GhTokenReaderOptions {
  /** Path to the fleet's GH App token file (heey-token-mint keeps it fresh, ~50min,
   * #131). Read freshly so a rotated token is picked up without a server restart. */
  path: string;
  /** Fallback when the file is absent/empty — e.g. a static PAT in the env for a
   * deployment without the token-mint machinery. Consulted only when the file yields
   * nothing, so the (always-fresh) file wins over a possibly-stale env value. */
  env?: () => string | undefined;
  /** Injected file reader (tests); defaults to a UTF-8 read that maps any error
   * (missing/unreadable) to undefined. */
  readFile?: (path: string) => string | undefined;
  /** Re-read the file at most this often (default 30s) — frequent enough to track the
   * ~50min refresh, infrequent enough not to stat the FS on every lookup. */
  ttlMs?: number;
  /** Clock seam (tests). */
  now?: () => number;
}

const defaultReadFile = (path: string): string | undefined => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined; // missing / unreadable → fall back to env
  }
};

/**
 * A token provider for {@link createGitHubPrService} that reads the fleet's rotating
 * `~/.gh-token` (refreshed hourly by `heey-token-mint`) on demand, so the server's
 * PR lookups keep working past the 1h token life without a restart (#131). The read
 * is cached for a short TTL to avoid touching the FS on every lookup; the file value
 * wins over the `env` fallback (the env var is sourced once at shell start and goes
 * stale, while the file is kept current). Returns undefined when neither yields a
 * token — the service is then simply inert until one appears.
 */
export function createGhTokenReader(opts: GhTokenReaderOptions): () => string | undefined {
  const read = opts.readFile ?? defaultReadFile;
  const ttlMs = opts.ttlMs ?? 30_000;
  const now = opts.now ?? ((): number => Date.now());
  let cached: { token: string | undefined; at: number } | undefined;
  return () => {
    if (cached !== undefined && now() - cached.at < ttlMs) return cached.token;
    const fromFile = read(opts.path)?.trim();
    const raw = fromFile !== undefined && fromFile.length > 0 ? fromFile : opts.env?.();
    const token = raw !== undefined && raw.trim().length > 0 ? raw.trim() : undefined;
    cached = { token, at: now() };
    return token;
  };
}

/**
 * One open GitHub issue, trimmed to what the overview backlog needs (#137): the
 * number, title, body (markdown) and html url. Pull requests are excluded by the
 * service (the issues endpoint returns both).
 */
export interface IssueSummary {
  number: number;
  title: string;
  body: string;
  url: string;
}

/**
 * Lists the repo's OPEN issues so the mobile overview can show the backlog and spawn
 * a session straight from one (#137). Like {@link GitHubPrService} it's best-effort:
 * inert (returns `[]`) without a resolvable token or a GitHub origin, and degrades to
 * `[]` (or the last good list) on any API error — the overview just shows no issues
 * rather than erroring. The single-page result is cached with a TTL so a polled
 * overview doesn't burn rate limit.
 */
export interface GitHubIssueService {
  /** Open issues, most-recently-updated first, PRs excluded. Never throws. */
  listOpenIssues(): Promise<IssueSummary[]>;
}

export interface GitHubIssueServiceOptions {
  /** The repo whose `origin` remote identifies the GitHub owner/name. */
  repoDir: string;
  /** GitHub token or token provider — see {@link GitHubTokenSource}. */
  token?: GitHubTokenSource | undefined;
  /** Async repo-scoped token mint, used by DB-backed GitHub App credentials. */
  asyncToken?: ((owner: string, repo: string) => Promise<string | undefined>) | undefined;
  /** Injected git runner (tests); defaults to the real `git`. */
  git?: GitOutput;
  /** Injected fetch (tests); defaults to the global `fetch`. */
  fetch?: HttpFetch;
  /** Cache TTL in ms for the issue list (default 60s, matching the PR service). */
  ttlMs?: number;
  /** Per-request timeout in ms (default 8s) — an abort degrades to `[]`. */
  timeoutMs?: number;
  /** Issues per page (default 50, clamped to GitHub's 1–100). v1 fetches one page;
   * pagination for very large backlogs is a follow-up. */
  perPage?: number;
  /** Clock seam (tests). */
  now?: () => number;
}

/** Map a raw GitHub issue object to an {@link IssueSummary}, or null when the
 *  required fields (number, title) are missing/ill-typed (a garbled row is dropped
 *  rather than crashing the list). */
function toIssueSummary(raw: Record<string, unknown>): IssueSummary | null {
  const { number, title } = raw;
  if (typeof number !== 'number' || !Number.isInteger(number) || number <= 0) return null;
  if (typeof title !== 'string') return null;
  return {
    number,
    title,
    body: typeof raw.body === 'string' ? raw.body : '',
    url: typeof raw.html_url === 'string' ? raw.html_url : '',
  };
}

export function createGitHubIssueService(opts: GitHubIssueServiceOptions): GitHubIssueService {
  const git = opts.git ?? defaultGit;
  const doFetch: HttpFetch = opts.fetch ?? ((url, init) => fetch(url, init));
  const ttlMs = opts.ttlMs ?? 60_000;
  const timeoutMs = opts.timeoutMs ?? 8_000;
  const perPage = Math.min(Math.max(opts.perPage ?? 50, 1), 100);
  const now = opts.now ?? ((): number => Date.now());
  const resolveToken = makeTokenResolver(opts.token);
  const identity = makeIdentityResolver(git, opts.repoDir);

  let cache: { issues: IssueSummary[]; at: number } | undefined;

  // One GitHub query. Like the PR service, distinguishes a real answer (200, possibly
  // empty) from a hard failure so a transient error doesn't pin a stale-empty list.
  const lookup = async (token: string): Promise<{ ok: boolean; issues: IssueSummary[] }> => {
    const id = await identity();
    if (id === null) return { ok: false, issues: [] };
    try {
      const url =
        `https://api.github.com/repos/${id.owner}/${id.repo}/issues` +
        `?state=open&sort=updated&direction=desc&per_page=${String(perPage)}`;
      const res = await doFetch(url, {
        headers: githubHeaders(token),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) return { ok: false, issues: [] };
      const body: unknown = await res.json();
      if (!Array.isArray(body)) return { ok: true, issues: [] };
      const issues = body
        .filter((it): it is Record<string, unknown> => typeof it === 'object' && it !== null)
        // The issues endpoint returns PRs too; a PR carries a `pull_request` field.
        .filter((it) => it.pull_request === undefined)
        .map(toIssueSummary)
        .filter((it): it is IssueSummary => it !== null);
      return { ok: true, issues };
    } catch {
      return { ok: false, issues: [] };
    }
  };

  return {
    async listOpenIssues(): Promise<IssueSummary[]> {
      const id = await identity();
      if (id === null) return [];
      // Prefer the scoped, freshly minted App credential. The synchronous source
      // is only a legacy fallback and may be a stale fleet token.
      let token: string | undefined;
      if (opts.asyncToken !== undefined) {
        try {
          token = await opts.asyncToken(id.owner, id.repo);
        } catch {
          // Fall through to the explicitly configured legacy token source.
        }
      }
      token ??= resolveToken();
      if (token === undefined) return [];
      if (cache !== undefined && now() - cache.at < ttlMs) return cache.issues;
      const result = await lookup(token);
      if (result.ok) {
        cache = { issues: result.issues, at: now() };
        return result.issues;
      }
      // Hard failure: don't cache it; serve the last good list if we have one.
      return cache?.issues ?? [];
    },
  };
}

/**
 * The latest published GitHub release for a repo, trimmed to what the project
 * overview surfaces: the tag, the human release name, its html url and the
 * publish timestamp. Only the `tag` is rendered today (the overview version
 * badge); `name`/`url`/`publishedAt` are carried + persisted for a follow-up
 * detail view / link-out. `null` fields where GitHub omitted them.
 */
export interface ReleaseSummary {
  /** The git tag the release points at (e.g. `v1.4.0`). Always present. */
  tag: string;
  /** The release's display name, or null when unnamed (GitHub falls back to the tag). */
  name: string | null;
  /** The release's html url on GitHub. */
  url: string;
  /** ISO 8601 publish timestamp, or null for a draft/unpublished release. */
  publishedAt: string | null;
}

/**
 * Looks up a repo's LATEST published/prerelease release for the project overview. Unlike the
 * PR/issue services this is NOT scoped to a single `origin` — it takes (owner,
 * repo) per call and serves the whole fleet from one instance (mirrors the
 * installation service's fleet-wide shape), because the overview lists every
 * installed repo.
 *
 * Non-blocking by contract: {@link latestRelease} NEVER awaits the network. It
 * returns the cached answer immediately and refreshes in the BACKGROUND when the
 * entry is stale — so `GET /projects` (polled every few seconds by the overview)
 * stays fast and the version fills in on a subsequent poll. GitHub is hit at most
 * once per repo per `ttlMs`, so a polled overview can't burn rate limit.
 * Best-effort like the sibling services: any failure leaves the last good value
 * in place and never throws.
 *
 * The return TRISTATE lets a persisting caller tell "not known yet" from
 * "confirmed no release" so it can clear a stale persisted value on the latter:
 *   - `undefined` → UNKNOWN: cold cache (a refresh was just kicked) or no token.
 *                   The caller should keep serving whatever it has persisted.
 *   - `null`      → CONFIRMED no published release (GitHub answered an empty list).
 *   - a summary   → the latest published release.
 */
export interface GitHubReleaseService {
  latestRelease(owner: string, repo: string): ReleaseSummary | null | undefined;
  refreshLatestRelease(owner: string, repo: string): Promise<ReleaseSummary | null | undefined>;
}

export interface GitHubReleaseServiceOptions {
  /** GitHub token or token provider — see {@link GitHubTokenSource}. */
  token?: GitHubTokenSource | undefined;
  /** Optional async token provider for callers that can await a refresh, e.g.
   *  DB-backed GitHub App credentials that mint a repo-scoped installation token. */
  asyncToken?: ((owner: string, repo: string) => Promise<string | undefined>) | undefined;
  /** Injected fetch (tests); defaults to the global `fetch`. */
  fetch?: HttpFetch;
  /** Per-repo cache TTL in ms (default 5min — releases change rarely; keeps a
   *  polled overview from hitting GitHub more than ~once/5min/repo). */
  ttlMs?: number;
  /** Per-request timeout in ms (default 8s) — an abort degrades to no-update. */
  timeoutMs?: number;
  /** Clock seam (tests). */
  now?: () => number;
}

/** Map a raw GitHub release object to a {@link ReleaseSummary}, or null when the
 *  tag is missing/ill-typed (a garbled row is dropped rather than shown). The
 *  `html_url` is essentially always present from the releases API; owner/repo
 *  are threaded only for the defensive fallback. */
function toReleaseSummary(
  raw: Record<string, unknown>,
  owner: string,
  repo: string,
): ReleaseSummary | null {
  const tag = raw.tag_name;
  if (typeof tag !== 'string' || tag === '') return null;
  const name = raw.name;
  const url = raw.html_url;
  const publishedAt = raw.published_at;
  return {
    tag,
    name: typeof name === 'string' && name.length > 0 ? name : null,
    url:
      typeof url === 'string' && url.length > 0
        ? url
        : `https://github.com/${owner}/${repo}/releases/tag/${encodeURIComponent(tag)}`,
    publishedAt: typeof publishedAt === 'string' && publishedAt.length > 0 ? publishedAt : null,
  };
}

export function createGitHubReleaseService(
  opts: GitHubReleaseServiceOptions,
): GitHubReleaseService {
  const doFetch: HttpFetch = opts.fetch ?? ((url, init) => fetch(url, init));
  const ttlMs = opts.ttlMs ?? 300_000;
  const timeoutMs = opts.timeoutMs ?? 8_000;
  const now = opts.now ?? ((): number => Date.now());
  const resolveToken = makeTokenResolver(opts.token);

  // Per-repo cache. `at` timestamps the last SETTLED answer (200 or 404) so a
  // fresh entry short-circuits; `release` is null for "no releases yet".
  const cache = new Map<string, { release: ReleaseSummary | null; at: number }>();
  // In-flight guard so overlapping polls don't fire duplicate refreshes for the
  // same repo — the fetch is fire-and-forget, so without this a burst of polls
  // during a cold/stale window would each launch their own request.
  const inflight = new Map<string, Promise<void>>();

  const refresh = async (
    owner: string,
    repo: string,
    key: string,
    token: string,
  ): Promise<void> => {
    try {
      // Do not use `/releases/latest`: GitHub intentionally excludes prereleases
      // there, so monorepos that publish package prereleases look empty. The list
      // endpoint returns releases + prereleases in reverse chronological order.
      // Walk pages until the first visible release; only a fully exhausted list is
      // the unambiguous "no published releases" answer.
      let nextUrl: string | null =
        `https://api.github.com/repos/${owner}/${repo}/releases?per_page=100`;
      while (nextUrl !== null) {
        const res = await doFetch(nextUrl, {
          headers: githubHeaders(token),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) return; // transient failure: keep the last good value
        const body: unknown = await res.json();
        if (!Array.isArray(body)) return;
        for (const item of body) {
          if (item === null || typeof item !== 'object' || Array.isArray(item)) continue;
          if ((item as Record<string, unknown>).draft === true) continue;
          const summary = toReleaseSummary(item as Record<string, unknown>, owner, repo);
          if (summary !== null) {
            cache.set(key, { release: summary, at: now() });
            return;
          }
        }
        nextUrl = nextLink(extractLinkHeader(res));
        if (nextUrl !== null) {
          const parsed = new URL(nextUrl);
          if (
            parsed.protocol !== 'https:' ||
            parsed.hostname !== 'api.github.com' ||
            parsed.pathname !== `/repos/${owner}/${repo}/releases`
          )
            return;
        }
      }
      cache.set(key, { release: null, at: now() });
    } catch {
      // Network error / abort: leave the cache untouched (serve last good / null).
    } finally {
      inflight.delete(key);
    }
  };

  const startRefresh = (owner: string, repo: string, key: string, token: string): Promise<void> => {
    let pending = inflight.get(key);
    if (pending === undefined) {
      pending = refresh(owner, repo, key, token);
      inflight.set(key, pending);
    }
    return pending;
  };

  return {
    latestRelease(owner: string, repo: string): ReleaseSummary | null | undefined {
      // Inert without a currently-resolvable token (GitHub not configured):
      // UNKNOWN, not "no release" — a persisting caller must not clear a value it
      // persisted earlier just because the token is momentarily absent.
      const token = resolveToken();
      if (token === undefined || owner === '' || repo === '') return undefined;
      const o = owner.toLowerCase();
      const r = repo.toLowerCase();
      const key = `${o}/${r}`;
      const cached = cache.get(key);
      const fresh = cached !== undefined && now() - cached.at < ttlMs;
      if (!fresh) {
        // Kick a background refresh; never await it (keeps GET /projects fast).
        void startRefresh(o, r, key, token);
      }
      // No settled answer yet → UNKNOWN (undefined). A settled entry returns its
      // value: `null` for a confirmed empty release list, or the release summary.
      return cached === undefined ? undefined : cached.release;
    },

    async refreshLatestRelease(
      owner: string,
      repo: string,
    ): Promise<ReleaseSummary | null | undefined> {
      if (owner === '' || repo === '') return undefined;
      let token: string | undefined;
      if (opts.asyncToken !== undefined) {
        try {
          token = await opts.asyncToken(owner, repo);
        } catch {
          // Fall through to the explicitly configured legacy token source.
        }
      }
      token ??= resolveToken();
      if (token === undefined) return undefined;
      const o = owner.toLowerCase();
      const r = repo.toLowerCase();
      const key = `${o}/${r}`;
      const cached = cache.get(key);
      if (cached !== undefined && now() - cached.at < ttlMs) return cached.release;
      await startRefresh(o, r, key, token);
      return cache.get(key)?.release;
    },
  };
}

/**
 * One repo the GitHub App-installation is installed on (concept §19, #174).
 * Trimmed to the fields the multi-repo fleet-registry cache needs: owner + repo
 * name (both lowercase per §19.0 since GitHub identities are case-insensitive and
 * the `projects` table lowercases on persist), plus GitHub's archive flag so
 * pickers can hide archived repos.
 */
interface InstallationRepo {
  owner: string;
  repo: string;
  archived?: boolean;
}

/**
 * Lists the repos the GitHub App-installation is installed on (concept §19,
 * #174) — the live source of the `projects` cache (`GET /projects`). Like {@link
 * GitHubIssueService} it's best-effort: inert (`[]`) without a resolvable token,
 * degrades to `[]` (or the last good list) on any API error, never throws.
 * Paginated via GitHub's `Link: <next>; rel="next"` header so the full
 * installation set is fetched in one call regardless of how many repos the App
 * scopes — Verity caches every repo as a `projects` row keyed by `(owner, repo)`
 * (the `state` survives even when the repo has been provisioned).
 *
 * Unlike the PR/issue services this is NOT scoped to a single repo's `origin`
 * identity — it queries the App-installation-level endpoint
 * `GET /installation/repositories`, available to any `ghs_*` App-installation
 * token (the fleet already sources one via {@link createGhTokenReader}). No
 * `repoDir`/`git` dependency.
 */
export interface GitHubInstallationService {
  listInstallationRepos(): Promise<InstallationRepo[]>;
}

export interface GitHubInstallationServiceOptions {
  /** GitHub token or token provider — see {@link GitHubTokenSource}. */
  token?: GitHubTokenSource | undefined;
  /** Optional async installation-token provider for DB-backed GitHub App credentials. */
  asyncToken?: (() => Promise<string | undefined>) | undefined;
  /** Injected fetch (tests); defaults to the global `fetch`. */
  fetch?: HttpFetch;
  /** Cache TTL in ms (default 60s, keyed off the same window the PR/issue services
   *  use so an installation-list refresh piggybacks a moment when GitHub is being
   *  hit anyway). */
  ttlMs?: number;
  /** Per-request timeout in ms (default 10s — paginating across many repos takes
   *  longer than the PR lookup; mirrors the issue service's grace window scaled). */
  timeoutMs?: number;
  /** Repos per page (default 100 — GitHub's max; minimizes round-trips for fleets
   *  with many installed repos). */
  perPage?: number;
  /** Clock seam (tests). */
  now?: () => number;
}

/** Parse GitHub's `Link: <https://api.github.com/...&page=2>; rel="next", <...>; rel="prev"`
 *  response header into the `next` URL to paginate on, or `null` when there is
 *  no next page (last page reached / header absent). Robust to multiple
 *  comma/semicolon-separated entries. */
function nextLink(header: string | null | undefined): string | null {
  if (header === null || header === undefined || header === '') return null;
  // GitHub uses `, ` between entries and `; ` inside an entry: `<url>; rel="next", <url>; rel="prev"`.
  for (const entry of header.split(',')) {
    const [urlPart, relPart] = entry.split(';');
    if (urlPart === undefined || relPart === undefined) continue;
    const match = /rel="next"/.exec(relPart);
    if (match !== null) {
      const m = /<([^>]+)>/.exec(urlPart.trim());
      if (m !== null && m[1] !== undefined) return m[1];
    }
  }
  return null;
}

/** Map a raw GitHub `repositories[i]` object to an {@link InstallationRepo}, or
 *  null when the required fields are missing/ill-typed (the repo is dropped
 *  rather than crashing the list — matches {@link toIssueSummary}'s discipline). */
function toInstallationRepo(raw: Record<string, unknown>): InstallationRepo | null {
  const owner = raw.owner;
  if (owner === null || typeof owner !== 'object' || Array.isArray(owner)) return null;
  const login = (owner as Record<string, unknown>).login;
  const name = raw.name;
  const archived = raw.archived;
  if (typeof login !== 'string' || login === '') return null;
  if (typeof name !== 'string' || name === '') return null;
  return {
    owner: login.toLowerCase(),
    repo: name.toLowerCase(),
    ...(archived === true ? { archived: true } : {}),
  };
}

export function createGitHubInstallationService(
  opts: GitHubInstallationServiceOptions,
): GitHubInstallationService {
  const doFetch: HttpFetch = opts.fetch ?? ((url, init) => fetch(url, init));
  const ttlMs = opts.ttlMs ?? 60_000;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const perPage = Math.min(Math.max(opts.perPage ?? 100, 1), 100);
  const now = opts.now ?? ((): number => Date.now());
  const resolveToken = makeTokenResolver(opts.token);
  const resolveAsyncToken = opts.asyncToken;

  let cache: { repos: InstallationRepo[]; at: number } | undefined;

  // Walks all pages via the Link header, accumulating into one flat list. Each
  // page's fetch is independently timeout-bounded; a failure on any page
  // short-circuits the whole walk to `{ ok: false }` so the previous cached list
  // (if any) is served stale rather than a half-fetched new one — a partial
  // installation view, missing repos the App can't see, would be worse than
  // keeping the last good full list.
  const walkAllPages = async (
    token: string,
  ): Promise<{ ok: boolean; repos: InstallationRepo[] }> => {
    const repos: InstallationRepo[] = [];
    let nextUrl: string | null =
      `https://api.github.com/installation/repositories?per_page=${String(perPage)}&sort=full_name&direction=asc`;
    try {
      while (nextUrl !== null) {
        const res = await doFetch(nextUrl, {
          headers: githubHeaders(token),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) return { ok: false, repos: [] };
        const body: unknown = await res.json();
        if (body === null || typeof body !== 'object' || Array.isArray(body)) {
          return { ok: false, repos: [] };
        }
        const list = (body as Record<string, unknown>).repositories;
        if (!Array.isArray(list)) return { ok: false, repos: [] };
        for (const it of list) {
          if (it === null || typeof it !== 'object' || Array.isArray(it)) continue;
          const r = toInstallationRepo(it as Record<string, unknown>);
          if (r !== null) repos.push(r);
        }
        // Follow the `Link` header's `rel="next"` URL if present.
        const linkHeader = extractLinkHeader(res);
        nextUrl = nextLink(linkHeader);
        if (nextUrl !== null) {
          const parsed = new URL(nextUrl);
          if (
            parsed.protocol !== 'https:' ||
            parsed.hostname !== 'api.github.com' ||
            parsed.pathname !== '/installation/repositories'
          ) {
            return { ok: false, repos: [] };
          }
        }
      }
      return { ok: true, repos };
    } catch {
      return { ok: false, repos: [] };
    }
  };

  return {
    async listInstallationRepos(): Promise<InstallationRepo[]> {
      // Inert without a currently-resolvable token (GitHub not configured).
      let token: string | undefined;
      if (resolveAsyncToken !== undefined) {
        try {
          token = await resolveAsyncToken();
        } catch {
          // Fall through to the explicitly configured legacy token source.
        }
      }
      token ??= resolveToken();
      if (token === undefined || token.trim().length === 0) return [];
      if (cache !== undefined && now() - cache.at < ttlMs) return cache.repos;
      const result = await walkAllPages(token);
      if (result.ok) {
        cache = { repos: result.repos, at: now() };
        return result.repos;
      }
      // Hard failure: don't cache it; serve the last good list if we have one.
      return cache?.repos ?? [];
    },
  };
}

/** Extract the raw `Link` header from an {@link HttpResponse}. The header is
 *  optional on the type — pages degrade to one page when absent (which a test
 *  single-page fixture omits deliberately). Real `fetch` responses carry it. */
function extractLinkHeader(res: HttpResponse): string | null {
  if (res.headers === undefined) return null;
  try {
    return res.headers.get('link') ?? null;
  } catch {
    return null;
  }
}
