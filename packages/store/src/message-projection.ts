import { resolve } from 'node:path';
import { type AgentEvent } from '@verity/events';
import { type Kysely, type Transaction } from 'kysely';
import type { Database } from './schema.js';

type ProjectionDb = Kysely<Database> | Transaction<Database>;
export const MESSAGE_PROJECTION_VERSION = 1;
export const pendingMessageProjectionByDb = new WeakMap<Kysely<Database>, Promise<void>>();
export const pendingMessageBackfillsByDb = new WeakMap<Kysely<Database>, Set<Promise<void>>>();

export async function waitForPendingMessageProjections(db: Kysely<Database>): Promise<void> {
  await (pendingMessageProjectionByDb.get(db) ?? Promise.resolve());
}

/**
 * Wait until no projection work is in flight against `db` — the ordered live
 * chain AND every recovery/search backfill.
 *
 * {@link waitForPendingMessageProjections} covers only the first. That is enough
 * to observe a projected event, but not to know the database is quiet: a live
 * projection that declines its slot enqueues a backfill *as it resolves*, and
 * {@link EventStore.ingestRunnerFrame} schedules one unawaited by design. Those
 * run on their own connection, so a caller that needs exclusive access (a test
 * harness truncating between tests) must wait for them too — otherwise its
 * TRUNCATE takes AccessExclusiveLock on the tables the backfill is midway
 * through reading and the two deadlock (40P01).
 *
 * The queues are re-read across a barrier because draining one can enqueue into
 * the other; the loop settles once a full pass adds nothing.
 */
export async function waitForMessageProjectionWork(db: Kysely<Database>): Promise<void> {
  for (;;) {
    const live = pendingMessageProjectionByDb.get(db) ?? Promise.resolve();
    const backfills = [...(pendingMessageBackfillsByDb.get(db) ?? [])];
    await Promise.all([live, ...backfills.map((backfill) => backfill.catch(() => undefined))]);
    // Let completion handlers enqueue a recovery backfill before checking that
    // the two queues stayed unchanged across the barrier.
    await Promise.resolve();
    if (
      (pendingMessageProjectionByDb.get(db) ?? live) === live &&
      (pendingMessageBackfillsByDb.get(db)?.size ?? 0) === 0
    ) {
      return;
    }
  }
}

async function finalizeOpenMessage(db: ProjectionDb, sessionId: string): Promise<void> {
  await db
    .updateTable('messages')
    .set({ finalized: true })
    .where('session_id', '=', sessionId)
    .where('finalized', '=', false)
    .execute();
}

/** Fold one persisted canonical event into the rebuildable visible-message view. */
export async function projectMessageEvent(
  db: ProjectionDb,
  sessionId: string,
  seq: number,
  createdAt: Date,
  event: AgentEvent,
): Promise<void> {
  if (event.t === 'task' || event.t === 'session') return;

  if (event.t === 'text' && event.parentToolId === undefined) {
    const open = await db
      .selectFrom('messages')
      .select(['id', 'text'])
      .where('session_id', '=', sessionId)
      .where('finalized', '=', false)
      .where('role', '=', 'agent')
      .orderBy('id', 'desc')
      .executeTakeFirst();
    if (open !== undefined) {
      await db
        .updateTable('messages')
        .set({ text: open.text + event.delta, last_event_seq: seq })
        .where('id', '=', open.id)
        .execute();
    } else {
      await db
        .insertInto('messages')
        .values({
          session_id: sessionId,
          role: 'agent',
          kind: 'text',
          text: event.delta,
          first_event_seq: seq,
          last_event_seq: seq,
          created_at: createdAt,
        })
        .onConflict((oc) => oc.columns(['session_id', 'first_event_seq']).doNothing())
        .execute();
    }
    return;
  }

  await finalizeOpenMessage(db, sessionId);
  if (event.t === 'prompt') {
    await db
      .insertInto('messages')
      .values({
        session_id: sessionId,
        role: 'user',
        kind: 'prompt',
        text: event.peer?.message ?? event.text,
        first_event_seq: seq,
        last_event_seq: seq,
        finalized: true,
        created_at: createdAt,
      })
      .onConflict((oc) => oc.columns(['session_id', 'first_event_seq']).doNothing())
      .execute();
  } else if (event.t === 'notice') {
    await db
      .insertInto('messages')
      .values({
        session_id: sessionId,
        role: event.role === 'operator' ? 'user' : 'agent',
        kind: 'notice',
        text: event.text,
        first_event_seq: seq,
        last_event_seq: seq,
        finalized: true,
        created_at: createdAt,
      })
      .onConflict((oc) => oc.columns(['session_id', 'first_event_seq']).doNothing())
      .execute();
  }
}

/**
 * How many session ids one `in (…)` list carries — see
 * `EventStore.listSessionProjectionFacts`. Postgres refuses a statement
 * with more than 65535 bind parameters outright, and `GET /sessions` passes
 * EVERY session of a deployment at once, so an unchunked list turns a big
 * install into a route that throws rather than one that is slow. Well under the
 * ceiling on purpose: the extra round trips are cheap next to the per-session
 * reads this replaced, and the queries spend parameters on the type filter too.
 */
export const PROJECTION_ID_CHUNK = 500;

/** Split `items` into chunks of at most {@link PROJECTION_ID_CHUNK}. */
export function idChunks<T>(items: readonly T[]): T[][] {
  const chunks: T[][] = [];
  for (let at = 0; at < items.length; at += PROJECTION_ID_CHUNK) {
    chunks.push(items.slice(at, at + PROJECTION_ID_CHUNK));
  }
  return chunks;
}
