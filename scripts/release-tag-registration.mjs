#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const trains = [
  { train: 'backend', component: 'server', path: '.', prefix: 'v' },
  { train: 'mobile', component: 'mobile', path: 'apps/mobile', prefix: 'mobile-v' },
  { train: 'website', component: 'website', path: 'docs/website', prefix: 'website-v' },
];
const shaPattern = /^[a-f0-9]{40}$/;
/** @param {string} command @param {string[]} args */
function execute(command, args) {
  return execFileSync(command, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).trim();
}

/**
 * Tags reserve release identities; they do not constitute published releases.
 * @param {'register' | 'check'} mode
 * @param {string} head
 * @param {{repository?: string, run?: typeof execute}} [options]
 */
export function registerReleaseTags(mode, head, options = {}) {
  if (!['register', 'check'].includes(mode) || !shaPattern.test(head))
    throw new Error('Invalid release tag registration input');
  const repository = options.repository ?? process.env.GITHUB_REPOSITORY;
  if (!repository || !/^[\w.-]+\/[\w.-]+$/.test(repository))
    throw new Error('Invalid GITHUB_REPOSITORY');
  const run = options.run ?? execute;
  /** @param {string[]} args */
  const git = (args) => run('git', args);
  /** @param {string} sha @param {(typeof trains)[number]} spec */
  const versionAt = (sha, spec) => {
    /** @type {unknown} */
    const raw = JSON.parse(git(['show', `${sha}:.release-please-manifest.${spec.train}.json`]));
    const manifest = /** @type {Record<string, unknown>} */ (raw);
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest))
      throw new Error('Invalid release manifest');
    if (
      spec.train === 'backend' &&
      manifest['.'] !== undefined &&
      manifest['.release/backend'] !== undefined &&
      manifest['.'] !== manifest['.release/backend']
    )
      throw new Error('Conflicting backend release versions');
    const version =
      manifest[spec.path] ?? (spec.train === 'backend' ? manifest['.release/backend'] : undefined);
    if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version))
      throw new Error(`Invalid ${spec.train} release version at ${sha}`);
    return version;
  };
  const records = run('gh', [
    'api',
    '--paginate',
    `repos/${repository}/pulls?state=closed&base=main&per_page=100`,
    '--jq',
    '.[] | {merged_at, merge_commit_sha, user: {login: .user.login}, head: {ref: .head.ref}}',
  ])
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      /** @type {unknown} */
      const raw = JSON.parse(line);
      return /** @type {{merged_at: string | null, merge_commit_sha: string, user: {login: string}, head: {ref: string}}} */ (
        raw
      );
    });
  const results = [];
  for (const spec of trains) {
    const version = versionAt(head, spec);
    const tag = `${spec.prefix}${version}`;
    const matches = [];
    for (const pr of records) {
      if (
        !pr.merged_at ||
        pr.head?.ref !== `release-please--branches--main--components--${spec.component}`
      )
        continue;
      const sha = pr.merge_commit_sha;
      if (!shaPattern.test(sha)) throw new Error('Invalid merged release commit');
      // A later merge is irrelevant when checking an older PR base.
      try {
        git(['merge-base', '--is-ancestor', sha, head]);
      } catch {
        continue;
      }
      const manifestPath = `.release-please-manifest.${spec.train}.json`;
      // Old release PRs can predate the manifest; absence is not an API failure.
      if (!git(['ls-tree', '--name-only', sha, '--', manifestPath])) continue;
      if (versionAt(sha, spec) !== version) continue;
      if (pr.user?.login !== 'github-actions[bot]') throw new Error(`Unexpected author for ${tag}`);
      matches.push(sha);
    }
    if (matches.length > 1) throw new Error(`Ambiguous merged release identity for ${tag}`);
    /** Read remote refs so retries cannot trust stale checkout tags. */
    const remoteTarget = () => {
      const refs = run('git', [
        'ls-remote',
        '--tags',
        'origin',
        `refs/tags/${tag}`,
        `refs/tags/${tag}^{}`,
      ]);
      const parsed = refs
        .split('\n')
        .filter(Boolean)
        .map((line) => line.split(/\s+/));
      return (
        parsed.find((entry) => entry[1] === `refs/tags/${tag}^{}`)?.[0] ??
        parsed.find((entry) => entry[1] === `refs/tags/${tag}`)?.[0]
      );
    };
    let target = remoteTarget();
    if (!target) {
      if (mode === 'check')
        throw new Error(
          `Release tag ${tag} is not registered; retry after tag registration completes`,
        );
      if (!matches[0]) throw new Error(`Missing trusted merged release PR for ${tag}`);
      try {
        run('gh', [
          'api',
          '--method',
          'POST',
          `repos/${repository}/git/refs`,
          '-f',
          `ref=refs/tags/${tag}`,
          '-f',
          `sha=${matches[0]}`,
        ]);
      } catch (error) {
        // A concurrent registrar may win; only an identical remote ref is success.
        if (remoteTarget() !== matches[0]) throw error;
      }
      target = remoteTarget();
    }
    if (!target || !shaPattern.test(target)) throw new Error(`Invalid remote release tag ${tag}`);
    if (matches[0] && target !== matches[0])
      throw new Error(`${tag} differs from its merged release commit`);
    git(['merge-base', '--is-ancestor', target, head]);
    if (versionAt(target, spec) !== version)
      throw new Error(`${tag} declares a different release version`);
    results.push({ tag, sha: target });
  }
  return results;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const mode = process.argv[2];
  if (mode !== 'register' && mode !== 'check') throw new Error('Expected register or check');
  console.log(JSON.stringify(registerReleaseTags(mode, process.argv[3])));
}
