import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

// @ts-expect-error -- plain .mjs helper, no types
import { formatBytes, numericEnv, run, selectEvictions } from './prune-actions-cache.mjs';

type CacheEntry = {
  id: number;
  key: string;
  ref: string;
  size_in_bytes: number;
  created_at: string;
  last_accessed_at: string;
};

const NOW = Date.parse('2026-08-08T12:00:00Z');
const MINUTE = 60 * 1000;
const GIB = 1024 * 1024 * 1024;

let nextId = 1;

/** An entry last read `ageMinutes` ago, created at the same time unless stated. */
function entry(
  sizeBytes: number,
  ageMinutes: number,
  overrides: Partial<CacheEntry> = {},
): CacheEntry {
  const at = new Date(NOW - ageMinutes * MINUTE).toISOString();
  const id = nextId++;
  return {
    id,
    // Zero-padded so no key is a prefix of another: GitHub's `key` filter matches
    // by prefix, and the stub below mimics that.
    key: `index-buildkit-${String(id).padStart(4, '0')}`,
    ref: 'refs/heads/main',
    size_in_bytes: sizeBytes,
    created_at: at,
    last_accessed_at: at,
    ...overrides,
  };
}

function select(caches: CacheEntry[], targetBytes = 7 * GIB, minAgeMs = 60 * MINUTE) {
  return selectEvictions({ caches, targetBytes, minAgeMs, now: NOW });
}

describe('Actions cache pruning policy', () => {
  it('does nothing while the repository is under target', () => {
    const result = select([entry(2 * GIB, 600), entry(3 * GIB, 300)]);
    expect(result.evictions).toEqual([]);
    expect(result.remainingBytes).toBe(5 * GIB);
  });

  it('evicts least-recently-used entries until the target is met, and no further', () => {
    // 12 GiB total: over GitHub's 10 GB limit, which is the state that made run
    // 31219396281 fail with `blob: not found` mid-build.
    const oldest = entry(3 * GIB, 5000);
    const middle = entry(3 * GIB, 4000);
    const newer = entry(3 * GIB, 3000);
    const newest = entry(3 * GIB, 2000);

    const result = select([newest, oldest, newer, middle]);

    // Two evictions bring 12 GiB to 6 GiB; a third would be gratuitous.
    expect(result.evictions.map((e) => e.id)).toEqual([oldest.id, middle.id]);
    expect(result.remainingBytes).toBe(6 * GIB);
    expect(result.freedBytes).toBe(6 * GIB);
  });

  it('never touches an entry inside the grace period, even when that leaves it over target', () => {
    // buildkit writes blobs first and the index last, so deleting an entry a
    // running build is still exporting reproduces the exact failure this script
    // prevents. Staying over target is the cheaper of the two outcomes.
    const result = select([entry(6 * GIB, 10), entry(6 * GIB, 30)]);
    expect(result.evictions).toEqual([]);
    expect(result.protectedBytes).toBe(12 * GIB);
    expect(result.remainingBytes).toBe(12 * GIB);
  });

  it('protects an old entry that a running job just read', () => {
    // Created weeks ago but read a minute ago: LRU order would take it first,
    // and it is exactly the entry an in-flight `cache-from` depends on.
    const hot = entry(6 * GIB, 20000, {
      last_accessed_at: new Date(NOW - 1 * MINUTE).toISOString(),
    });
    const cold = entry(6 * GIB, 20000);

    const result = select([hot, cold]);

    expect(result.evictions.map((e) => e.id)).toEqual([cold.id]);
  });

  it('protects a freshly created entry that reports an old last read', () => {
    const fresh = entry(6 * GIB, 20000, {
      created_at: new Date(NOW - 2 * MINUTE).toISOString(),
    });
    const cold = entry(6 * GIB, 20000);

    expect(select([fresh, cold]).evictions.map((e) => e.id)).toEqual([cold.id]);
  });

  it('treats an unparseable timestamp as too fresh to delete', () => {
    // Refusing to delete costs budget; deleting a live entry costs a red build.
    const broken = entry(8 * GIB, 5000, { last_accessed_at: 'not a date', created_at: 'nonsense' });
    expect(select([broken]).evictions).toEqual([]);
  });

  it('prunes pull-request refs like any other entry', () => {
    // A `refs/pull/N/merge` entry is readable only by that one PR, so it is pure
    // budget for everyone else — but it is still only evicted once it is cold.
    const pr = entry(5 * GIB, 5000, { ref: 'refs/pull/1361/merge' });
    const main = entry(5 * GIB, 4000);
    expect(select([pr, main]).evictions.map((e) => e.id)).toEqual([pr.id]);
  });

  it('reports totals for an empty repository without dividing by zero', () => {
    const result = select([]);
    expect(result).toMatchObject({ totalBytes: 0, remainingBytes: 0, freedBytes: 0 });
    expect(result.evictions).toEqual([]);
  });

  it('reads a blank workflow_dispatch input as unset, not as zero', () => {
    // Every scheduled run passes `target-bytes: ''`. `Number('')` is 0, and a
    // target of 0 means "delete every cold entry in the repository".
    expect(numericEnv('CACHE_TARGET_BYTES', 7 * GIB, {})).toBe(7 * GIB);
    expect(numericEnv('CACHE_TARGET_BYTES', 7 * GIB, { CACHE_TARGET_BYTES: '' })).toBe(7 * GIB);
    expect(numericEnv('CACHE_TARGET_BYTES', 7 * GIB, { CACHE_TARGET_BYTES: '  ' })).toBe(7 * GIB);
    expect(numericEnv('CACHE_TARGET_BYTES', 7 * GIB, { CACHE_TARGET_BYTES: '0' })).toBe(0);
    expect(numericEnv('CACHE_TARGET_BYTES', 7 * GIB, { CACHE_TARGET_BYTES: '1073741824' })).toBe(
      GIB,
    );
  });

  it('refuses a target it cannot interpret rather than guessing', () => {
    expect(() => numericEnv('CACHE_TARGET_BYTES', 7 * GIB, { CACHE_TARGET_BYTES: '7GiB' })).toThrow(
      /non-negative number/,
    );
    expect(() => numericEnv('CACHE_TARGET_BYTES', 7 * GIB, { CACHE_TARGET_BYTES: '-1' })).toThrow(
      /non-negative number/,
    );
  });

  it('formats sizes the way the workflow summary reads them', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1536)).toBe('1.50 KiB');
    expect(formatBytes(12.29 * GIB)).toBe('12.29 GiB');
  });
});

