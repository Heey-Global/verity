#!/usr/bin/env node
// Keeps THIRD_PARTY_NOTICES.md current on Renovate branches; see renovate-notices.yml.
// The hosted Renovate app cannot run postUpgradeTasks, so a bump that adds or
// drops a transitive package would otherwise leave the committed notices stale
// and the guard in third-party-notices.test.ts red until a human regenerates
// them. This regenerates the file from the branch's lock and commits it the way
// the OTA promotion PR is written: through GraphQL, so GitHub signs the commit
// as the branch ruleset requires, with the head the workflow saw as the
// expected parent so a concurrent Renovate push makes the commit fail instead
// of landing on the wrong base. A GITHUB_TOKEN commit emits no events, so the
// required checks are dispatched onto the new head explicitly afterwards.
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const repository = process.env.GITHUB_REPOSITORY;
if (!repository) throw new Error('GITHUB_REPOSITORY is required');
const [branch, headSha] = process.argv.slice(2);
if (!branch || !/^[\w./-]+$/.test(branch) || !/^[a-f0-9]{40}$/.test(headSha ?? ''))
  throw new Error('usage: renovate-notices.mjs <branch> <head-sha>');

const noticesPath = 'THIRD_PARTY_NOTICES.md';
const generator = 'scripts/third-party-notices.ts';
const commitMessage = 'chore(deps): regenerate third-party notices';
/** Checks a GITHUB_TOKEN commit needs dispatched by hand; release.yml does the same for its PRs. */
const checkWorkflows = ['ci.yml', 'gitleaks-dispatch.yml'];

/** @param {string[]} args @param {{input?: string}} [options] */
function gh(args, options = {}) {
  return execFileSync('gh', args, {
    encoding: 'utf8',
    stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'inherit'],
    ...(options.input === undefined ? {} : { input: options.input }),
  });
}

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

const mutation =
  'mutation($repository: String!, $branch: String!, $expected: GitObjectID!, $message: String!, $path: String!, $contents: Base64String!) { createCommitOnBranch(input: { branch: { repositoryNameWithOwner: $repository, branchName: $branch }, expectedHeadOid: $expected, message: { headline: $message }, fileChanges: { additions: [{path: $path, contents: $contents}] } }) { commit { oid signature { isValid } } } }';
/** @param {unknown} value @returns {value is Record<string, unknown>} */
const isRecord = (value) => typeof value === 'object' && value !== null;

/**
 * @template T
 * @param {string} json
 * @param {(value: unknown) => value is T} valid
 * @param {string} what
 * @returns {T}
 */
function parsed(json, valid, what) {
  const value = /** @type {unknown} */ (JSON.parse(json));
  if (!valid(value)) throw new Error(`Unexpected ${what} response: ${json.slice(0, 200)}`);
  return value;
}

// The body goes through stdin: the encoded notices run past 128 KiB, which is
// more than Linux allows in one argv element, so `-f contents=...` fails with
// E2BIG on exactly the branches this exists to repair.
const result = parsed(
  gh(['api', 'graphql', '--input', '-'], {
    input: JSON.stringify({
      query: mutation,
      variables: {
        repository,
        branch,
        expected: headSha,
        message: commitMessage,
        path: noticesPath,
        contents: readFileSync(noticesPath).toString('base64'),
      },
    }),
  }),
  /** @returns {value is {data: {createCommitOnBranch: {commit: {oid: string, signature: {isValid: boolean}}}}}} */
  (value) => {
    if (!isRecord(value) || !isRecord(value.data) || !isRecord(value.data.createCommitOnBranch))
      return false;
    const commit = value.data.createCommitOnBranch.commit;
    return (
      isRecord(commit) &&
      typeof commit.oid === 'string' &&
      isRecord(commit.signature) &&
      typeof commit.signature.isValid === 'boolean'
    );
  },
  'createCommitOnBranch',
);
const commit = result.data.createCommitOnBranch.commit;
if (!commit.signature.isValid) throw new Error('Notices commit is not verified');
console.log(`Committed ${commit.oid} to ${branch}.`);

for (const workflow of checkWorkflows) gh(['workflow', 'run', workflow, '--ref', branch]);
console.log(`Dispatched ${checkWorkflows.join(' and ')} onto ${branch}.`);

// The pull_request run for the superseded head is still spending a full matrix
// on a tree that fails the very check just repaired. Stop it; its verdict
// belongs to a commit the PR no longer points at.
const runs = parsed(
  gh([
    'api',
    `repos/${repository}/actions/workflows/ci.yml/runs?head_sha=${headSha}&event=pull_request&per_page=100`,
  ]),
  /** @returns {value is {workflow_runs: {id: number, status: string}[]}} */
  (value) =>
    isRecord(value) &&
    Array.isArray(value.workflow_runs) &&
    value.workflow_runs.every(
      (/** @type {unknown} */ run) =>
        isRecord(run) && typeof run.id === 'number' && typeof run.status === 'string',
    ),
  'workflow runs',
);
for (const run of runs.workflow_runs) {
  if (run.status === 'completed') continue;
  try {
    gh(['api', '-X', 'POST', `repos/${repository}/actions/runs/${run.id}/cancel`]);
    console.log(`Cancelled superseded CI run ${run.id} for ${headSha}.`);
  } catch {
    // The run can finish between listing and cancellation. The new head has
    // already received its checks, so cancellation cannot affect correctness.
    console.warn(`Could not cancel superseded CI run ${run.id} for ${headSha}.`);
  }
}
