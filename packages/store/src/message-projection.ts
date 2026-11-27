import { type AgentEvent } from '@verity/events';
import { type Kysely, type Transaction, sql } from 'kysely';
import type { Database } from './schema.js';

type ProjectionDb = Kysely<Database> | Transaction<Database>;
const MESSAGE_PROJECTION_VERSION = 1;
const pendingMessageProjectionByDb = new WeakMap<Kysely<Database>, Promise<void>>();
const pendingMessageBackfillsByDb = new WeakMap<Kysely<Database>, Set<Promise<void>>>();

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
async function projectMessageEvent(
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
  if (event.t === 'prompt' && event.origin !== 'secret-approval') {
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
const PROJECTION_ID_CHUNK = 500;

/** Split `items` into chunks of at most {@link PROJECTION_ID_CHUNK}. */
export function idChunks<T>(items: readonly T[]): T[][] {
  const chunks: T[][] = [];
  for (let at = 0; at < items.length; at += PROJECTION_ID_CHUNK) {
    chunks.push(items.slice(at, at + PROJECTION_ID_CHUNK));
  }
  return chunks;
}

export interface MessageSearchInput {
  query: string;
  sessionId?: string;
  projectId?: string;
  limit?: number;
  cursor?: { rank: number; createdAt: number; id: number };
}

export interface MessageSearchResult {
  id: number;
  sessionId: string;
  sessionName: string | null;
  projectId: string | null;
  projectName: string | null;
  role: 'user' | 'agent';
  kind: 'prompt' | 'text' | 'notice';
  text: string;
  firstEventSeq: number;
  createdAt: number;
  rank: number;
}
export class MessageProjectionStore {
  private messageBackfillTail: Promise<void> = Promise.resolve();

  private messageBackfillRunning = false;

  private messageBackfillRequested = false;

  private readonly messageLiveProjectionTails = new Map<string, Promise<void>>();
  constructor(
    private readonly currentDb: () => Kysely<Database>,
    private readonly listSessions: () => Promise<readonly { sessionId: string }[]>,
    private readonly requestProjection: () => void,
  ) {}

  private get db(): Kysely<Database> {
    return this.currentDb();
  }

  enqueuePersistedMessageEvent(
    sessionId: string,
    seq: number,
    createdAt: Date,
    event: AgentEvent,
  ): void {
    const predecessor = this.messageLiveProjectionTails.get(sessionId) ?? Promise.resolve();
    const current = predecessor
      .catch(() => undefined)
      .then(async () => {
        const projected = await this.db.transaction().execute(async (tx) => {
          await sql`select pg_advisory_xact_lock(hashtext(${'messages:' + sessionId}))`.execute(tx);
          const state = await tx
            .selectFrom('message_projection_state')
            .select(['last_event_seq', 'projection_version'])
            .where('session_id', '=', sessionId)
            .executeTakeFirst();
          if (state !== undefined && state.projection_version !== MESSAGE_PROJECTION_VERSION) {
            return false;
          }
          const previous = await tx
            .selectFrom('events')
            .select((eb) => eb.fn.max('id').as('seq'))
            .where('session_id', '=', sessionId)
            .where('id', '<', seq)
            .executeTakeFirst();
          if (Number(state?.last_event_seq ?? 0) !== Number(previous?.seq ?? 0)) return false;
          await projectMessageEvent(tx, sessionId, seq, createdAt, event);
          await tx
            .insertInto('message_projection_state')
            .values({
              session_id: sessionId,
              last_event_seq: seq,
              projection_version: MESSAGE_PROJECTION_VERSION,
            })
            .onConflict((oc) =>
              oc.column('session_id').doUpdateSet({
                last_event_seq: seq,
                projection_version: MESSAGE_PROJECTION_VERSION,
              }),
            )
            .execute();
          return true;
        });
        return projected;
      });
    const safeCurrent = current.catch(() => false);
    const tail = safeCurrent.then(() => undefined);
    this.messageLiveProjectionTails.set(sessionId, tail);
    const pending = Promise.all([
      pendingMessageProjectionByDb.get(this.db) ?? Promise.resolve(),
      tail,
    ]).then(() => undefined);
    pendingMessageProjectionByDb.set(this.db, pending);
    void safeCurrent.then((projected) => {
      if (!projected) this.requestProjection();
    });
    void tail.finally(() => {
      if (this.messageLiveProjectionTails.get(sessionId) === tail) {
        this.messageLiveProjectionTails.delete(sessionId);
      }
    });
  }

  /** Bring the rebuildable message view up to date in resumable event batches. */
  private async backfillMessageProjectionUnlocked(): Promise<void> {
    const sessions = await this.listSessions();
    for (const session of sessions) {
      for (;;) {
        const processed = await this.db.transaction().execute(async (tx) => {
          await sql`select pg_advisory_xact_lock(hashtext(${'messages:' + session.sessionId}))`.execute(
            tx,
          );
          let state = await tx
            .selectFrom('message_projection_state')
            .select(['last_event_seq', 'projection_version'])
            .where('session_id', '=', session.sessionId)
            .executeTakeFirst();
          if (state !== undefined && state.projection_version !== MESSAGE_PROJECTION_VERSION) {
            await tx.deleteFrom('messages').where('session_id', '=', session.sessionId).execute();
            await tx
              .deleteFrom('message_projection_state')
              .where('session_id', '=', session.sessionId)
              .execute();
            state = undefined;
          }
          const rows = await tx
            .selectFrom('events')
            .select(['id', 'payload', 'created_at'])
            .where('session_id', '=', session.sessionId)
            .where('id', '>', Number(state?.last_event_seq ?? 0))
            .orderBy('id', 'asc')
            .limit(500)
            .execute();
          for (const row of rows) {
            await projectMessageEvent(
              tx,
              session.sessionId,
              Number(row.id),
              row.created_at,
              row.payload,
            );
          }
          const last = rows.at(-1);
          if (last !== undefined) {
            await tx
              .insertInto('message_projection_state')
              .values({
                session_id: session.sessionId,
                last_event_seq: Number(last.id),
                projection_version: MESSAGE_PROJECTION_VERSION,
              })
              .onConflict((oc) =>
                oc.column('session_id').doUpdateSet({
                  last_event_seq: Number(last.id),
                  projection_version: MESSAGE_PROJECTION_VERSION,
                }),
              )
              .execute();
          }
          return rows.length;
        });
        if (processed === 0) break;
      }
    }
  }

  scheduleMessageProjection(): void {
    if (this.messageBackfillRunning) {
      this.messageBackfillRequested = true;
      return;
    }
    this.messageBackfillRunning = true;
    const current = this.messageBackfillTail
      .catch(() => undefined)
      .then(async () => {
        await waitForPendingMessageProjections(this.db);
        do {
          this.messageBackfillRequested = false;
          await this.backfillMessageProjectionUnlocked();
        } while (this.messageBackfillRequested);
      })
      .finally(() => {
        this.messageBackfillRunning = false;
      });
    this.messageBackfillTail = current;
    let pendingBackfills = pendingMessageBackfillsByDb.get(this.db);
    if (pendingBackfills === undefined) {
      pendingBackfills = new Set();
      pendingMessageBackfillsByDb.set(this.db, pendingBackfills);
    }
    pendingBackfills.add(current);
    void current.then(
      () => pendingBackfills.delete(current),
      () => pendingBackfills.delete(current),
    );
    void current.catch(() => undefined);
  }

  /** Wait until both ordered live projection and any recovery/search backfill are
   * idle. This is a lifecycle barrier, not an error-reporting seam: live failures
   * are intentionally contained so canonical event persistence stays successful.
   * The barrier waits for all resulting recovery attempts, but does not assert that
   * a deliberately unavailable projection became healthy. */
  async waitForMessageProjectionIdle(): Promise<void> {
    for (;;) {
      await waitForMessageProjectionWork(this.db);
      if (this.messageLiveProjectionTails.size === 0) return;
      // A settled tail unregisters from the map in a `finally` that is one
      // microtask behind the queue barrier above; give it that turn instead of
      // spinning on the map.
      await Promise.resolve();
    }
  }

  async searchMessages(input: MessageSearchInput): Promise<MessageSearchResult[]> {
    // Never let replay race the ordered live projector for the same events. A
    // short live tail lands first; if it is still busy after the latency budget,
    // return the currently indexed view and let that tail finish asynchronously.
    const liveCaughtUp = await Promise.race([
      waitForPendingMessageProjections(this.db).then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 50)),
    ]);
    if (liveCaughtUp) {
      this.requestProjection();
      await Promise.race([
        this.messageBackfillTail.catch(() => undefined),
        new Promise<void>((resolve) => setTimeout(resolve, 50)),
      ]);
    }
    const query = input.query.trim();
    if (query.length === 0) return [];
    const tsQuery = sql`websearch_to_tsquery('simple', ${query})`;
    const rank = sql<number>`ts_rank_cd(to_tsvector('simple', m.text), ${tsQuery})`;
    let select = this.db
      .selectFrom('messages as m')
      .innerJoin('sessions as s', 's.session_id', 'm.session_id')
      .leftJoin('projects as p', 'p.id', 's.project_id')
      .select([
        'm.id',
        'm.session_id',
        's.name as session_name',
        's.project_id',
        'm.role',
        'm.kind',
        'm.first_event_seq',
        'm.created_at',
        rank.as('search_rank'),
        sql<string>`ts_headline(
          'simple', m.text, ${tsQuery},
          'MaxWords=35, MinWords=12, ShortWord=2, MaxFragments=2, StartSel=⟦, StopSel=⟧'
        )`.as('snippet'),
        sql<string | null>`case when p.id is null then null else p.owner || '/' || p.repo end`.as(
          'project_name',
        ),
      ])
      .where('m.finalized', '=', true)
      .where(sql<boolean>`to_tsvector('simple', m.text) @@ ${tsQuery}`)
      // The Wiki maintenance run quotes untrusted transcripts and appears nowhere.
      .where(
        sql<boolean>`not exists (select 1 from wiki_maintenance w where w.session_id = m.session_id)`,
      );
    if (input.sessionId !== undefined) select = select.where('m.session_id', '=', input.sessionId);
    if (input.projectId !== undefined) select = select.where('s.project_id', '=', input.projectId);
    if (input.cursor !== undefined) {
      const cursorDate = new Date(input.cursor.createdAt);
      select = select.where(
        sql<boolean>`(${rank} < ${input.cursor.rank}) or
          (${rank} = ${input.cursor.rank} and m.created_at < ${cursorDate}) or
          (${rank} = ${input.cursor.rank} and m.created_at = ${cursorDate} and m.id < ${input.cursor.id})`,
      );
    }
    const rows = await select
      .orderBy(rank, 'desc')
      .orderBy('m.created_at', 'desc')
      .orderBy('m.id', 'desc')
      .limit(Math.min(input.limit ?? 30, 100))
      .execute();
    return rows.map((row) => ({
      id: Number(row.id),
      sessionId: row.session_id,
      sessionName: row.session_name,
      projectId: row.project_id,
      projectName: row.project_name,
      role: row.role,
      kind: row.kind,
      text: row.snippet.replace(/[⟦⟧]/g, ''),
      firstEventSeq: Number(row.first_event_seq),
      createdAt: row.created_at.getTime(),
      rank: row.search_rank,
    }));
  }
}
