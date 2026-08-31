import { Buffer } from 'node:buffer';

import { sql, type Kysely } from 'kysely';

import { secretJobFrameSchema, type SecretJobFrame } from '@verity/secret-contracts';
import type { Database, SecretCipher } from '@verity/store';

import type { SecretJobFrameSink } from './secret-job-executor.js';

/**
 * The durable, job-scoped spool of ALREADY-REDACTED secret-job output frames (ADR 0009 D8 / W8).
 *
 * It is the single materialisation of the normative output order
 *   child pipe → bounded redactor → bounded frame → durable redacted spool → publish
 * — the ONLY permitted output path from the Secret Job Executor. `persist` is the executor's
 * {@link SecretJobFrameSink}: it appends a redacted frame and resolves ONLY after the durable commit
 * (the "receipt"). A rejection is fail-closed — the executor's drive loop tears the sandbox down and
 * records a failed terminal result — so nothing is ever published without a durable receipt.
 *
 * Guarantees enforced here at the storage boundary:
 * - **Redacted-only**: every appended frame is re-validated against {@link secretJobFrameSchema};
 *   payloads are redacted by construction upstream. They are additionally encrypted at rest as
 *   defense in depth (the in-memory spool is a non-durable test double and does not encrypt).
 * - **0-based contiguity**: the first frame of a job must be sequence 0 and each subsequent frame
 *   exactly one higher; a gap or duplicate rejects fail-closed. The composite `(job_id, sequence)`
 *   primary key backs idempotency across concurrent servers.
 * - **Bounded**: a per-job total-byte cap (W8 total-output limit) rejects an overflowing append;
 *   replay pages are bounded to 256 frames and 1 MiB (the W8 attach page).
 * - **Reapable / retention-bounded**: {@link SecretJobFrameSpool.deleteJob} is the W5 reaper hook and
 *   {@link SecretJobFrameSpool.purge} is an age-based sweep for abandoned jobs.
 */

/** W8 total-output ceiling per job (profile-defined, at most 64 MiB). */
const DEFAULT_MAX_JOB_BYTES = 64 * 1024 * 1024;
/** W8 attach page: at most 256 frames and 1 MiB per read. */
const MAX_PAGE_FRAMES = 256;
const MAX_PAGE_BYTES = 1024 * 1024;

export class SecretJobFrameSpoolError extends Error {}

/** A bounded replay page. Shapes the durable half of {@link secretJobAttachResponseSchema}: the
 * lifecycle/API layer adds the live `state`/`attachmentState`. */
export interface SecretJobFrameSpoolPage {
  frames: SecretJobFrame[];
  /** Sequence of the first returned frame; omitted when the page is empty. */
  firstSequence?: number;
  /** The sequence a follow-up read should resume from (exclusive lower bound + 1). */
  nextSequence: number;
  /** Whether more frames exist beyond this page. */
  hasMore: boolean;
}

export interface SecretJobFrameSpool extends SecretJobFrameSink {
  /**
   * Durably append a redacted frame (persist-before-publish). Resolves only after the durable
   * commit; rejects fail-closed on a non-contiguous sequence, a per-job byte-bound overflow, an
   * invalid frame, or a storage failure. On rejection nothing is persisted for that frame.
   */
  persist(frame: SecretJobFrame): Promise<void>;
  /** Replay a bounded page (≤256 frames, ≤1 MiB) beginning at `nextSequence`
   * (from the start when omitted). */
  readPage(jobId: string, nextSequence?: number): Promise<SecretJobFrameSpoolPage>;
  /** Delete a job's frames (the W5 reaper hook). Idempotent; returns the number of frames removed. */
  deleteJob(jobId: string): Promise<number>;
  /** Retention sweep: delete frames ingested at or before `before` (ISO). Returns rows removed. */
  purge(before: string): Promise<number>;
}

export interface SecretJobFrameSpoolOptions {
  /** Per-job total redacted-byte cap; an append that would exceed it rejects. Default 64 MiB. */
  maxJobBytes?: number;
  /** Ingestion clock (for `created_at` and deterministic retention tests). */
  now?: () => Date;
}

/** Decoded redacted byte length of a frame payload — the size the per-job/page bounds count. */
function framePayloadBytes(frame: SecretJobFrame): number {
  if (frame.encoding === 'utf8') return Buffer.byteLength(frame.payload, 'utf8');
  const padding = frame.payload.endsWith('==') ? 2 : frame.payload.endsWith('=') ? 1 : 0;
  return (frame.payload.length / 4) * 3 - padding;
}

