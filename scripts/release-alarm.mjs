#!/usr/bin/env node
// Turns the reconciliation sweep's verdict into one GitHub issue; see
// release-reconcile.yml. A red cron run notifies nobody, so a release that
// needs a human waited until someone happened to look at Actions. The issue
// mentions the owner once when it opens and again only for new problems, and
// closes itself when a clean sweep follows, so it doubles as the record of
// what was stuck and for how long.
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const alarmLabel = 'release-stall';
const title = 'Release pipeline needs attention';
const markerPattern = /<!-- release-stall: (\[.*\]) -->/u;
// One crashed sweep (a GitHub 504, a runner hiccup) is retried by the next
// one five minutes later; only a sweep that keeps failing leaves the pipeline
// unwatched.
export const crashThreshold = 3;

/**
 * @param {{
 *   result: string,
 *   problems: string[] | undefined,
 *   recentConclusions: string[],
 *   issue: {number: number, body: string} | undefined,
 *   runUrl: string,
 *   mention: string,
 * }} input
 * @returns {{action: 'none'} | {action: 'open', body: string} | {action: 'update', number: number, body: string, comment: string} | {action: 'close', number: number, comment: string}}
 */
export function planAlarm({ result, problems, recentConclusions, issue, runUrl, mention }) {
  if (result === 'cancelled' || result === 'skipped') return { action: 'none' };
  let current = [...new Set(problems ?? [])];
  if (result !== 'success' && !current.length) {
    // The sweep crashed before reporting. That says nothing about the
    // releases, so it never closes an open issue.
    const crashes = [result, ...recentConclusions].slice(0, crashThreshold);
    if (crashes.length < crashThreshold || crashes.some((conclusion) => conclusion === 'success'))
      return { action: 'none' };
    current = [
      `The reconciliation sweep has crashed ${crashThreshold} times in a row without a verdict, so nothing is watching releases.`,
    ];
  }
  if (!current.length) {
    if (!issue) return { action: 'none' };
    return {
      action: 'close',
      number: issue.number,
      comment: `Resolved: ${runUrl} found nothing that needs a human.`,
    };
  }
  const body = [
    `@${mention} the release reconciliation sweep found states it will not retry on its own.`,
    '',
    ...current.map((problem) => `- ${problem}`),
    '',
    `Latest sweep: ${runUrl}`,
    '',
    'This issue closes itself after the next clean sweep.',
    '',
    `<!-- release-stall: ${JSON.stringify(current)} -->`,
  ].join('\n');
  if (!issue) return { action: 'open', body };
  const known = new Set(previousProblems(issue.body));
  const added = current.filter((problem) => !known.has(problem));
  if (!added.length && known.size === current.length) return { action: 'none' };
  return {
    action: 'update',
    number: issue.number,
    body,
    comment: added.length
      ? [`@${mention} new since the last report:`, '', ...added.map((p) => `- ${p}`)].join('\n')
      : '',
  };
}

/** @param {string} body */
function previousProblems(body) {
  const match = markerPattern.exec(body);
  if (!match) return [];
  const parsed = /** @type {unknown} */ (JSON.parse(match[1] ?? '[]'));
  return Array.isArray(parsed) ? parsed.filter((entry) => typeof entry === 'string') : [];
}

/** @param {string[]} args */
function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8' }).trim();
}

/** @param {string[]} args @returns {unknown} */
function ghJson(args) {
  return JSON.parse(gh(args));
}

function main() {
  const repository = process.env.GITHUB_REPOSITORY ?? '';
  const runId = process.env.GITHUB_RUN_ID ?? '';
  const mention = process.env.RELEASE_ALERT_MENTION ?? '';
  if (!/^[\w.-]+\/[\w.-]+$/u.test(repository)) throw new Error('GITHUB_REPOSITORY is required');
  if (!/^\d+$/u.test(runId)) throw new Error('GITHUB_RUN_ID is required');
  if (!/^[\w-]+$/u.test(mention)) throw new Error('RELEASE_ALERT_MENTION is required');
  const rawProblems = process.env.PROBLEMS ?? '';
  const parsedProblems = /** @type {unknown} */ (rawProblems ? JSON.parse(rawProblems) : undefined);
  if (
    parsedProblems !== undefined &&
    !(Array.isArray(parsedProblems) && parsedProblems.every((entry) => typeof entry === 'string'))
  )
    throw new Error('Invalid PROBLEMS');
  const problems = /** @type {string[] | undefined} */ (parsedProblems);

  // A sweep job that fails crashed before its verdict: the workflow step
  // succeeds whenever the verdict was written, problems or not. Superseded
  // (cancelled) runs say nothing either way.
  const runs = /** @type {{id: number, conclusion: string | null}[]} */ (
    ghJson([
      'api',
      `repos/${repository}/actions/workflows/release-reconcile.yml/runs?status=completed&per_page=${crashThreshold + 3}`,
      '--jq',
      '[.workflow_runs[] | {id, conclusion}]',
    ])
  )
    .filter((run) => String(run.id) !== runId && run.conclusion !== 'cancelled')
    .slice(0, crashThreshold - 1);
  const recentConclusions = runs.map((run) => {
    const jobs = /** @type {{name: string, conclusion: string | null}[]} */ (
      ghJson([
        'api',
        `repos/${repository}/actions/runs/${run.id}/jobs`,
        '--jq',
        '[.jobs[] | {name, conclusion}]',
      ])
    );
    return jobs.find((job) => job.name === 'reconcile')?.conclusion ?? 'none';
  });
  const issues = /** @type {{number: number, body: string | null}[]} */ (
    ghJson([
      'issue',
      'list',
      '--repo',
      repository,
      '--state',
      'open',
      '--label',
      alarmLabel,
      '--json',
      'number,body',
    ])
  );
  if (issues.length > 1) throw new Error(`More than one open ${alarmLabel} issue`);
  const open = issues[0];

  const plan = planAlarm({
    result: process.env.RECONCILE_RESULT ?? '',
    problems,
    recentConclusions,
    issue: open && { number: open.number, body: open.body ?? '' },
    runUrl: `https://github.com/${repository}/actions/runs/${runId}`,
    mention,
  });
  if (plan.action === 'open') {
    gh(['label', 'create', alarmLabel, '--repo', repository, '--color', 'B60205', '--force']);
    const url = gh([
      'issue',
      'create',
      '--repo',
      repository,
      '--title',
      title,
      '--label',
      alarmLabel,
      '--body',
      plan.body,
    ]);
    console.log(`Opened ${url}`);
  } else if (plan.action === 'update') {
    gh(['issue', 'edit', String(plan.number), '--repo', repository, '--body', plan.body]);
    if (plan.comment)
      gh(['issue', 'comment', String(plan.number), '--repo', repository, '--body', plan.comment]);
    console.log(`Updated #${plan.number}`);
  } else if (plan.action === 'close') {
    gh(['issue', 'close', String(plan.number), '--repo', repository, '--comment', plan.comment]);
    console.log(`Closed #${plan.number}`);
  } else {
    console.log('No alarm change.');
  }
  // The issue is the notification; the red run keeps Actions honest too.
  if (plan.action === 'open' || plan.action === 'update' || (problems?.length ?? 0) > 0)
    process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
