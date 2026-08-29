import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const ledgerPath = 'features/verity-sandbox-toolkit/published-hashes.json';
const manifestPath = '.release-please-manifest.json';
const boundaryFiles = {
  '/usr/local/bin/verity-runner-supervisor':
    'features/verity-sandbox-toolkit/bin/verity-runner-supervisor.mjs',
  '/usr/local/bin/verity-runner-supervisor-start':
    'features/verity-sandbox-toolkit/bin/verity-runner-supervisor-start',
  '/usr/local/bin/verity-runner-worker':
    'features/verity-sandbox-toolkit/bin/verity-runner-worker.mjs',
  '/usr/local/bin/verity-runner-stack-start':
    'features/verity-sandbox-toolkit/bin/verity-runner-stack-start',
};

/** @param {unknown} value */
function parseVersion(value) {
  if (typeof value !== 'string') return undefined;
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value);
  return match === null ? undefined : match.slice(1).map(Number);
}

/** @param {string} left @param {string} right */
function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (a === undefined || b === undefined)
    throw new Error(`invalid release version: ${left}, ${right}`);
  for (let index = 0; index < 3; index += 1) {
    const difference = a[index] - b[index];
    if (difference !== 0) return difference;
  }
  return 0;
}

/** @param {import('node:crypto').BinaryLike} bytes */
function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/** @param {string} ref */
function hashesAt(ref) {
  return Object.fromEntries(
    Object.entries(boundaryFiles).map(([installedPath, sourcePath]) => [
      installedPath,
      sha256(execFileSync('git', ['show', `${ref}:${sourcePath}`])),
    ]),
  );
}

function hashesInWorktree() {
  return Object.fromEntries(
    Object.entries(boundaryFiles).map(([installedPath, sourcePath]) => [
      installedPath,
      sha256(readFileSync(sourcePath)),
    ]),
  );
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @type {unknown} */
const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'));
/** @type {unknown} */
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
if (!isRecord(ledger) || !isRecord(manifest)) {
  throw new Error('toolkit ledger and release manifest must be JSON objects');
}
const minimumVersion = ledger.minimumVersion;
const currentVersion = manifest['.'];
if (parseVersion(minimumVersion) === undefined || parseVersion(currentVersion) === undefined) {
  throw new Error('toolkit ledger and release manifest require plain semantic versions');
}
if (typeof minimumVersion !== 'string' || typeof currentVersion !== 'string') {
  throw new Error('toolkit ledger and release manifest require string versions');
}

/** @type {Map<string, {version: string, hashes: Record<string, string>}>} */
const releases = new Map();
const tags = execFileSync('git', ['tag', '--merged', 'HEAD', '--list', 'v*'], {
  encoding: 'utf8',
})
  .split('\n')
  .filter(Boolean);
for (const tag of tags) {
  const version = tag.slice(1);
  if (parseVersion(version) === undefined || compareVersions(version, minimumVersion) < 0) continue;
  releases.set(version, { version, hashes: hashesAt(tag) });
}

// The publish job normally sees the tag release-please just created. Retain the
// worktree fallback for recovery builds where tag propagation is delayed, but
// never relabel changed worktree bytes as a version whose immutable tag exists.
if (!releases.has(currentVersion)) {
  releases.set(currentVersion, { version: currentVersion, hashes: hashesInWorktree() });
}
ledger.releases = [...releases.values()].sort((a, b) => compareVersions(a.version, b.version));
const rendered = `${JSON.stringify(ledger, null, 2)}\n`;
writeFileSync(ledgerPath, rendered);
