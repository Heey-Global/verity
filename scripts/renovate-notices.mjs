#!/usr/bin/env node
// Keeps THIRD_PARTY_NOTICES.md current on Renovate branches; see renovate-notices.yml.
// The hosted Renovate app cannot run postUpgradeTasks, so a bump that adds or
// drops a transitive package would otherwise leave the committed notices stale
// and the guard in third-party-notices.test.ts red until a human regenerates
// them. This regenerates the file from the branch's lock and commits it through
// renovate-branch.mjs, which explains how the commit is signed and checked.
import { execFileSync, spawnSync } from 'node:child_process';

import { branchArguments, commitToBranch } from './renovate-branch.mjs';

const { repository, branch, headSha } = branchArguments(
  process.argv.slice(2),
  'renovate-notices.mjs',
);

const noticesPath = 'THIRD_PARTY_NOTICES.md';
const generator = 'scripts/third-party-notices.ts';
const commitMessage = 'chore(deps): regenerate third-party notices';

const check = spawnSync(process.execPath, [generator, '--check'], {
  encoding: 'utf8',
  stdio: ['ignore', 'inherit', 'pipe'],
});
if (check.status === 0) {
  console.log(`${noticesPath} matches package-lock.json; nothing to commit.`);
  process.exit(0);
}
if (!check.stderr.includes(`${noticesPath} is stale`)) {
  // A lock entry without license metadata, or a broken generator, is a review
  // finding for the PR, never something to paper over with a commit.
  process.stderr.write(check.stderr);
  throw new Error(`${generator} failed for a reason other than stale notices`);
}
execFileSync(process.execPath, [generator, '--write'], { stdio: 'inherit' });
execFileSync(process.execPath, [generator, '--check'], { stdio: 'inherit' });

commitToBranch({ repository, branch, headSha, message: commitMessage, paths: [noticesPath] });
