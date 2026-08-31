#!/usr/bin/env node
// Keep the repository's GitHub Actions cache below its 10 GB limit by evicting
// the least-recently-used entries, so GitHub never has to.
//
// GitHub does evict on its own, but it does so lazily and mid-run: a build reads
// a buildkit manifest, GitHub frees space for the entry that build is currently
// exporting, and the next `cache-from` fails with `blob <sha>: not found` on a
// layer the log already reported as CACHED. Run 31219396281 died exactly that
// way with the repo 2.29 GB over the limit. Trimming to a target from the
// outside means the eviction happens between runs instead of inside one.
//
// This is the fallback line, not the fix. The fix is not writing waste in the
// first place — no `cache: npm` on the persistent runners, one `scope` per image
// so nine builds stop overwriting each other's index, and no cache writes from
// pull request refs (see the note on ci.yml's `Build Verity server image` step).
// The janitor exists because any of those can regress silently, and the symptom
// is a red build on an unrelated PR.
//
// Usage: node scripts/prune-actions-cache.mjs [--dry-run]
// Env: GITHUB_TOKEN, GITHUB_REPOSITORY, optionally GITHUB_API_URL,
//      CACHE_TARGET_BYTES, CACHE_MIN_AGE_MINUTES.

/**
 * @typedef {{
 *   id: number,
 *   key: string,
 *   ref: string,
 *   size_in_bytes: number,
 *   created_at: string,
 *   last_accessed_at: string,
 * }} CacheEntry
 */

/** GitHub's hard limit is 10 GB; leave room for one full image export above the target. */
export const DEFAULT_TARGET_BYTES = 7 * 1024 * 1024 * 1024;

/**
 * A cache entry touched this recently may belong to a build that is still
 * running: buildkit writes the blobs first and the index last, so deleting a
 * fresh entry reproduces the very `blob: not found` failure this script exists
 * to prevent. Cold entries are the only safe ones to take.
 *
 * One hour has to exceed the window between a build reading a manifest and
 * finishing with its blobs. That window is not observable from here, so the job
 * runtime is used as an upper bound on it — and that bound only exists because
 * every job in this repo that touches a gha cache carries an explicit
 * `timeout-minutes` under an hour. A job without one inherits GitHub's
 * 360-minute default and blows the bound six times over, so
 * scripts/ci-workflow.test.ts asserts the timeout against this value for every
 * such job rather than leaving it to a comment. Raising this number is safe;
 * lowering it below a build's timeout is not.
 */
export const DEFAULT_MIN_AGE_MS = 60 * 60 * 1000;

/**
 * @param {string} timestamp
 * @returns {number} epoch ms, or NaN for an unparseable value
 */
function epoch(timestamp) {
  return new Date(timestamp).getTime();
}

/**
 * Decide which entries to delete. Pure — no network, no clock — so the policy is
 * unit-testable and the caller owns `now`.
 *
 * @param {{
 *   caches: CacheEntry[],
 *   targetBytes?: number,
 *   minAgeMs?: number,
 *   now: number,
 * }} options
 * @returns {{
 *   totalBytes: number,
 *   evictions: CacheEntry[],
 *   freedBytes: number,
 *   remainingBytes: number,
 *   protectedBytes: number,
 * }}
 */
export function selectEvictions({
  caches,
  targetBytes = DEFAULT_TARGET_BYTES,
  minAgeMs = DEFAULT_MIN_AGE_MS,
  now,
}) {
  const totalBytes = caches.reduce((sum, entry) => sum + entry.size_in_bytes, 0);

  // An entry is "in use" until BOTH its creation and its last read are older
  // than the grace period — a long-lived entry that a running job just read is
  // as unsafe to delete as one that job just wrote.
  const isCold = (/** @type {CacheEntry} */ entry) => {
    const touched = Math.max(epoch(entry.created_at), epoch(entry.last_accessed_at));
    // An unparseable timestamp is treated as fresh: refusing to delete costs
    // budget, deleting a live entry costs a red build.
    return Number.isFinite(touched) && now - touched >= minAgeMs;
  };

  const candidates = caches
    .filter(isCold)
    // Least recently used first — the same order GitHub itself evicts in, so the
    // entries this takes are the ones it was going to take anyway.
    .sort((a, b) => epoch(a.last_accessed_at) - epoch(b.last_accessed_at));

  const protectedBytes = totalBytes - candidates.reduce((sum, e) => sum + e.size_in_bytes, 0);

  /** @type {CacheEntry[]} */
  const evictions = [];
  let remainingBytes = totalBytes;
  for (const entry of candidates) {
    if (remainingBytes <= targetBytes) break;
    evictions.push(entry);
    remainingBytes -= entry.size_in_bytes;
  }

  return {
    totalBytes,
    evictions,
    freedBytes: totalBytes - remainingBytes,
    remainingBytes,
    protectedBytes,
  };
}

