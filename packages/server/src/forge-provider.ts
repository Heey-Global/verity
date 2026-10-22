import type { ProjectRecord } from '@verity/store';

/**
 * Provider-neutral contract for the code forge a project is hosted on (#1034).
 *
 * Routes, the session PR bar, merge handling and project linking talk to a
 * {@link ForgeProvider} instead of to GitHub directly, so a second forge (Forgejo,
 * later GitLab) is one more implementation rather than a fork of every caller.
 * Implementations live in `github-forge-provider.ts` and `forgejo-forge-provider.ts`.
 */

/** Identifies a forge implementation. Widened as further forges are added. */
type ForgeProviderId = 'github' | 'forgejo';

/**
 * What a forge supports for its projects. Callers consult these flags to hide a
 * feature the forge lacks instead of offering it and failing on use.
 */
interface ForgeCapabilities {
  /** The connection can enumerate the repositories it grants access to. */
  readonly repositoryListing: boolean;
  readonly issues: boolean;
  readonly pullRequests: boolean;
  readonly pullRequestMerge: boolean;
  /** CI results are reported for pull request heads. */
  readonly checks: boolean;
  readonly releases: boolean;
}

/** A repository coordinate on a forge. */
export interface ForgeRepoRef {
  owner: string;
  repo: string;
}

/** One repository the forge connection can access, lowercased like `projects` rows. */
interface ForgeRepository extends ForgeRepoRef {
  archived?: boolean;
}

/** Open issues of a project's repository. `connected` is false when the forge
 *  cannot be queried for it (local project, missing credentials). */
export interface ForgeIssueList {
  connected: boolean;
  viewerLogin: string | null;
  issues: { number: number; title: string; url: string; labels: string[]; assignees: string[] }[];
}

/** A pull request Verity opened itself. */
export interface OpenedPullRequest {
  number: number;
  /** The page an operator opens, not the API url. */
  url: string;
}

/**
 * The latest published release of a repository, trimmed to what the project
 * overview surfaces. Only the `tag` is rendered today; `name`/`url`/`publishedAt`
 * are carried and persisted for a later detail view.
 */
export interface ReleaseSummary {
  /** The git tag the release points at (e.g. `v1.4.0`). Always present. */
  tag: string;
  /** The release's display name, or null when unnamed (the forge falls back to the tag). */
  name: string | null;
  /** The release's page on the forge. */
  url: string;
  /** ISO 8601 publish timestamp, or null for a draft/unpublished release. */
  publishedAt: string | null;
}

export interface ForgeProvider {
  readonly id: ForgeProviderId;
  readonly capabilities: ForgeCapabilities;
  /** The repository a git remote URL points at on this forge, or null for any other host. */
  parseRemote(remoteUrl: string): ForgeRepoRef | null;
  /** The HTTPS clone URL of a repository on this forge. */
  cloneUrl(ref: ForgeRepoRef): string;
  /** Memoized `origin` identity of a checkout; null when it is not hosted on this forge. */
  identityFor(repoDir: string): () => Promise<ForgeRepoRef | null>;
  /** Repository-scoped credential for server-side calls and the sandbox broker. */
  mintProjectToken(ref: ForgeRepoRef): Promise<string | undefined>;
  /** Cached pull request lookups for the checkout at `repoDir`. */
  prServiceFor(repoDir: string): ForgePrService;
  /** Open a pull request with a one-shot token minted for `target`. */
  openPullRequest(
    target: ForgeRepoRef,
    token: string,
    pr: { head: string; base: string; title: string; body: string },
  ): Promise<OpenedPullRequest>;
  listIssues(project: ProjectRecord): Promise<ForgeIssueList>;
  /** Repositories the connection grants; degrades to `[]` instead of throwing on forge errors. */
  listRepositories(): Promise<ForgeRepository[]>;
  /** Cached latest release: `undefined` when not known yet, `null` when there is none. */
  latestRelease(ref: ForgeRepoRef): ReleaseSummary | null | undefined;
  refreshLatestRelease(ref: ForgeRepoRef): Promise<ReleaseSummary | null | undefined>;
}

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
export interface ForgePrService {
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
  /** Merge an open PR by number. Returns false when the forge rejects or is unavailable. */
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
