import { createSecretCipher } from '@verity/store';
import { createTestDb, truncateAll, type TestDb } from '@verity/store/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { SecretJobFrame } from '@verity/secret-contracts';

import {
  createInMemorySecretJobFrameSpool,
  createPostgresSecretJobFrameSpool,
  SecretJobFrameSpoolError,
  type SecretJobFrameSpool,
  type SecretJobFrameSpoolOptions,
} from './secret-job-frame-spool.js';

const JOB = 'job-1';
// A stable 32-byte key (64 hex chars) so the at-rest envelope round-trips across the run.
const cipher = createSecretCipher('a'.repeat(64));

function frame(overrides: Partial<SecretJobFrame> = {}): SecretJobFrame {
  return {
    protocolVersion: 1,
    jobId: JOB,
    sequence: 0,
    stream: 'stdout',
    encoding: 'utf8',
    payload: 'hello',
    emittedAt: '2026-07-19T00:01:00Z',
    ...overrides,
  };
}

let ctx: TestDb;
beforeAll(async () => {
  ctx = await createTestDb();
});
afterEach(async () => truncateAll(ctx.db));
afterAll(async () => ctx.close());

describe.each<[string, (opts?: SecretJobFrameSpoolOptions) => SecretJobFrameSpool]>([
  ['in-memory', (opts) => createInMemorySecretJobFrameSpool(opts)],
  ['postgres', (opts) => createPostgresSecretJobFrameSpool(ctx.db, cipher, opts)],
])('secret job frame spool (%s)', (_name, makeSpool) => {
  it('persists contiguous frames and replays them in order', async () => {
    const spool = makeSpool();
    await spool.persist(frame({ sequence: 0, payload: 'a' }));
    await spool.persist(frame({ sequence: 1, payload: 'b' }));
    await spool.persist(frame({ sequence: 2, payload: 'c' }));

    const page = await spool.readPage(JOB);
    expect(page.frames.map((f) => f.sequence)).toEqual([0, 1, 2]);
    // Guards the int4 sequence column: a string (int8 on real node-postgres) would break the
    // contiguity arithmetic and the numeric schema parse, so lock the JS number contract here.
    expect(page.frames.every((f) => typeof f.sequence === 'number')).toBe(true);
    expect(page.frames.map((f) => f.payload)).toEqual(['a', 'b', 'c']);
    expect(page.firstSequence).toBe(0);
    expect(page.nextSequence).toBe(3);
    expect(page.hasMore).toBe(false);

    // Resume-from-sequence replay: everything after seq 0.
    const resumed = await spool.readPage(JOB, 1);
    expect(resumed.frames.map((f) => f.sequence)).toEqual([1, 2]);
    expect(resumed.firstSequence).toBe(1);
    // An empty tail read reports where to resume, no firstSequence.
    const empty = await spool.readPage(JOB, 3);
    expect(empty.frames).toEqual([]);
    expect(empty.firstSequence).toBeUndefined();
    expect(empty.nextSequence).toBe(3);
    expect(empty.hasMore).toBe(false);
  });

  it('rejects a non-contiguous (gap) frame fail-closed and persists nothing', async () => {
    const spool = makeSpool();
    await spool.persist(frame({ sequence: 0 }));
    await expect(spool.persist(frame({ sequence: 2 }))).rejects.toThrow(SecretJobFrameSpoolError);
    const page = await spool.readPage(JOB);
    expect(page.frames.map((f) => f.sequence)).toEqual([0]);
  });

  it('rejects a duplicate sequence fail-closed', async () => {
    const spool = makeSpool();
    await spool.persist(frame({ sequence: 0, payload: 'first' }));
    await expect(spool.persist(frame({ sequence: 0, payload: 'again' }))).rejects.toThrow(
      /non-contiguous/,
    );
    const page = await spool.readPage(JOB);
    expect(page.frames.map((f) => f.payload)).toEqual(['first']);
  });

  it('requires the first frame of a job to be sequence 0', async () => {
    const spool = makeSpool();
    await expect(spool.persist(frame({ sequence: 5 }))).rejects.toThrow(/expected 0, got 5/);
    expect((await spool.readPage(JOB)).frames).toEqual([]);
  });

  it('enforces the per-job byte bound and leaves prior frames intact', async () => {
    const spool = makeSpool({ maxJobBytes: 10 });
    await spool.persist(frame({ sequence: 0, payload: 'abcde' })); // 5 bytes
    await spool.persist(frame({ sequence: 1, payload: 'fghij' })); // 10 bytes total
    await expect(spool.persist(frame({ sequence: 2, payload: 'k' }))).rejects.toThrow(
      /exceeded the spool size bound/,
    );
    const page = await spool.readPage(JOB);
    expect(page.frames.map((f) => f.sequence)).toEqual([0, 1]);
  });

  it('bounds a replay page to 256 frames', async () => {
    const spool = makeSpool();
    for (let seq = 0; seq < 257; seq += 1) {
      await spool.persist(frame({ sequence: seq, payload: `p${seq}` }));
    }
    const page = await spool.readPage(JOB);
    expect(page.frames).toHaveLength(256);
    expect(page.frames[0]?.sequence).toBe(0);
    expect(page.frames.at(-1)?.sequence).toBe(255);
    expect(page.nextSequence).toBe(256);
    expect(page.hasMore).toBe(true);

    const tail = await spool.readPage(JOB, 256);
    expect(tail.frames.map((f) => f.sequence)).toEqual([256]);
    expect(tail.hasMore).toBe(false);
  }, 30_000);

  it('bounds a replay page to 1 MiB', async () => {
    const spool = makeSpool();
    const big = 'x'.repeat(64 * 1024); // 64 KiB frames — 16 fill exactly 1 MiB
    for (let seq = 0; seq < 20; seq += 1) {
      await spool.persist(frame({ sequence: seq, payload: big }));
    }
    const page = await spool.readPage(JOB);
    expect(page.frames).toHaveLength(16);
    expect(page.hasMore).toBe(true);
    expect(page.nextSequence).toBe(16);
  }, 30_000);

  it('deletes a job idempotently (the reaper hook)', async () => {
    const spool = makeSpool();
    await spool.persist(frame({ sequence: 0 }));
    await spool.persist(frame({ sequence: 1 }));
    expect(await spool.deleteJob(JOB)).toBe(2);
    expect((await spool.readPage(JOB)).frames).toEqual([]);
    expect(await spool.deleteJob(JOB)).toBe(0);
  });

  it('purges frames ingested at or before a cutoff and keeps newer ones', async () => {
    let clock = Date.parse('2026-07-19T00:00:00Z');
    const spool = makeSpool({ now: () => new Date(clock) });
    await spool.persist(frame({ jobId: 'old', sequence: 0 }));
    const cutoff = new Date(clock).toISOString();
    clock += 60_000; // advance one minute
    await spool.persist(frame({ jobId: 'new', sequence: 0 }));

    expect(await spool.purge(cutoff)).toBe(1);
    expect((await spool.readPage('old')).frames).toEqual([]);
    expect((await spool.readPage('new')).frames).toHaveLength(1);
  });

  it('retains complete history and sequence continuity for a recently continued job', async () => {
    let clock = Date.parse('2026-07-19T00:00:00Z');
    const spool = makeSpool({ now: () => new Date(clock) });
    await spool.persist(frame({ sequence: 0, payload: 'old-prefix' }));
    const cutoff = new Date(clock).toISOString();
    clock += 60_000;
    await spool.persist(frame({ sequence: 1, payload: 'recent-tail' }));

    expect(await spool.purge(cutoff)).toBe(0);
    expect((await spool.readPage(JOB)).frames.map((item) => item.payload)).toEqual([
      'old-prefix',
      'recent-tail',
    ]);
    await expect(
      spool.persist(frame({ sequence: 2, payload: 'continued' })),
    ).resolves.toBeUndefined();
    expect((await spool.readPage(JOB, 2)).frames.map((item) => item.sequence)).toEqual([2]);
  });
});

// Reuses the file-level `ctx` rather than opening a second database: the
// file-level afterEach already truncates between tests, and on the shared
// PostgreSQL harness a second createTestDb() resolves to the SAME database as
// the first (isolation there is per Vitest worker, not per handle), so two live
// handles would only look independent. See packages/store/src/testing.ts.
describe('secret job frame spool (postgres) — encryption at rest', () => {
  it('stores the payload as an enc:v1 envelope, not cleartext, and decrypts it on replay', async () => {
    const spool = createPostgresSecretJobFrameSpool(ctx.db, cipher);
    await spool.persist(frame({ sequence: 0, payload: 'super-redacted-[REDACTED]' }));

    const row = await ctx.db
      .selectFrom('secret_job_frames')
      .select('payload')
      .where('job_id', '=', JOB)
      .executeTakeFirstOrThrow();
    expect(row.payload.startsWith('enc:v1:')).toBe(true);
    expect(row.payload).not.toContain('super-redacted');

    const page = await spool.readPage(JOB);
    expect(page.frames[0]?.payload).toBe('super-redacted-[REDACTED]');
  });
});
