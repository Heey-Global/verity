#!/usr/bin/env node
import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { captureJson } from './capture-json.mjs';

export const otaVersionPath = 'apps/mobile/ota/version.txt';
export const otaManifestPath = '.release-please-manifest.mobile-ota.json';
export const otaConfigPath = 'release-please-config.mobile-ota.json';
const versionPattern = /^\d+\.\d+\.\d+$/u;
const shaPattern = /^[a-f0-9]{40}$/u;

/** @param {string} path */
export function otaSourcePath(path) {
  return (
    (/^(?:apps\/mobile|packages\/(?:mobile|events))\//u.test(path) &&
      !/^apps\/mobile\/(?:ota\/|ota-promotion\.json$|version\.txt$|CHANGELOG\.md$)/u.test(path)) ||
    ['package.json', 'package-lock.json'].includes(path)
  );
}

/** @param {string} runtime @param {Array<{tag_name: string, draft: boolean}>} releases */
export function otaReleasePlan(runtime, releases) {
  if (!versionPattern.test(runtime) || !runtime.endsWith('.0'))
    throw new Error('OTA runtime must be a native X.Y.0 version');
  const line = runtime.slice(0, -1);
  const versions = releases
    .filter((release) => !release.draft && release.tag_name.startsWith(`mobile-v${line}`))
    .map((release) => release.tag_name.slice('mobile-v'.length))
    .filter((version) => versionPattern.test(version))
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  if (!versions.includes(runtime)) throw new Error('The native Staging runtime is not published');
  const baseline = versions.at(-1);
  if (!baseline) throw new Error('No staged native baseline');
  return {
    baseline: `mobile-v${baseline}`,
    version: `${line}${Number(baseline.split('.')[2]) + 1}`,
  };
}

/** @param {string} command @param {string[]} args */
const run = (command, args) => execFileSync(command, args, { encoding: 'utf8' }).trim();
const repository = () => {
  const value = process.env.GITHUB_REPOSITORY ?? '';
  if (!/^[\w.-]+\/[\w.-]+$/u.test(value)) throw new Error('Invalid GITHUB_REPOSITORY');
  return value;
};
/** @template T @param {string[]} args @returns {T} */
const api = (...args) => /** @type {T} */ (captureJson('gh', ['api', ...args]));
/** @typedef {{tag_name: string, draft: boolean, prerelease: boolean}} Release */
/** @typedef {{number: number, merged_at: string | null, base: {ref: string}, head: {ref: string, sha: string}, user?: {login: string}, labels?: Array<{name: string}>}} Pull */

/** @param {string} runtime */
async function plan(runtime) {
  const repo = repository();
  const main = /** @type {{object: {sha: string}}} */ (api(`repos/${repo}/git/ref/heads/main`))
    .object.sha;
  if (main !== run('git', ['rev-parse', 'HEAD'])) {
    console.log('A newer main push owns OTA release planning.');
    return;
  }
  const releases = /** @type {Release[][]} */ (
    api('--paginate', '--slurp', `repos/${repo}/releases?per_page=100`)
  ).flat();
  const next = otaReleasePlan(runtime, releases);
  const baselineSha = run('git', ['rev-list', '-n', '1', next.baseline]);
  if (!shaPattern.test(baselineSha)) throw new Error('Invalid OTA release baseline');
  const marker = readFileSync(otaVersionPath, 'utf8').trim();
  if (
    marker.startsWith(runtime.slice(0, -1)) &&
    marker !== next.baseline.slice(8) &&
    marker.localeCompare(next.baseline.slice(8), 'en', { numeric: true }) > 0
  )
    throw new Error('A merged OTA release is not staged yet; recover its publication first');
  const paths = run('git', ['diff', '--name-only', `${baselineSha}..HEAD`]).split('\n');
  if (!paths.some(otaSourcePath)) {
    console.log('No OTA source changes since the last Staging release.');
    return;
  }
  const { GitHub } = await import('release-please');
  const [owner, name] = repo.split('/');
  if (!owner || !name) throw new Error('Invalid repository coordinates');
  const token = process.env.GH_TOKEN;
  if (!token) throw new Error('GH_TOKEN is required for OTA release planning');
  const github = await GitHub.create({ owner, repo: name, token });
  const manifest = await createOtaManifest(github, baselineSha, next.version);
  const prs = await manifest.createPullRequests();
  for (const pr of prs) {
    if (!pr) continue;
    run('gh', [
      'workflow',
      'run',
      'ci.yml',
      '--ref',
      pr.headBranchName,
      '-f',
      'release-train=mobile-ota',
      '-f',
      `release-pr=${pr.number}`,
    ]);
    console.log(`Staging OTA ${next.version}: release PR #${pr.number}`);
  }
}

/**
 * @param {import('release-please').GitHub} github
 * @param {string} baselineSha
 * @param {string} version
 */
