#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';

const [train, eventSha] = process.argv.slice(2);
/** @type {Record<string, {component: string, path: string, prefix: string}>} */
const trains = {
  backend: { component: 'server', path: '.release/backend', prefix: 'v' },
  mobile: { component: 'mobile', path: 'apps/mobile', prefix: 'mobile-v' },
  website: { component: 'website', path: 'docs/website', prefix: 'website-v' },
};
const spec = trains[train ?? ''];
if (!spec || !/^[a-f0-9]{40}$/.test(eventSha ?? ''))
  throw new Error('Invalid release lifecycle input');
/** @param {string[]} args @returns {unknown} */
const gh = (...args) => JSON.parse(execFileSync('gh', args, { encoding: 'utf8' }));
/** @param {string} path */
const api = (path) => gh('api', `repos/${process.env.GITHUB_REPOSITORY}/${path}`);
const outputFile = process.env.GITHUB_OUTPUT;
if (!outputFile) throw new Error('GITHUB_OUTPUT is required');
/** @param {string} mode */
const output = (mode) => appendFileSync(outputFile, `mode=${mode}\n`);
const main = /** @type {{object: {sha: string}}} */ (api('git/ref/heads/main')).object.sha;
if (main !== eventSha) {
  console.log('A newer main push owns release reconciliation.');
  output('skip');
} else {
  /** @type {unknown} */
  const rawManifest = JSON.parse(readFileSync(`.release-please-manifest.${train}.json`, 'utf8'));
  const manifest = /** @type {Record<string, string>} */ (rawManifest);
  const version = manifest[spec.path];
  if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) throw new Error('Invalid release manifest version');
  const tag = `${spec.prefix}${version}`;
  // Paginate: a release disappearing from page one must never reset history.
  const releases = /** @type {{tag_name: string, draft: boolean, prerelease: boolean}[][]} */ (
    gh(
      'api',
      '--paginate',
      '--slurp',
      `repos/${process.env.GITHUB_REPOSITORY}/releases?per_page=100`,
    )
  ).flat();
  const pending =
    /** @type {{number: number, author: {login: string}, mergeCommit: {oid: string}}[]} */ (
      gh(
        'pr',
        'list',
        '--state',
        'merged',
        '--base',
        'main',
        '--head',
        `release-please--branches--main--components--${spec.component}`,
        '--label',
        'autorelease: pending',
        '--json',
        'number,author,mergeCommit',
      )
    );
  const drafts = releases.filter(
    (release) =>
      release.draft &&
      new RegExp(`^${spec.prefix}\\d+\\.\\d+\\.${train === 'mobile' ? '0' : '\\d+'}$`).test(
        release.tag_name,
      ),
  );
  if (drafts.length)
    throw new Error(
      `${train} publication is pending (${drafts.map((r) => r.tag_name).join(', ')}); recover that version before planning another release`,
    );
  if (pending.length) {
    const candidate = pending[0];
    if (
      pending.length !== 1 ||
      !candidate ||
      !['app/github-actions', 'github-actions'].includes(candidate.author.login)
    ) {
      throw new Error('Ambiguous pending release identity');
    }
    const sha = candidate.mergeCommit.oid;
    if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('Invalid pending release source');
    execFileSync('git', ['merge-base', '--is-ancestor', sha, eventSha]);
    /** @type {unknown} */
    const rawPendingManifest = JSON.parse(
      execFileSync('git', ['show', `${sha}:.release-please-manifest.${train}.json`], {
        encoding: 'utf8',
      }),
    );
    const pendingManifest = /** @type {Record<string, string>} */ (rawPendingManifest);
    if (pendingManifest[spec.path] !== version)
      throw new Error('Pending release version differs from main');
    if (releases.some((release) => release.tag_name === tag))
      throw new Error('Pending release label refers to an already published version');
    output('release');
  } else {
    const boundary = releases.find(
      (release) => release.tag_name === tag && !release.draft && !release.prerelease,
    );
    if (!boundary)
      throw new Error(`Missing published release boundary ${tag}; refusing to infer history`);
    const sha = execFileSync('git', ['rev-parse', `refs/tags/${tag}^{commit}`], {
      encoding: 'utf8',
    }).trim();
    execFileSync('git', ['merge-base', '--is-ancestor', sha, eventSha]);
    /** @type {unknown} */
    const rawBoundary = JSON.parse(
      execFileSync('git', ['show', `${sha}:.release-please-manifest.${train}.json`], {
        encoding: 'utf8',
      }),
    );
    const boundaryManifest = /** @type {Record<string, string>} */ (rawBoundary);
    if (boundaryManifest[spec.path] !== version)
      throw new Error('Published tag does not contain its declared release version');
    output('plan');
  }
}
