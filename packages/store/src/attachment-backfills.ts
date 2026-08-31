import { createHash } from 'node:crypto';

import { externalizeToolResultImages, externalizeToolResultText } from '@verity/events';
import { type Kysely, sql } from 'kysely';

import type { Database } from './schema.js';

/**
 * One-off back-fill: move any INLINE base64 image attachments on existing
 * `prompt` events into the content-addressed `attachments` table, rewriting each
 * event to reference its images by `id` instead. Events written before blob
 * storage carry `data`; after this they carry `id`, so the client lazily fetches
 * them (only the visible ones) just like newly-sent images. Idempotent — an event
 * already migrated (id, no data) is skipped, so re-running is a no-op. Returns the
 * number of events rewritten.
 *
 * This deliberately rewrites the otherwise append-only log (the only writer that
 * does), via a raw UPDATE; it runs once as migration `0005`.
 */
export async function backfillInlineAttachments(db: Kysely<Database>): Promise<number> {
  const rows = await db
    .selectFrom('events')
    .select(['id', 'payload'])
    .where('type', '=', 'prompt')
    .execute();
  let migrated = 0;
  for (const row of rows) {
    const payload = row.payload;
    if (payload.t !== 'prompt' || !payload.attachments?.length) continue;
    let changed = false;
    for (const a of payload.attachments) {
      if (a.data !== undefined && a.id === undefined) {
        const bytes = Buffer.from(a.data, 'base64');
        const hash = createHash('sha256').update(bytes).digest('hex');
        await db
          .insertInto('attachments')
          .values({ hash, media_type: a.mediaType, bytes })
          .onConflict((oc) => oc.column('hash').doNothing())
          .execute();
        a.id = hash;
        delete a.data;
        changed = true;
      }
    }
    if (changed) {
      // The events.payload column type forbids updates (append-only); this one-off
      // migration is the sole exception, so go through raw SQL to bypass it.
      await sql`update events set payload = ${JSON.stringify(payload)}::jsonb where id = ${row.id}`.execute(
        db,
      );
      migrated++;
    }
  }
  return migrated;
}

/**
 * One-off back-fill (sibling of {@link backfillInlineAttachments}, for #115): move
 * any INLINE base64 images carried on existing `tool_result` events into the
 * content-addressed `attachments` table, rewriting each event so the client fetches
 * them lazily by `id`. Before this, opening a session with tool-returned images
 * (e.g. a `Read` of a PNG, a screenshot) transferred and parsed the whole base64
 * backlog up front even for off-screen rows. Idempotent — an event already rewritten
 * to refs is skipped — so re-running is a no-op. Returns the number of events
 * rewritten. Uses the same append-only-log-bypassing raw UPDATE as its sibling.
 */
export async function backfillToolResultImages(db: Kysely<Database>): Promise<number> {
  const rows = await db
    .selectFrom('events')
    .select(['id', 'payload'])
    .where('type', '=', 'tool_result')
    .execute();
  let migrated = 0;
  for (const row of rows) {
    const payload = row.payload;
    if (payload.t !== 'tool_result') continue;
    const { output, changed } = await externalizeToolResultImages(
      payload.output,
      async (mediaType, base64Data) => {
        const bytes = Buffer.from(base64Data, 'base64');
        const hash = createHash('sha256').update(bytes).digest('hex');
        await db
          .insertInto('attachments')
          .values({ hash, media_type: mediaType, bytes })
          .onConflict((oc) => oc.column('hash').doNothing())
          .execute();
        return hash;
      },
    );
    if (changed) {
      const rewritten = { ...payload, output };
      await sql`update events set payload = ${JSON.stringify(rewritten)}::jsonb where id = ${row.id}`.execute(
        db,
      );
      migrated++;
    }
  }
  return migrated;
}

/**
 * One-off back-fill (sibling of {@link backfillToolResultImages}): move any large
 * INLINE TEXT output on existing `tool_result` events into the content-addressed
 * blob table, rewriting each event to keep only a truncated preview inline plus an
 * `outputRef` to the full body. Before this, opening a session with big tool
 * outputs (a `Read` of a large file, long `Bash`/`Grep` output, a big diff)
 * transferred and parsed the whole text backlog up front. Idempotent — an event
 * already carrying `outputRef` (or whose inline text is below the threshold) is
 * skipped. Returns the number of events rewritten. Uses the same append-only-log-
 * bypassing raw UPDATE as its siblings; runs after the images back-fill (0017) so
 * the stored full body already references images by id.
 */
export async function backfillToolResultText(db: Kysely<Database>): Promise<number> {
  const rows = await db
    .selectFrom('events')
    .select(['id', 'payload'])
    .where('type', '=', 'tool_result')
    .execute();
  let migrated = 0;
  for (const row of rows) {
    const payload = row.payload;
    if (payload.t !== 'tool_result' || payload.outputRef !== undefined) continue;
    const { output, ref } = await externalizeToolResultText(payload.output, async (jsonText) => {
      const bytes = Buffer.from(jsonText, 'utf8');
      const hash = createHash('sha256').update(bytes).digest('hex');
      await db
        .insertInto('attachments')
        .values({ hash, media_type: 'application/json', bytes })
        .onConflict((oc) => oc.column('hash').doNothing())
        .execute();
      return hash;
    });
    if (ref !== undefined) {
      const rewritten = { ...payload, output, outputRef: ref };
      await sql`update events set payload = ${JSON.stringify(rewritten)}::jsonb where id = ${row.id}`.execute(
        db,
      );
      migrated++;
    }
  }
  return migrated;
}