export async function createOtaManifest(github, baselineSha, version) {
  const { Manifest, registerPlugin } = await import('release-please');
  const { ManifestPlugin } = await import('release-please/build/src/plugin.js');
  const { TagName } = await import('release-please/build/src/util/tag-name.js');
  const { Version } = await import('release-please/build/src/version.js');
  // Release Please's root component would otherwise include unrelated server
  // commits, and an apps/mobile component would silently omit shared mobile code.
  registerPlugin(
    'mobile-ota-sources',
    (options) =>
      new (class extends ManifestPlugin {
        /**
         * @override
         * @param {import('release-please/build/src/commit.js').ConventionalCommit[]} commits
         */
        processCommits(commits) {
          return commits.filter((commit) => commit.files?.some(otaSourcePath));
        }
        /**
         * @override
         * @param {Record<string, import('release-please/build/src/strategy.js').Strategy>} strategies
         * @param {Record<string, import('release-please/build/src/commit.js').Commit[]>} _commits
         * @param {Record<string, import('release-please/build/src/release.js').Release>} releases
         */
        preconfigure(strategies, _commits, releases) {
          const strategy = strategies['.'];
          if (!strategy) throw new Error('OTA root release strategy is missing');
          // Sharing mobile-v tags must not overwrite the native release PR branch.
          strategy.getBranchComponent = () => Promise.resolve('mobile-ota');
          const parts = version.split('.').map(Number);
          const prior = `${parts[0]}.${parts[1]}.${Number(parts[2]) - 1}`;
          releases['.'] = {
            tag: new TagName(Version.parse(prior), 'mobile', '-'),
            sha: baselineSha,
            notes: '',
          };
          return Promise.resolve(strategies);
        }
      })(options.github, options.targetBranch, options.repositoryConfig),
  );
  return Manifest.fromManifest(
    github,
    'main',
    otaConfigPath,
    otaManifestPath,
    { lastReleaseSha: baselineSha, bootstrapSha: baselineSha },
    undefined,
    version,
  );
}

/** @param {string} runtime */
function mergedVersion(runtime) {
  const version = readFileSync(otaVersionPath, 'utf8').trim();
  if (
    !versionPattern.test(version) ||
    !version.startsWith(runtime.slice(0, -1)) ||
    version.endsWith('.0')
  )
    throw new Error('Merged OTA version does not match the published native runtime');
  /** @type {unknown} */
  const manifest = JSON.parse(readFileSync(otaManifestPath, 'utf8'));
  if (!manifest || typeof manifest !== 'object' || !('.' in manifest) || manifest['.'] !== version)
    throw new Error('OTA manifest and version marker differ');
  const commit = run('git', ['log', '-1', '--format=%H', '--', otaVersionPath]);
  const prs = /** @type {Pull[]} */ (api(`repos/${repository()}/commits/${commit}/pulls`));
  const pr = prs.find(
    (pr) =>
      pr.merged_at &&
      pr.base.ref === 'main' &&
      pr.head.ref === 'release-please--branches--main--components--mobile-ota' &&
      ['github-actions[bot]', 'app/github-actions'].includes(pr.user?.login ?? ''),
  );
  if (!pr) throw new Error('OTA publication requires a merged Release Please Staging PR');
  const checked = /** @type {{content: string}} */ (
    api(`repos/${repository()}/contents/${otaVersionPath}?ref=${pr.head.sha}`)
  );
  if (Buffer.from(checked.content, 'base64').toString().trim() !== version)
    throw new Error('OTA marker differs from the reviewed release PR');
  return {
    version,
    commit,
    pr: pr.number,
    complete: pr.labels?.some((label) => label.name === 'autorelease: tagged-mobile-ota') ?? false,
  };
}

function detect() {
  const output = process.env.GITHUB_OUTPUT;
  if (!output) throw new Error('GITHUB_OUTPUT is required');
  const version = readFileSync(otaVersionPath, 'utf8').trim();
  if (!versionPattern.test(version)) throw new Error('Invalid OTA version marker');
  const runtime = `${version.split('.').slice(0, 2).join('.')}.0`;
  if (version.endsWith('.0')) {
    appendFileSync(output, 'mode=plan\n');
    return;
  }
  const release = /** @type {Release[][]} */ (
    api('--paginate', '--slurp', `repos/${repository()}/releases?per_page=100`)
  )
    .flat()
    .find((release) => release.tag_name === `mobile-v${version}` && !release.draft);
  const merged = mergedVersion(runtime);
  if (release) {
    if (run('git', ['rev-list', '-n', '1', `mobile-v${version}`]) !== merged.commit)
      throw new Error('Published OTA tag differs from its merged release source');
  }
  if (release && (merged.complete || !release.prerelease)) {
    if (!merged.complete) complete(String(merged.pr));
    appendFileSync(output, 'mode=plan\n');
  } else {
    appendFileSync(
      output,
      `mode=stage\nversion=${version}\ncommit=${merged.commit}\npr=${merged.pr}\n`,
    );
  }
}

/** @param {string} number */
function complete(number) {
  if (!/^[1-9]\d*$/u.test(number)) throw new Error('Invalid OTA release PR number');
  run('gh', ['label', 'create', 'autorelease: tagged-mobile-ota', '--color', '0E8A16', '--force']);
  run('gh', [
    'pr',
    'edit',
    number,
    '--remove-label',
    'autorelease: pending-mobile-ota',
    '--add-label',
    'autorelease: tagged-mobile-ota',
  ]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === 'plan') await plan(process.argv[3] ?? '');
  else if (process.argv[2] === 'detect') detect();
  else if (process.argv[2] === 'complete') complete(process.argv[3] ?? '');
  else throw new Error('Usage: mobile-ota-proposal.mjs plan <runtime> | detect | complete <pr>');
}
