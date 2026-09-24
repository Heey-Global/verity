#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

/** @param {string} component */
export function pendingReleasePrs(component) {
  if (!['server', 'mobile', 'website'].includes(component))
    throw new Error('Invalid release component');
  // The search index can omit an already merged PR indefinitely. Read the
  // paginated pull-request records themselves so a missing search hit cannot
  // strand a version whose manifest has already advanced.
  const records = execFileSync(
    'gh',
    [
      'api',
      '--paginate',
      `repos/${process.env.GITHUB_REPOSITORY ?? process.env.GH_REPO}/pulls?state=closed&base=main&per_page=100`,
      '--jq',
      '.[] | {number, merged_at, merge_commit_sha, user: {login: .user.login}, head: {ref: .head.ref}, labels: [.labels[].name]}',
    ],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  );
  return records
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const raw = /** @type {unknown} */ (JSON.parse(line));
      return /** @type {{number: number, merged_at: string | null, merge_commit_sha: string, user: {login: string}, head: {ref: string}, labels: string[]}} */ (
        raw
      );
    })
    .filter(
      (pr) =>
        pr.merged_at &&
        pr.head.ref === `release-please--branches--main--components--${component}` &&
        pr.labels.includes('autorelease: pending'),
    )
    .map((pr) => ({
      number: pr.number,
      author: { login: pr.user.login === 'github-actions[bot]' ? 'github-actions' : pr.user.login },
      mergeCommit: { oid: pr.merge_commit_sha },
    }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  console.log(JSON.stringify(pendingReleasePrs(process.argv[2])));
