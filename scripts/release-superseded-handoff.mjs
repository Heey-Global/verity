#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

/**
 * The caller serializes handoffs across runs. Failed or empty successful
 * attempts remain visible rather than becoming an unbounded retry loop.
 * @param {string} repository
 * @param {string[]} targets
 * @param {(args: string[]) => string} [gh]
 */
export function resumeSuperseded(
  repository,
  targets,
  gh = (args) => execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).trim(),
) {
  if (
    !/^[\w.-]+\/[\w.-]+$/.test(repository) ||
    !targets.length ||
    targets.some((sha) => !/^[a-f0-9]{40}$/.test(sha))
  )
    throw new Error('Invalid superseded handoff input');
  const current = () =>
    gh(['api', `repos/${repository}/git/ref/heads/main`, '--jq', '.object.sha']);
  const head = current();
  if (!targets.includes(head))
    return 'Main advanced; scheduled reconciliation owns the new snapshot';
  const pages = /** @type {unknown} */ (
    JSON.parse(
      gh([
        'api',
        '--paginate',
        '--slurp',
        `repos/${repository}/actions/workflows/release-dispatch.yml/runs?event=workflow_dispatch&head_sha=${head}&per_page=100`,
      ]),
    )
  );
  if (!Array.isArray(pages)) throw new Error('Invalid workflow run pages');
  for (const page of /** @type {unknown[]} */ (pages)) {
    if (
      !page ||
      typeof page !== 'object' ||
      !('workflow_runs' in page) ||
      !Array.isArray(page.workflow_runs)
    )
      throw new Error('Invalid workflow run listing');
    for (const value of /** @type {unknown[]} */ (page.workflow_runs)) {
      if (
        !value ||
        typeof value !== 'object' ||
        !('head_sha' in value) ||
        !('display_title' in value) ||
        !('status' in value) ||
        !('html_url' in value) ||
        typeof value.head_sha !== 'string' ||
        typeof value.display_title !== 'string' ||
        typeof value.status !== 'string' ||
        typeof value.html_url !== 'string'
      )
        throw new Error('Invalid workflow run');
      const run = value;
      if (run.head_sha !== head || run.display_title !== 'Reconcile unpublished releases') continue;
      if (run.status !== 'completed') return 'Reconciliation already active';
      throw new Error(
        `Reconciliation already attempted for ${head}; inspect ${String(run.html_url)}`,
      );
    }
  }
  // Reserve before dispatch: Actions run listings are eventually consistent.
  // This immutable bookkeeping tag is never a release or a publication source.
  const claim = `refs/tags/release-reconcile-attempt/${head}`;
  const claims = /** @type {unknown} */ (
    JSON.parse(
      gh(['api', `repos/${repository}/git/matching-refs/tags/release-reconcile-attempt/${head}`]),
    )
  );
  if (!Array.isArray(claims)) throw new Error('Invalid reconciliation claim listing');
  if (
    claims.some((/** @type {unknown} */ entry) => {
      if (!entry || typeof entry !== 'object' || !('ref' in entry) || typeof entry.ref !== 'string')
        throw new Error('Invalid reconciliation claim');
      return entry.ref === claim;
    })
  )
    throw new Error(
      `Reconciliation already reserved for ${head}; inspect the dispatch before retrying manually`,
    );
  if (current() !== head)
    return 'Main advanced before dispatch; scheduled reconciliation owns the new snapshot';
  gh([
    'api',
    '--method',
    'POST',
    `repos/${repository}/git/refs`,
    '-f',
    `ref=${claim}`,
    '-f',
    `sha=${head}`,
  ]);
  gh([
    'workflow',
    'run',
    'release-dispatch.yml',
    '--repo',
    repository,
    '--ref',
    'main',
    '-f',
    'reconcile=true',
  ]);
  return `Requested reconciliation for ${head}`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(
    resumeSuperseded(
      process.env.GITHUB_REPOSITORY ?? '',
      [process.env.BACKEND_HEAD, process.env.MOBILE_HEAD, process.env.WEBSITE_HEAD].filter(Boolean),
    ),
  );
}
