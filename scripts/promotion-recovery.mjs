import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// This list is the retry boundary, not the product source boundary. Changes to
// these execution/validation inputs allow two attempts for the same approval.
/** @typedef {'ota' | 'server' | 'native'} PromotionKind */
/** @type {Record<PromotionKind, {manifest:string, workflow:string, paths:string[]}>} */
export const promotionInputs = {
  ota: {
    manifest: 'apps/mobile/ota-promotion.json',
    workflow: 'mobile-ota-promote.yml',
    paths: [
      'scripts/mobile-ota-release.ts',
      'package-lock.json',
      '.npmrc',
      'scripts/prepare-mobile-eas-build.mjs',
      'scripts/patch-mobile-native-deps.mjs',
      'apps/mobile/app.config.ts',
      'apps/mobile/plugins',
      'apps/mobile/build',
    ],
  },
  server: {
    manifest: 'releases/server-production.json',
    workflow: 'server-production-promote.yml',
    paths: [
      'scripts/production-promotion.ts',
      'scripts/capture-json.mjs',
      'scripts/promotion-changelog.mjs',
      'scripts/finalize-server-production.sh',
    ],
  },
  native: {
    manifest: 'releases/mobile-production.json',
    workflow: 'mobile-production-promote.yml',
    paths: [
      'scripts/production-promotion.ts',
      'scripts/capture-json.mjs',
      'scripts/promotion-changelog.mjs',
    ],
  },
};
/** @param {string[]} args */
const git = (...args) =>
  execFileSync('git', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).trim();
/** @param {string} value */
const hash = (value) => createHash('sha256').update(value).digest('hex');

/** Read immutable Git objects only; never execute historical code.
 * @param {PromotionKind} kind
 * @param {string} ref
 */
export function promotionIdentity(kind, ref = 'HEAD') {
  const config = promotionInputs[kind];
  if (!config || !/^(?:HEAD|[a-f0-9]{40})$/.test(ref))
    throw new Error('Invalid promotion revision');
  const contents = git('show', `${ref}:${config.manifest}`);
  const manifest = /** @type {unknown} */ (JSON.parse(contents));
  if (
    typeof manifest !== 'object' ||
    manifest === null ||
    !('version' in manifest) ||
    typeof manifest.version !== 'string'
  )
    throw new Error('Invalid historical promotion manifest');
  const paths = [
    `.github/workflows/${config.workflow}`,
    'scripts/promotion-recovery.mjs',
    'scripts/release-bot-logins.mjs',
    'package.json',
    ...config.paths,
  ];
  // Missing optional paths are represented by their absence in ls-tree. A new
  // helper changes the key; an unrelated Main merge does not.
  const tree = git('ls-tree', '-r', ref, '--', ...paths);
  if (!tree.includes(`.github/workflows/${config.workflow}`))
    throw new Error('Promotion workflow is missing');
  // npm ci executes workspace lifecycle hooks. Include workspace manifests,
  // while excluding their product source files from the retry boundary.
  const workspaceManifests =
    kind === 'ota'
      ? git('ls-tree', '-r', ref, '--', 'apps', 'packages')
          .split('\n')
          .filter((entry) => /\t(?:apps|packages)\/[^/]+\/package\.json$/.test(entry))
          .join('\n')
      : '';
  return { candidate: hash(contents), pipeline: hash(tree + '\n' + workspaceManifests), manifest };
}

/** @param {{name?:string,conclusion?:string}[]} steps */
export function parseRecoveryReceipt(steps) {
  const names = steps
    // GitHub lists the final step even when preflight failed and it never ran.
    // An executed stale-checkout receipt has conclusion=success, state=skipped.
    .filter((step) => step.conclusion !== 'skipped')
    .map((step) => step.name)
    .filter((name) => typeof name === 'string' && name.startsWith('recovery-v1:'));
  if (!names.length) return undefined;
  if (names.length !== 1) throw new Error('Ambiguous promotion receipt');
  const match =
    /^recovery-v1:([a-f0-9]{64}):([a-f0-9]{64}):(success|failure|cancelled|skipped|deferred)$/.exec(
      names[0] ?? '',
    );
  if (!match) throw new Error('Invalid promotion receipt');
  return { candidate: match[1], pipeline: match[2], state: match[3] };
}

/** @param {PromotionKind} kind @param {string} expectedCandidate @param {string} expectedPipeline */
export function promotionPreflight(kind, expectedCandidate = '', expectedPipeline = '') {
  const identity = promotionIdentity(kind);
  if (Boolean(expectedCandidate) !== Boolean(expectedPipeline))
    throw new Error('Incomplete recovery expectation');
  const ready =
    (!expectedCandidate || expectedCandidate === identity.candidate) &&
    (!expectedPipeline || expectedPipeline === identity.pipeline);
  const lines = `candidate=${identity.candidate}\npipeline=${identity.pipeline}\nready=${ready}\n`;
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, lines);
  if (!ready)
    console.log(
      'Promotion checkout differs from the requested recovery; defer to a fresh reconciliation.',
    );
  return { ...identity, ready };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  promotionPreflight(
    /** @type {PromotionKind} */ (process.argv[2]),
    process.env.RECOVERY_CANDIDATE,
    process.env.RECOVERY_PIPELINE,
  );
}
