/**
 * Parse the leading issue number out of a branch named `<type>/<issue>-<slug>`
 * (e.g. `feat/122-preview-branches` → 122) — the convention from issue #125. This
 * works from the first commit, BEFORE any PR exists, so the issue association never
 * depends on GitHub. Returns null for any branch without a leading
 * `<type>/<digits>-` (e.g. `main`, `agent/d0626bd8`), so the header simply shows no
 * issue chip rather than erroring.
 *
 * Deliberately requires the trailing `-` after the number (per the convention's
 * `<issue>-<slug>` shape) so a bare `feat/122` doesn't half-match, and only matches
 * a lowercase type prefix.
 *
 * Known cosmetic edges (the chip is a non-linked hint, so these are acceptable): an
 * auto-spawn branch whose slug happens to lead with digits (e.g. `agent/123-fix-…`)
 * reads as Issue #123; and leading zeros are dropped (`feat/007-x` → 7). The common
 * cases — real issue branches and hex-id agent branches like `agent/d0626bd8` — are
 * correct.
 */
export function parseBranchIssue(branch: string | undefined): number | null {
  if (branch === undefined) return null;
  const match = /^[a-z]+\/(\d+)-/.exec(branch);
  if (match === null) return null;
  const issue = Number(match[1]);
  return Number.isSafeInteger(issue) && issue > 0 ? issue : null;
}

/** Where a repository's web pages live. Defaults to GitHub. */
export interface RefHost {
  provider: 'github' | 'forgejo';
  baseUrl: string;
}

/** The repo's `{ owner, repo }`, as surfaced on the branches response (#161).
 *  Both undefined when the server is older or there's no GitHub remote. */
export interface RepoIdentity {
  owner?: string | undefined;
  repo?: string | undefined;
  /** Where the repository's web pages live; absent means GitHub. */
  host?: RefHost | undefined;
}

const GITHUB_REF_HOST: RefHost = { provider: 'github', baseUrl: 'https://github.com' };

/**
 * Build the code-host URL for an Issue or PR chip (#161), so the header can make
 * the chip tappable (`Linking.openURL`). Returns null — keeping the chip
 * non-tappable — unless owner, repo and a positive integer `number` are ALL present,
 * so a missing identity (no remote / older server) degrades to a plain, non-linked
 * chip rather than a broken URL. `kind` selects the provider's path segment:
 * GitHub uses `issues/<n>` and `pull/<n>`, Forgejo `issues/<n>` and `pulls/<n>`.
 * owner/repo are percent-encoded so an unusual remote name can't break the URL.
 */
export function forgeRefUrl(
  kind: 'issue' | 'pr',
  identity: RepoIdentity,
  number: number | null | undefined,
): string | null {
  const { owner, repo } = identity;
  const host = identity.host ?? GITHUB_REF_HOST;
  if (owner === undefined || owner === '' || repo === undefined || repo === '') return null;
  if (typeof number !== 'number' || !Number.isInteger(number) || number <= 0) return null;
  const segment = kind === 'issue' ? 'issues' : host.provider === 'forgejo' ? 'pulls' : 'pull';
  return (
    `${host.baseUrl.replace(/\/$/u, '')}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}` +
    `/${segment}/${String(number)}`
  );
}