/**
 * @param {number} bytes
 * @returns {string}
 */
export function formatBytes(bytes) {
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  let value = bytes;
  let unit = 0;
  while (Math.abs(value) >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 2)} ${units[unit]}`;
}

/**
 * @param {string} path
 * @param {{ method?: string, token: string, apiUrl: string }} options
 * @returns {Promise<unknown>}
 */
async function api(path, { method = 'GET', token, apiUrl }) {
  const response = await fetch(`${apiUrl}${path}`, {
    method,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28',
    },
  });
  if (!response.ok) {
    const error = new Error(
      `${method} ${path} failed: ${response.status} ${await response.text()}`,
    );
    // Callers distinguish "the entry is already gone" from "we are not allowed
    // to delete it", so the status has to survive the throw.
    return Promise.reject(Object.assign(error, { status: response.status }));
  }
  return response.status === 204 ? undefined : await response.json();
}

/**
 * @param {{ repository: string, token: string, apiUrl: string }} options
 * @returns {Promise<CacheEntry[]>}
 */
async function listCaches({ repository, token, apiUrl }) {
  /** @type {CacheEntry[]} */
  const caches = [];
  for (let page = 1; ; page += 1) {
    const body = /** @type {{ actions_caches?: CacheEntry[] }} */ (
      await api(`/repos/${repository}/actions/caches?per_page=100&page=${page}`, { token, apiUrl })
    );
    const batch = body.actions_caches ?? [];
    caches.push(...batch);
    if (batch.length < 100) return caches;
  }
}

/**
 * Ask GitHub about one entry again, immediately before deleting it.
 *
 * The freshness check in `selectEvictions` runs against a snapshot. Between that
 * listing and the DELETE, a build can start and restore an entry that was cold
 * when the snapshot was taken — and deleting a cache mid-restore reproduces the
 * `blob: not found` failure this script exists to prevent. Re-reading the entry
 * here shrinks that window from "the length of the whole run" to "one API
 * round-trip".
 *
 * It does not close the window, and nothing available over this API can: a build
 * may still read the entry between this response and the DELETE. What makes the
 * remainder acceptable is the grace period — an entry only becomes a candidate
 * after an hour with no reads, so a read landing in the millisecond gap is a far
 * smaller risk than the lazy mid-run eviction GitHub performs with no grace
 * period at all.
 *
 * The list endpoint takes `key` and `ref` filters; there is no single-entry read.
 *
 * @param {CacheEntry} entry
 * @param {{ repository: string, token: string, apiUrl: string }} options
 * @returns {Promise<'unchanged' | 'touched' | 'gone'>}
 */
async function revalidate(entry, { repository, token, apiUrl }) {
  const query = new URLSearchParams({ key: entry.key, ref: entry.ref, per_page: '100' });
  const body = /** @type {{ actions_caches?: CacheEntry[] }} */ (
    await api(`/repos/${repository}/actions/caches?${query.toString()}`, { token, apiUrl })
  );
  // `key` matches by prefix, so pick the entry back out by id.
  const fresh = (body.actions_caches ?? []).find((candidate) => candidate.id === entry.id);
  if (fresh === undefined) return 'gone';
  return fresh.last_accessed_at === entry.last_accessed_at ? 'unchanged' : 'touched';
}

/**
 * A workflow_dispatch input that was left blank arrives as an empty string, and
 * `Number('')` is 0 — which would mean "delete everything". Treat blank as unset.
 *
 * @param {string} name
 * @param {number} fallback
 * @param {Record<string, string | undefined>} [env]
 * @returns {number}
 */
export function numericEnv(name, fallback, env = process.env) {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative number, got ${JSON.stringify(raw)}`);
  }
  return value;
}

/**
 * List, select, delete. Separated from `main` so a test can drive it against a
 * stub API: this is the part that runs unattended with `actions: write`, and a
 * bug here deletes cache entries a build is about to read.
 *
 * @param {{
 *   repository: string,
 *   token: string,
 *   apiUrl: string,
 *   dryRun?: boolean,
 *   targetBytes?: number,
 *   minAgeMs?: number,
 *   now?: number,
 *   log?: (message: string) => void,
 * }} options
 * @returns {Promise<{ deleted: number[], summary: string, remainingBytes: number }>}
 */