/** The next contiguous sequence a job expects: 0 for the first frame, else previous + 1. */
function expectedSequence(previous: number | undefined): number {
  return previous === undefined ? 0 : previous + 1;
}

/**
 * Select the bounded prefix of `rows` (already ordered by ascending sequence) that fits one page:
 * ≤256 frames and ≤1 MiB by `bytesOf`. `rows` MUST be a superset of the page — the in-memory spool
 * passes every matching row; the Postgres spool passes the first `MAX_PAGE_FRAMES + 1`. `hasMore` is
 * then exact from a single snapshot (`rows.length > included.length`) with no separate count query,
 * and only the included rows are materialised into frames.
 */
function selectPage<T>(
  rows: readonly T[],
  bytesOf: (row: T) => number,
): { included: T[]; hasMore: boolean } {
  const included: T[] = [];
  let bytes = 0;
  for (const row of rows) {
    if (included.length >= MAX_PAGE_FRAMES) break;
    // Always include at least one frame; a single frame is ≤64 KiB so it never alone exceeds 1 MiB.
    if (included.length > 0 && bytes + bytesOf(row) > MAX_PAGE_BYTES) break;
    included.push(row);
    bytes += bytesOf(row);
  }
  return { included, hasMore: rows.length > included.length };
}

/** Assemble the page envelope (firstSequence/nextSequence) from the selected, ordered frames. */
function buildPage(
  nextSequence: number | undefined,
  frames: SecretJobFrame[],
  hasMore: boolean,
): SecretJobFrameSpoolPage {
  const cursor = nextSequence ?? 0;
  const last = frames.at(-1);
  const first = frames.at(0);
  const page: SecretJobFrameSpoolPage = {
    frames,
    nextSequence: last !== undefined ? last.sequence + 1 : cursor,
    hasMore,
  };
  if (first !== undefined) page.firstSequence = first.sequence;
  return page;
}

/** In-memory reference spool (tests / hermetic single-process use). Not durable; no encryption. */
export function createInMemorySecretJobFrameSpool(
  options: SecretJobFrameSpoolOptions = {},
): SecretJobFrameSpool {
  const maxJobBytes = options.maxJobBytes ?? DEFAULT_MAX_JOB_BYTES;
  const now = options.now ?? ((): Date => new Date());
  type Row = { frame: SecretJobFrame; byteLength: number; createdAt: string };
  const jobs = new Map<string, { rows: Row[]; bytes: number }>();

  return {
    persist(unparsed: SecretJobFrame): Promise<void> {
      const frame = secretJobFrameSchema.parse(unparsed);
      const bytes = framePayloadBytes(frame);
      const job = jobs.get(frame.jobId) ?? { rows: [], bytes: 0 };
      const expected = expectedSequence(job.rows.at(-1)?.frame.sequence);
      if (frame.sequence !== expected) {
        return Promise.reject(
          new SecretJobFrameSpoolError(
            `non-contiguous frame sequence: expected ${expected}, got ${frame.sequence}`,
          ),
        );
      }
      if (job.bytes + bytes > maxJobBytes) {
        return Promise.reject(
          new SecretJobFrameSpoolError('job output exceeded the spool size bound'),
        );
      }
      job.rows.push({ frame, byteLength: bytes, createdAt: now().toISOString() });
      job.bytes += bytes;
      jobs.set(frame.jobId, job);
      return Promise.resolve();
    },
    readPage(jobId: string, nextSequence?: number): Promise<SecretJobFrameSpoolPage> {
      const cursor = nextSequence ?? 0;
      const rows = (jobs.get(jobId)?.rows ?? []).filter((r) => r.frame.sequence >= cursor);
      const { included, hasMore } = selectPage(rows, (r) => r.byteLength);
      return Promise.resolve(
        buildPage(
          nextSequence,
          included.map((r) => r.frame),
          hasMore,
        ),
      );
    },
    deleteJob(jobId: string): Promise<number> {
      const count = jobs.get(jobId)?.rows.length ?? 0;
      jobs.delete(jobId);
      return Promise.resolve(count);
    },
    purge(before: string): Promise<number> {
      let removed = 0;
      for (const [jobId, job] of jobs) {
        // Retention is job-granular. Removing an old prefix from a job that has a
        // recent continuation destroys attach history while leaving the tail live;
        // removing its whole history makes the next contiguous sequence look like a
        // new job at sequence 0. Reap only when the newest frame is old.
        if ((job.rows.at(-1)?.createdAt ?? '') <= before) {
          removed += job.rows.length;
          jobs.delete(jobId);
        }
      }
      return Promise.resolve(removed);
    },
  };
}