describe('Actions cache pruning against the API', () => {
  // The policy above is the interesting half, but this is the half that runs
  // unattended with `actions: write` on a schedule. A pagination bug that drops
  // the second page, or a DELETE aimed at the wrong id, removes entries a build
  // is about to read — the exact failure the janitor exists to prevent.
  let server: Server | undefined;

  afterEach(async () => {
    if (server === undefined) return;
    server.close();
    await once(server, 'close');
    server = undefined;
  });

  /** Serves `caches` over the two endpoints the script uses, recording deletes. */
  async function stubApi(caches: CacheEntry[]) {
    const deleted: number[] = [];
    const authorized: string[] = [];
    server = createServer((request, response) => {
      authorized.push(String(request.headers.authorization));
      const url = new URL(request.url ?? '/', 'http://stub');
      if (request.method === 'DELETE') {
        deleted.push(Number(url.pathname.split('/').pop()));
        response.writeHead(204).end();
        return;
      }
      // The script filters by `key` when it re-reads a single entry before
      // deleting it; GitHub matches that as a prefix.
      const key = url.searchParams.get('key');
      const matching = key === null ? caches : caches.filter((one) => one.key.startsWith(key));
      const page = Number(url.searchParams.get('page') ?? '1');
      const perPage = Number(url.searchParams.get('per_page') ?? '100');
      const slice = matching.slice((page - 1) * perPage, page * perPage);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ total_count: matching.length, actions_caches: slice }));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const { port } = server.address() as AddressInfo;
    return { apiUrl: `http://127.0.0.1:${port}`, deleted, authorized };
  }

  it('deletes exactly the entries the policy chose, and authenticates', async () => {
    const cold = entry(6 * GIB, 5000);
    const colder = entry(6 * GIB, 6000);
    const hot = entry(6 * GIB, 5);
    const { apiUrl, deleted, authorized } = await stubApi([cold, colder, hot]);

    const result = await run({
      repository: 'heey-global/verity',
      token: 'stub-token',
      apiUrl,
      targetBytes: 7 * GIB,
      minAgeMs: 60 * MINUTE,
      now: NOW,
      log: () => {},
    });

    // 18 GiB total; the two cold entries go, the fresh one is left even though
    // that keeps the repo above target.
    expect(deleted).toEqual([colder.id, cold.id]);
    expect(result.deleted).toEqual([colder.id, cold.id]);
    expect(new Set(authorized)).toEqual(new Set(['Bearer stub-token']));
  });

  it('paginates past the first hundred entries', async () => {
    // GitHub caps per_page at 100. A janitor that reads only the first page
    // would silently stop pruning exactly when the repo is fullest.
    const caches = Array.from({ length: 250 }, (_, index) =>
      entry(100 * 1024 * 1024, 5000 + index),
    );
    const { apiUrl, deleted } = await stubApi(caches);

    await run({
      repository: 'heey-global/verity',
      token: 'stub-token',
      apiUrl,
      targetBytes: 0,
      minAgeMs: 60 * MINUTE,
      now: NOW,
      log: () => {},
    });

    expect(deleted).toHaveLength(250);
  });

  it('deletes nothing on a dry run', async () => {
    const { apiUrl, deleted } = await stubApi([entry(9 * GIB, 5000), entry(9 * GIB, 6000)]);

    const result = await run({
      repository: 'heey-global/verity',
      token: 'stub-token',
      apiUrl,
      dryRun: true,
      targetBytes: 7 * GIB,
      minAgeMs: 60 * MINUTE,
      now: NOW,
      log: () => {},
    });

    expect(deleted).toEqual([]);
    expect(result.summary).toContain('dry run');
    // The size after the arrow is what the run WOULD reach, not what it did.
    // Unlabelled, a dispatch's step summary reads as a trim that happened.
    expect(result.summary).toContain('18.00 GiB → 0 B (projected)');
  });

  it('leaves an entry a build reached between the listing and the delete', async () => {
    // The freshness check runs against a snapshot. If a build restores a cold
    // entry after that snapshot, deleting it mid-restore reproduces the exact
    // `blob: not found` failure the janitor exists to prevent — so a re-read
    // showing a newer access time has to veto the delete.
    const warmed = entry(9 * GIB, 6000);
    const stale = entry(9 * GIB, 5000);
    const { apiUrl } = await stubApi([warmed, stale]);
    const deleted: number[] = [];
    server?.removeAllListeners('request');
    server?.on('request', (request, response) => {
      const url = new URL(request.url ?? '/', 'http://stub');
      if (request.method === 'DELETE') {
        deleted.push(Number(url.pathname.split('/').pop()));
        response.writeHead(204).end();
        return;
      }
      // The opening listing carries no `key` and still reports both as cold;
      // only the re-read of `warmed` sees the access a build just made.
      const key = url.searchParams.get('key');
      const served =
        key === null
          ? [warmed, stale]
          : key === warmed.key
            ? [{ ...warmed, last_accessed_at: new Date(NOW - MINUTE).toISOString() }]
            : [stale];
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ total_count: served.length, actions_caches: served }));
    });

    const result = await run({
      repository: 'heey-global/verity',
      token: 'stub-token',
      apiUrl,
      targetBytes: 7 * GIB,
      minAgeMs: 60 * MINUTE,
      now: NOW,
      log: () => {},
    });

    expect(deleted).toEqual([stale.id]);
    expect(result.deleted).toEqual([stale.id]);
    // Left above target on purpose: a red build costs more than 9 GiB of budget,
    // and the next run six hours later takes it if it has gone cold again.
    expect(result.remainingBytes).toBe(9 * GIB);
    expect(result.summary).toContain('1 read after the listing, left alone.');
  });

  it('does not send a delete for an entry that vanished before its turn', async () => {
    // Same window, other direction: a concurrent janitor or a GitHub eviction
    // took the entry. The re-read catches it, so no DELETE is issued at all.
    const first = entry(9 * GIB, 6000);
    const second = entry(9 * GIB, 5000);
    const { apiUrl } = await stubApi([first, second]);
    const deleted: number[] = [];
    server?.removeAllListeners('request');
    server?.on('request', (request, response) => {
      const url = new URL(request.url ?? '/', 'http://stub');
      if (request.method === 'DELETE') {
        deleted.push(Number(url.pathname.split('/').pop()));
        response.writeHead(204).end();
        return;
      }
      const served = url.searchParams.get('key') === null ? [first, second] : [];
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ total_count: served.length, actions_caches: served }));
    });

    const result = await run({
      repository: 'heey-global/verity',
      token: 'stub-token',
      apiUrl,
      targetBytes: 7 * GIB,
      minAgeMs: 60 * MINUTE,
      now: NOW,
      log: () => {},
    });

    expect(deleted).toEqual([]);
    expect(result.deleted).toEqual([]);
    expect(result.remainingBytes).toBe(0);
    expect(result.summary).toContain('2 already gone.');
  });

  it('survives an entry another run already removed', async () => {
    // The listing and the delete are not atomic. A 404 here means the entry is
    // gone, which is the outcome we wanted — it must not fail the scheduled job.
    const doomed = entry(9 * GIB, 5000);
    const other = entry(9 * GIB, 6000);
    const { apiUrl } = await stubApi([doomed, other]);
    server?.removeAllListeners('request');
    server?.on('request', (request, response) => {
      if (request.method === 'DELETE') {
        response.writeHead(404).end('{"message":"Not Found"}');
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ total_count: 2, actions_caches: [doomed, other] }));
    });

    const result = await run({
      repository: 'heey-global/verity',
      token: 'stub-token',
      apiUrl,
      targetBytes: 7 * GIB,
      minAgeMs: 60 * MINUTE,
      now: NOW,
      log: () => {},
    });

    expect(result.deleted).toEqual([]);
    // Nothing was deleted BY THIS RUN, but the entries are gone, so their bytes
    // are out of the budget and must not be reported as still occupying it.
    expect(result.remainingBytes).toBe(0);
    expect(result.summary).toContain('Deleted 0 of 2 entries. 2 already gone.');
  });

  it('does not read a conflict as a deletion', async () => {
    // Only 404 establishes that the entry is gone. A 409 leaves it in place, so
    // accepting it would let the run finish above target while claiming a trim.
    const cold = entry(9 * GIB, 5000);
    const colder = entry(9 * GIB, 6000);
    const { apiUrl } = await stubApi([cold, colder]);
    server?.removeAllListeners('request');
    server?.on('request', (request, response) => {
      if (request.method === 'DELETE') {
        response.writeHead(409).end('{"message":"Conflict"}');
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ total_count: 2, actions_caches: [cold, colder] }));
    });

    await expect(
      run({
        repository: 'heey-global/verity',
        token: 'stub-token',
        apiUrl,
        targetBytes: 7 * GIB,
        minAgeMs: 60 * MINUTE,
        now: NOW,
        log: () => {},
      }),
    ).rejects.toThrow(/409/);
  });

  it('fails loudly when it is no longer allowed to delete', async () => {
    // A token that lost `actions: write` returns 403 on every entry. Swallowing
    // that turns a broken scheduled job into a green one, and the symptom shows
    // up weeks later as a red image build on an unrelated PR.
    const cold = entry(9 * GIB, 5000);
    const colder = entry(9 * GIB, 6000);
    const { apiUrl } = await stubApi([cold, colder]);
    server?.removeAllListeners('request');
    server?.on('request', (request, response) => {
      if (request.method === 'DELETE') {
        response.writeHead(403).end('{"message":"Resource not accessible by integration"}');
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ total_count: 2, actions_caches: [cold, colder] }));
    });

    await expect(
      run({
        repository: 'heey-global/verity',
        token: 'stub-token',
        apiUrl,
        targetBytes: 7 * GIB,
        minAgeMs: 60 * MINUTE,
        now: NOW,
        log: () => {},
      }),
    ).rejects.toThrow(/403/);
  });

  it('reports the size it actually reached', async () => {
    const cold = entry(4 * GIB, 5000);
    const colder = entry(4 * GIB, 6000);
    const hot = entry(4 * GIB, 5);
    const { apiUrl } = await stubApi([cold, colder, hot]);

    const result = await run({
      repository: 'heey-global/verity',
      token: 'stub-token',
      apiUrl,
      targetBytes: 8 * GIB,
      minAgeMs: 60 * MINUTE,
      now: NOW,
      log: () => {},
    });

    // 12 GiB, one 4 GiB eviction reaches the 8 GiB target.
    expect(result.deleted).toEqual([colder.id]);
    expect(result.remainingBytes).toBe(8 * GIB);
    expect(result.summary).toContain('12.00 GiB → 8.00 GiB');
  });
});