export async function run({
  repository,
  token,
  apiUrl,
  dryRun = false,
  targetBytes = DEFAULT_TARGET_BYTES,
  minAgeMs = DEFAULT_MIN_AGE_MS,
  now = Date.now(),
  log = console.log,
}) {
  const caches = await listCaches({ repository, token, apiUrl });
  const result = selectEvictions({ caches, targetBytes, minAgeMs, now });

  log(
    `${caches.length} entries, ${formatBytes(result.totalBytes)} total, target ${formatBytes(targetBytes)}`,
  );
  if (result.evictions.length === 0) {
    log(
      result.totalBytes <= targetBytes
        ? 'Under target, nothing to do.'
        : `Over target, but every entry is younger than ${minAgeMs / 60000} minutes — leaving them alone.`,
    );
  }

  /** @type {number[]} */
  const deleted = [];
  let freedBytes = 0;
  let alreadyGone = 0;
  let warmedUp = 0;
  for (const entry of result.evictions) {
    const label = `${entry.key} (${entry.ref}, ${formatBytes(entry.size_in_bytes)}, last read ${entry.last_accessed_at})`;
    if (dryRun) {
      log(`would delete ${label}`);
      continue;
    }
    const state = await revalidate(entry, { repository, token, apiUrl });
    if (state === 'gone') {
      alreadyGone += 1;
      freedBytes += entry.size_in_bytes;
      log(`already gone: ${label}`);
      continue;
    }
    if (state === 'touched') {
      // Something read this entry after the snapshot was taken, so it may be
      // mid-restore right now. Leave it and stay above target; the next run in
      // six hours takes it if it has gone cold again.
      warmedUp += 1;
      log(`read since listing, leaving it alone: ${label}`);
      continue;
    }
    try {
      await api(`/repos/${repository}/actions/caches/${entry.id}`, {
        method: 'DELETE',
        token,
        apiUrl,
      });
      deleted.push(entry.id);
      freedBytes += entry.size_in_bytes;
      log(`deleted ${label}`);
    } catch (error) {
      // The listing and the delete are not atomic, so a concurrent run may have
      // replaced or evicted this entry in between. 404 is the ONLY response that
      // establishes the entry is gone, which is the outcome we wanted; a 409 does
      // not, so it must not be mistaken for one.
      const status = /** @type {{ status?: number }} */ (error).status;
      if (status === 404) {
        // Gone is gone: those bytes are no longer in the budget either, so they
        // count toward what was freed even though this run did not free them.
        // Leaving them out would report the repository as still over target.
        alreadyGone += 1;
        freedBytes += entry.size_in_bytes;
        log(`already gone: ${label}`);
        continue;
      }
      // Anything else — a token that lost `actions: write`, a rate limit, an
      // outage — means the janitor is not doing its job. Swallowing it would let
      // a scheduled run report success indefinitely while the cache fills up and
      // the image builds start failing again.
      throw error;
    }
  }

  // On a real run, report what actually happened rather than what was planned: a
  // number derived from the plan would claim the repository was trimmed even when
  // every delete was skipped. A dry run has no "actually" to report and exists to
  // answer "what would this do", so it keeps the plan's projection — labelled as
  // one below.
  const remainingBytes = dryRun ? result.remainingBytes : result.totalBytes - freedBytes;
  const summary = [
    `Deleted ${dryRun ? `${result.evictions.length} (dry run)` : deleted.length} of ${caches.length} entries.`,
    ...(alreadyGone > 0 ? [`${alreadyGone} already gone.`] : []),
    ...(warmedUp > 0 ? [`${warmedUp} read after the listing, left alone.`] : []),
    // A dry run's arrow is a projection, not a measurement — nothing moved. Say
    // so, so the step summary of a dispatch cannot be read as a trim that ran.
    `${formatBytes(result.totalBytes)} → ${formatBytes(remainingBytes)}${dryRun ? ' (projected)' : ''}`,
    `(${formatBytes(result.protectedBytes)} too recent to touch)`,
  ].join(' ');
  log(summary);
  return { deleted, summary, remainingBytes };
}

async function main() {
  const token = process.env.GITHUB_TOKEN;
  const repository = process.env.GITHUB_REPOSITORY;
  if (token === undefined || token === '' || repository === undefined || repository === '') {
    console.error('GITHUB_TOKEN and GITHUB_REPOSITORY are required');
    process.exit(1);
  }

  const { summary } = await run({
    repository,
    token,
    apiUrl: process.env.GITHUB_API_URL ?? 'https://api.github.com',
    dryRun: process.argv.includes('--dry-run'),
    targetBytes: numericEnv('CACHE_TARGET_BYTES', DEFAULT_TARGET_BYTES),
    minAgeMs: numericEnv('CACHE_MIN_AGE_MINUTES', DEFAULT_MIN_AGE_MS / 60000) * 60 * 1000,
  });

  const stepSummary = process.env.GITHUB_STEP_SUMMARY;
  if (stepSummary !== undefined && stepSummary !== '') {
    const { appendFileSync } = await import('node:fs');
    appendFileSync(stepSummary, `### Actions cache\n\n${summary}\n`);
  }
}

// `import.meta.main` is not available on the pinned Node version, so compare paths.
if (process.argv[1]?.endsWith('prune-actions-cache.mjs') === true) {
  main().catch((error) => {
    console.error(String(error));
    process.exit(1);
  });
}
