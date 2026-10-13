import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import type { Database, SecretCipher } from '@verity/store';
import { createPostgresSecretJobFrameSpool } from './secret-job-frame-spool.js';

export const TRUSTED_OUTPUT_BYTES = 10 * 1024 * 1024;
const RETENTION_MS = 60 * 60 * 1000;
const PAGE_BYTES = 12 * 1024;
export type OutputOwner = { projectId: string; sessionId: string };
export interface TrustedCliOutputStore {
  begin(owner: OutputOwner): Promise<string>;
  append(id: string, stream: 'stdout' | 'stderr', text: string): Promise<void>;
  finish(id: string, result: Record<string, unknown>): Promise<void>;
  read(owner: OutputOwner, id: string, cursor?: number): Promise<unknown>;
  remove(id: string): Promise<void>;
  cleanup(): Promise<void>;
}

/** Only redacted text reaches this adapter; encrypted frame storage supplies durable receipts. */
export function createTrustedCliOutputStore(
  db: Kysely<Database>,
  cipher: SecretCipher,
  now: () => Date = () => new Date(),
): TrustedCliOutputStore {
  const spool = createPostgresSecretJobFrameSpool(db, cipher, {
    maxJobBytes: TRUSTED_OUTPUT_BYTES,
    now,
  });
  // Each retained invocation reserves its full ceiling, bounding aggregate payload to 200 MiB.
  const cleanup = async () => {
    await db.transaction().execute(async (tx) => {
      const expired = await sql<{
        id: string;
      }>`delete from trusted_cli_outputs where expires_at <= ${now().toISOString()} returning id`.execute(
        tx,
      );
      for (const { id } of expired.rows)
        await sql`delete from secret_job_frames where job_id = ${id}`.execute(tx);
    });
  };
  return {
    cleanup,
    async begin(owner) {
      await cleanup();
      const id = randomUUID();
      await db.transaction().execute(async (tx) => {
        await sql`select pg_advisory_xact_lock(hashtext('verity.trusted-cli-output-quota'))`.execute(
          tx,
        );
        const { rows } = await sql<{
          total: number;
          project: number;
        }>`select count(*)::integer as total, count(*) filter (where project_id = ${owner.projectId})::integer as project from trusted_cli_outputs`.execute(
          tx,
        );
        if ((rows[0]?.total ?? 0) >= 20 || (rows[0]?.project ?? 0) >= 5)
          throw new Error('trusted CLI output quota exceeded');
        // Abandoned executions have a bounded lease even when the server never returns to finish.
        await sql`insert into trusted_cli_outputs(id, project_id, session_id, expires_at, next_sequence) values (${id}, ${owner.projectId}, ${owner.sessionId}, ${new Date(now().getTime() + 2 * RETENTION_MS).toISOString()}, 0)`.execute(
          tx,
        );
      });
      return id;
    },
    async append(id, stream, text) {
      for (let offset = 0; offset < text.length;) {
        // Bound by worst-case UTF-8 bytes and avoid splitting a surrogate pair.
        let end = Math.min(text.length, offset + PAGE_BYTES / 4);
        if (end < text.length && /[\uD800-\uDBFF]/u.test(text[end - 1]!)) end--;
        const payload = text.slice(offset, end);
        await db.transaction().execute(async (tx) => {
          const { rows } = await sql<{
            next_sequence: number;
          }>`select next_sequence from trusted_cli_outputs where id = ${id} and result is null and expires_at > ${now().toISOString()} for update`.execute(
            tx,
          );
          const sequence = rows[0]?.next_sequence;
          if (sequence === undefined) throw new Error('trusted CLI output unavailable');
          await createPostgresSecretJobFrameSpool(tx, cipher, {
            maxJobBytes: TRUSTED_OUTPUT_BYTES,
            now,
          }).persist({
            protocolVersion: 1,
            jobId: id,
            sequence,
            stream,
            encoding: 'utf8',
            payload,
            emittedAt: now().toISOString(),
          });
          await sql`update trusted_cli_outputs set next_sequence = ${sequence + 1} where id = ${id}`.execute(
            tx,
          );
        });
        offset = end;
      }
    },
    async finish(id, result) {
      const receipt =
        await sql`update trusted_cli_outputs set result = ${cipher.encrypt(JSON.stringify(result))}, expires_at = ${new Date(now().getTime() + RETENTION_MS).toISOString()} where id = ${id} returning id`.execute(
          db,
        );
      if (receipt.rows.length !== 1) throw new Error('trusted CLI output unavailable');
    },
    async read(owner, id, cursor = 0) {
      await cleanup();
      const { rows } = await sql<{
        result: string | null;
        expires_at: Date;
        next_sequence: number;
      }>`select result, expires_at, next_sequence from trusted_cli_outputs where id = ${id} and project_id = ${owner.projectId} and session_id = ${owner.sessionId}`.execute(
        db,
      );
      const row = rows[0];
      if (row === undefined) throw new Error('trusted CLI output not found');
      const page = await spool.readPage(id, cursor);
      // The storage page is larger than the model response budget. One bounded frame per call.
      const frame = page.frames[0];
      return {
        invocationId: id,
        frames: frame === undefined ? [] : [frame],
        nextCursor: frame === undefined ? cursor : frame.sequence + 1,
        hasMore: page.frames.length > 1 || page.hasMore,
        complete: row.result !== null,
        expiresAt: new Date(row.expires_at).toISOString(),
        ...(row.result === null
          ? {}
          : { result: JSON.parse(cipher.decrypt(row.result)) as unknown }),
      };
    },
    async remove(id) {
      await db.transaction().execute(async (tx) => {
        await sql`delete from trusted_cli_outputs where id = ${id}`.execute(tx);
        await sql`delete from secret_job_frames where job_id = ${id}`.execute(tx);
      });
    },
  };
}