/** Durable Postgres spool. `payload` is encrypted at rest via `cipher`. */
export function createPostgresSecretJobFrameSpool(
  db: Kysely<Database>,
  cipher: SecretCipher,
  options: SecretJobFrameSpoolOptions = {},
): SecretJobFrameSpool {
  const maxJobBytes = options.maxJobBytes ?? DEFAULT_MAX_JOB_BYTES;
  const now = options.now ?? ((): Date => new Date());

  return {
    async persist(unparsed: SecretJobFrame): Promise<void> {
      const frame = secretJobFrameSchema.parse(unparsed);
      const bytes = framePayloadBytes(frame);
      // One transaction with a per-job advisory lock: read the tail sequence + running byte total,
      // verify contiguity and the byte bound, then insert — atomic across concurrent servers. The
      // insert is the durable receipt; a failure rolls back and rejects, publishing nothing.
      await db.transaction().execute(async (tx) => {
        await sql`select pg_advisory_xact_lock(hashtext(${`verity.secret-frame-spool:${frame.jobId}`}))`.execute(
          tx,
        );
        const tail = await tx
          .selectFrom('secret_job_frames')
          .select('sequence')
          .where('job_id', '=', frame.jobId)
          .orderBy('sequence', 'desc')
          .limit(1)
          .executeTakeFirst();
        const expected = expectedSequence(tail?.sequence);
        if (frame.sequence !== expected) {
          throw new SecretJobFrameSpoolError(
            `non-contiguous frame sequence: expected ${expected}, got ${frame.sequence}`,
          );
        }
        const totalRow = await tx
          .selectFrom('secret_job_frames')
          .select(sql<number>`coalesce(sum(byte_length), 0)`.as('total'))
          .where('job_id', '=', frame.jobId)
          .executeTakeFirst();
        if (Number(totalRow?.total ?? 0) + bytes > maxJobBytes) {
          throw new SecretJobFrameSpoolError('job output exceeded the spool size bound');
        }
        await tx
          .insertInto('secret_job_frames')
          .values({
            job_id: frame.jobId,
            protocol_version: frame.protocolVersion,
            sequence: frame.sequence,
            stream: frame.stream,
            encoding: frame.encoding,
            payload: cipher.encrypt(frame.payload),
            byte_length: bytes,
            emitted_at: frame.emittedAt,
            created_at: now().toISOString(),
          })
          .execute();
      });
    },
    async readPage(jobId: string, nextSequence?: number): Promise<SecretJobFrameSpoolPage> {
      const cursor = nextSequence ?? 0;
      // Fetch one row past the frame cap so `hasMore` is exact from this single snapshot, then bound
      // the page by frame/byte limits BEFORE decrypting so only the returned frames are decrypted.
      const rows = await db
        .selectFrom('secret_job_frames')
        .select([
          'job_id',
          'protocol_version',
          'sequence',
          'stream',
          'encoding',
          'payload',
          'byte_length',
          'emitted_at',
        ])
        .where('job_id', '=', jobId)
        .where('sequence', '>=', cursor)
        .orderBy('sequence', 'asc')
        .limit(MAX_PAGE_FRAMES + 1)
        .execute();
      const { included, hasMore } = selectPage(rows, (row) => row.byte_length);
      const frames = included.map((row) =>
        secretJobFrameSchema.parse({
          protocolVersion: row.protocol_version,
          jobId: row.job_id,
          sequence: row.sequence,
          stream: row.stream,
          encoding: row.encoding,
          payload: cipher.decrypt(row.payload),
          emittedAt: row.emitted_at,
        }),
      );
      return buildPage(nextSequence, frames, hasMore);
    },
    async deleteJob(jobId: string): Promise<number> {
      const result = await db
        .deleteFrom('secret_job_frames')
        .where('job_id', '=', jobId)
        .executeTakeFirst();
      return Number(result.numDeletedRows ?? 0n);
    },
    async purge(before: string): Promise<number> {
      const expiredJobs = db
        .selectFrom('secret_job_frames')
        .select('job_id')
        .groupBy('job_id')
        .having(sql<boolean>`max(created_at) <= ${new Date(before)}`);
      const result = await db
        .deleteFrom('secret_job_frames')
        .where('job_id', 'in', expiredJobs)
        .executeTakeFirst();
      return Number(result.numDeletedRows ?? 0n);
    },
  };
}
