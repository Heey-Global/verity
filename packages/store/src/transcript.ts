import type { Kysely } from 'kysely';
import type { Database } from './schema.js';

/** Rows per INSERT — keeps bind params well under Postgres's 65535 cap. */
const APPEND_CHUNK = 1000;

/**
 * The durable verbatim transcript (concept §5a). Stores the raw `.jsonl` lines
 * claude writes, append-only and line-for-line, so the file claude `--resume`
 * reads can be reconstructed after a container rebuild — the lossless
 * counterpart to the canonical {@link EventStore} view.
 *
 * Reconstruction is **line-faithful**, not byte-faithful: each stored line is a
 * `.jsonl` line WITHOUT its trailing newline, and {@link materialize} re-emits
 * one LF per line. Contract the producer (the M2c-2 `.jsonl` tail) must uphold:
 * split on LF, strip the trailing newline, and assume an LF-terminated source.
 * A CRLF source or a final line without a newline would otherwise drift by a
 * byte on reconstruction.
 */
export class TranscriptStore {
  constructor(private readonly db: Kysely<Database>) {}

  /** Append one verbatim line (without its trailing newline). */
  async appendLine(sessionId: string, line: string): Promise<void> {
    await this.db.insertInto('transcript_lines').values({ session_id: sessionId, line }).execute();
  }

  /**
   * Append many lines in order. No-op for an empty list. Inserts in chunks (so a
   * whole-transcript restore can't exceed Postgres's bind-parameter limit),
   * wrapped in one transaction so the restore is all-or-nothing — never a torn
   * partial-prefix on failure.
   */
  async appendLines(sessionId: string, lines: readonly string[]): Promise<void> {
    if (lines.length === 0) return;
    await this.db.transaction().execute(async (tx) => {
      for (let i = 0; i < lines.length; i += APPEND_CHUNK) {
        const batch = lines.slice(i, i + APPEND_CHUNK);
        await tx
          .insertInto('transcript_lines')
          .values(batch.map((line) => ({ session_id: sessionId, line })))
          .execute();
      }
    });
  }

  /**
   * Replace a session's whole transcript with `lines`, atomically. The transcript
   * is append-only in normal operation; this is the controlled rewrite path for
   * when claude itself rewrites/compacts the `.jsonl` (the file shrinks below the
   * tail offset) — without it, re-reading the rewritten file would duplicate the
   * log. Clears then re-inserts in one transaction.
   */
  async replaceLines(sessionId: string, lines: readonly string[]): Promise<void> {
    await this.db.transaction().execute(async (tx) => {
      await tx.deleteFrom('transcript_lines').where('session_id', '=', sessionId).execute();
      for (let i = 0; i < lines.length; i += APPEND_CHUNK) {
        const batch = lines.slice(i, i + APPEND_CHUNK);
        await tx
          .insertInto('transcript_lines')
          .values(batch.map((line) => ({ session_id: sessionId, line })))
          .execute();
      }
    });
  }

  /** The session's verbatim lines in append order. */
  async getLines(sessionId: string): Promise<string[]> {
    const rows = await this.db
      .selectFrom('transcript_lines')
      .select('line')
      .where('session_id', '=', sessionId)
      .orderBy('id', 'asc')
      .execute();
    return rows.map((row) => row.line);
  }

  /**
   * Reconstruct the `.jsonl` content: every stored line followed by an LF.
   * Empty for a session with no transcript. Written back to disk for
   * `claude --resume` (line-faithful per the class contract above).
   */
  async materialize(sessionId: string): Promise<string> {
    const lines = await this.getLines(sessionId);
    return lines.map((line) => `${line}\n`).join('');
  }
}
