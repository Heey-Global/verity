import {
  SESSION_PROJECTION_EVENT_TYPES,
  parseAgentEvent,
  type Usage,
  type UsageTotals,
} from '@verity/events';
import { sql, type Kysely, type Transaction } from 'kysely';
import { sequencedEvent, type SequencedEvent } from './event-history.js';
import { idChunks } from './message-projection.js';
import type { Database } from './schema.js';
import { readSessionProjectionActivity } from './session-projection-activity.js';

/**
 * One token field of a `result` payload, summed across a group — see
 * {@link SessionProjectionStore.readUsageTotals}.
 *
 * The field name is emitted as a LITERAL rather than a bind parameter. `->>`
 * takes `text` on the right, and a parameter arrives untyped, so Postgres
 * resolves the operator against `jsonb ->> integer` as readily as the text form
 * and answers with an array-index error on an object. The names come from
 * {@link Usage}'s own keys, so there is no value here to smuggle anything in.
 */
function usageSum(field: keyof Usage) {
  return sql<string>`sum(coalesce((payload -> 'usage' ->> ${sql.lit(field)})::bigint, 0))`;
}

/** What a session with no `result` events has spent. */
function emptyUsageTotals(): UsageTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    turns: 0,
  };
}

/** A session log's constant-size marker, kept current by the `session_event_stats` trigger. */
export interface SessionEventStats {
  /** Nonempty agent-text events; used for unread state. */
  eventCount: number;
  lastEventSeq: number;
  lastActivityAt: number | null;
  /** Changes on every log mutation, including deletions below the latest seq. */
  revision: string;
}

export interface SessionProjectionFacts {
  /** Nonempty agent-text events; the overview unread counter. */
  eventCount: number;
  /** Highest event seq visible in the snapshot; bounds a later fallback read. */
  lastEventSeq: number;
  /** The log's `session_event_stats` revision in the same snapshot, which every
   *  insert, update and delete of one of its events advances. Together with
   *  {@link lastEventSeq} it names this exact log state, so a derivation of it can
   *  be reused until either moves. Empty for a session without a log. */
  revision: string;
  /** `created_at` of the newest event in epoch ms; null for an empty log. */
  lastActivityAt: number | null;
  /** Newest user prompt or top-level agent text; excludes technical events. */
  lastMessageAt: number | null;
  /** Ascending by seq, filtered to {@link SESSION_PROJECTION_EVENT_TYPES} — and
   *  bounded to the NEWEST `tailLimit` of them. Whether that is far enough back
   *  is a fact about the derivation the caller is running, not about this read,
   *  so the caller decides, using {@link eventsTruncated} to find out whether
   *  there is anything older to miss. */
  events: SequencedEvent[];
  /** Whether {@link events} hit its limit, i.e. older projected events exist. A
   *  tail short of the limit IS the whole slice, and nothing asked about it can
   *  be wrong. */
  eventsTruncated: boolean;
  /** The newest `rate_limit` event per provider/window/scope over the WHOLE log,
   *  in no particular order — the quota states a session is currently under.
   *
   *  Separate from {@link events} because a quota state is the last word until
   *  the provider sends another one: one observed hours ago, thousands of events
   *  back, is still the truth about the session, and a tail cannot see it. Same
   *  shape of problem as {@link SessionProjectionStore.sessionHasTaskLifecycleEvent}. */
  rateLimitEvents: SequencedEvent[];
  /** Token totals over every `result` event in the log — summed in SQL, not
   *  folded out of {@link events}, which is why the slice is free to be a tail. */
  usage: UsageTotals;
}

export class SessionProjectionStore {
  constructor(private readonly getDb: () => Kysely<Database>) {}

  /**
   * Read what the overview projections need from a set of session logs, WITHOUT
   * hydrating those logs.
   *
   * The session list, the session detail and the project detail each derive five
   * things per session: the status badge, the cumulative usage, the latest
   * rate-limit states, `eventCount` (the unread badge compares it against
   * `lastSeenEventCount`) and `lastActivityAt`. Deriving them used to mean
   * `getEventsAfter(id, 0)` per
   * session on a route the app polls every two seconds: every row of every log
   * off the heap, its jsonb payload parsed and Zod-validated, to answer a badge
   * and two numbers — enough of it to saturate the connection pool and stall
   * every other request behind it.
   *
   * The first three read only {@link SESSION_PROJECTION_EVENT_TYPES}, which the
   * denormalized `events.type` column can filter on directly (index
   * `events_session_id_type_id_idx`). What that removes is the payload: the heap
   * fetches, the JSON parse and the validation, which is where essentially all of
   * the cost was.
   *
   * WHAT THE SLICE NO LONGER IS: the whole log's worth of projected events. Even
   * narrowed to eight discriminants it still grew with history — ~1.6 KB per
   * event on a seeded log — on a route polled every ~2 s per device, and V8 does
   * not hand a peak like that back to the OS, so the churn settles in as resident
   * memory. Each of the three now reads only what it can prove it needs:
   *
   * - usage sums in SQL over the whole log ({@link readUsageTotals}), so it never
   *   needed the slice in the first place;
   * - the rate-limit states come from a per-key `distinct on`
   *   ({@link readLatestRateLimits}), because the newest quota state for a window
   *   can be arbitrarily far back and a tail would silently drop it;
   * - what is left — the status badge and the permission question — reads a
   *   `tailLimit`-event TAIL, and both stop at the most recent non-steered
   *   `prompt`, so a tail reaching past one answers identically to the full
   *   slice. That is the caller's proof to make (`projectionTailIsSelfContained`
   *   in the server), which is why `eventsTruncated` comes back with it.
   *
   * Exact counters and the newest event timestamp come from the trigger-maintained
   * `session_event_stats` row. Every event mutation updates it transactionally,
   * including writes from older server generations and provisional fence removal.
   * The counters therefore stay constant-size reads as text history grows.
   *
   * BATCHED ON PURPOSE: `GET /sessions` needs every session at once, so this
   * batches tails, rate-limit states, sums, counters and message recency for
   * each chunk from `idChunks` to stay within the bind-parameter ceiling. Sessions with an empty log are present in the map with
   * `eventCount: 0` — absent from the map means the session id was not asked for.
   *
   * `tailLimit` is how many projected events the caller wants at the end of each
   * log. It is a parameter and not a constant here because "far enough back" is a
   * property of what the caller derives, and this read cannot check it — see
   * {@link listRecentSessionProjectionEvents}, which takes it for the same reason.
   */
  async listSessionProjectionFacts(
    sessionIds: readonly string[],
    tailLimit: number,
  ): Promise<Map<string, SessionProjectionFacts>> {
    const facts = new Map<string, SessionProjectionFacts>(
      sessionIds.map((sessionId) => [
        sessionId,
        {
          eventCount: 0,
          lastEventSeq: 0,
          revision: '',
          lastActivityAt: null,
          lastMessageAt: null,
          events: [],
          eventsTruncated: false,
          rateLimitEvents: [],
          usage: emptyUsageTotals(),
        },
      ]),
    );
    if (facts.size === 0) return facts;
    const chunks = idChunks([...facts.keys()]);

    // Every part of this must describe the SAME log prefix. Under Postgres'
    // default READ COMMITTED isolation each statement gets a new snapshot, so a
    // result or rate-limit event appended between them could appear in only one
    // half and briefly produce a status/usage combination that never existed.
    // REPEATABLE READ fixes the snapshot for the complete batched read, including
    // every chunk on installs large enough to cross the bind-parameter ceiling.
    //
    // That matters more now than it did when the slice answered three of these
    // questions by itself: the tail, the quota states and the token sums are
    // three separate reads of one log, and nothing else would keep "this turn
    // finished", "this is what it cost" and "this is the quota it ran under"
    // describing the same moment.
    await this.getDb()
      .transaction()
      .setIsolationLevel('repeatable read')
      .execute(async (tx) => {
        await this.readProjectionTails(chunks, facts, tailLimit, tx);
        await this.readLatestRateLimits(chunks, facts, tx);
        await this.readUsageTotals(chunks, facts, tx);

        // Triggers keep exact counters in the same transaction as every event
        // mutation, so this read shares the tail/usage snapshot without scanning
        // one index entry per streamed delta on every overview poll.
        for (const ids of chunks) {
          await readSessionProjectionActivity(tx, ids, facts);
        }
      });
    return facts;
  }

  /**
   * The constant-size log marker of each listed session that has a log — the
   * batched counterpart of `EventStore.getSessionEventStats`. One primary-key
   * read per chunk, so a caller can tell which logs moved before deciding which
   * of them to read at all.
   */
  async listSessionEventStats(
    sessionIds: readonly string[],
  ): Promise<Map<string, SessionEventStats>> {
    const stats = new Map<string, SessionEventStats>();
    for (const ids of idChunks([...new Set(sessionIds)])) {
      const rows = await this.getDb()
        .selectFrom('session_event_stats')
        .selectAll()
        .where('session_id', 'in', ids)
        .execute();
      for (const row of rows)
        stats.set(row.session_id, {
          eventCount: Number(row.event_count),
          lastEventSeq: Number(row.last_event_seq),
          lastActivityAt: row.last_activity_at?.getTime() ?? null,
          revision: String(row.revision),
        });
    }
    return stats;
  }

  /**
   * The newest `limit` projected events of each listed session, ascending by
   * `seq` — the batched counterpart of {@link listRecentSessionProjectionEvents},
   * and the reason {@link listSessionProjectionFacts} no longer grows with
   * history.
   *
   * One statement per chunk, not one per session: a `cross join lateral` runs the
   * same descending index range per id, so Postgres stops at `limit` rows for
   * EACH session instead of fetching every projected row and discarding all but
   * the end of it. A window function over the whole set would be the same query
   * to read and a full scan to run.
   *
   * The ids ride in as ONE array parameter, so this statement binds two
   * parameters whatever the chunk size. The chunk loop stays anyway: the other
   * reads in this transaction still bind one parameter per id, and a tail read
   * that silently diverged from them on chunk boundaries would be a trap for
   * whoever changes this next.
   *
   * Each session's rows arrive newest-first, because that is the only way a
   * `limit` lands on the end of a log; they are sorted back into `seq` order
   * here, which is what every derivation over them assumes.
   */
  private async readProjectionTails(
    chunks: readonly (readonly string[])[],
    into: ReadonlyMap<string, { events: SequencedEvent[]; eventsTruncated: boolean }>,
    limit: number,
    db: Transaction<Database>,
  ): Promise<void> {
    for (const ids of chunks) {
      const rows = await sql<{
        session_id: string;
        id: string | number;
        payload: unknown;
        created_at: Date;
      }>`
        select s.session_id, tail.id, tail.payload, tail.created_at
        from unnest(${[...ids]}::text[]) as s(session_id)
        cross join lateral (
          select e.id, e.payload, e.created_at
          from events e
          where e.session_id = s.session_id
            and e.type = any(${[...SESSION_PROJECTION_EVENT_TYPES]}::text[])
          order by e.id desc
          limit ${limit}
        ) as tail
      `.execute(db);
      for (const row of rows.rows) {
        const entry = into.get(row.session_id);
        if (entry === undefined) continue;
        entry.events.push(sequencedEvent(row.session_id, row.id, row.payload, row.created_at));
      }
      for (const id of ids) {
        const entry = into.get(id);
        if (entry === undefined) continue;
        entry.events.sort((a, b) => a.seq - b.seq);
        // At the limit means the scan stopped on budget rather than on rows, so
        // older projected events exist and this tail is not the whole slice.
        entry.eventsTruncated = entry.events.length === limit;
      }
    }
  }

  /**
   * The newest `rate_limit` event per provider/window/scope of each listed
   * session, over the WHOLE log.
   *
   * A quota state stands until the provider replaces it, so the one that matters
   * can sit thousands of events back — a tail that missed it would not report a
   * degraded state, it would report none, which reads as "no limit in force".
   * `distinct on` answers it per key in one statement per chunk, walking each
   * session's `rate_limit` rows newest-first and keeping the first of each key.
   *
   * The key expressions repeat `latestRateLimits`' defaults (`Claude`,
   * `all_models`) rather than grouping on the raw fields. An older event that
   * omits `providerLabel` and a newer one that spells it out are ONE quota state
   * to the caller, and grouping them apart here would hand it two — and let the
   * older of them survive as the newest of its group.
   *
   * Returned unsorted: the caller keys them itself and sorts the result by
   * severity, and any order this imposed would be discarded there.
   */
  private async readLatestRateLimits(
    chunks: readonly (readonly string[])[],
    into: ReadonlyMap<string, { rateLimitEvents: SequencedEvent[] }>,
    db: Transaction<Database>,
  ): Promise<void> {
    const providerLabel = sql`coalesce(e.payload ->> 'providerLabel', 'Claude')`;
    const window = sql`coalesce(e.payload ->> 'window', '')`;
    const scope = sql`coalesce(e.payload ->> 'scope', 'all_models')`;
    for (const ids of chunks) {
      const rows = await sql<{
        session_id: string;
        id: string | number;
        payload: unknown;
        created_at: Date;
      }>`
        select distinct on (e.session_id, ${providerLabel}, ${window}, ${scope})
          e.session_id, e.id, e.payload, e.created_at
        from events e
        where e.session_id = any(${[...ids]}::text[])
          and e.type = 'rate_limit'
        order by e.session_id, ${providerLabel}, ${window}, ${scope}, e.id desc
      `.execute(db);
      for (const row of rows.rows) {
        const entry = into.get(row.session_id);
        if (entry === undefined) continue;
        entry.rateLimitEvents.push(
          sequencedEvent(row.session_id, row.id, row.payload, row.created_at),
        );
      }
    }
  }

  /**
   * Cumulative token usage per session, summed in the DATABASE — the totals half
   * of {@link listSessionProjectionFacts}.
   *
   * `aggregateUsage` answers the same question by folding every `result` event of
   * every listed session in the server process, which is why the overview has to
   * hydrate whole logs it otherwise only reads the end of. It is the one consumer
   * of the slice whose answer genuinely depends on the entire log, so it has to
   * move before the slice can be bounded — see the note on `aggregateUsage`,
   * which named a store-side SUM as the eventual path.
   *
   * Sums are taken as `bigint`: a busy session's `cacheReadTokens` runs to
   * billions, and `int` would overflow long before the total stops being
   * interesting. They come back as strings and are narrowed here, which is exact
   * up to 2^53 — past that the process could not hold the number anyway.
   *
   * A session with no `result` events produces no row at all, which is why the
   * caller seeds a zeroed total rather than letting an absent one read as missing.
   *
   * `events_session_id_type_id_idx` leads with `(session_id, type)`, so the scan
   * reaches only the `result` rows — one per completed turn — rather than every
   * event of every listed session. The payload still comes from the heap, which
   * is the cost this read pays and the reason it sums four fields in one pass.
   *
   * Takes the transaction rather than defaulting to {@link getDb}: these
   * sums are only comparable to the slice and the counters when all three read
   * the same snapshot, so there is no correct way to call this outside one.
   */
  private async readUsageTotals(
    chunks: readonly (readonly string[])[],
    into: ReadonlyMap<string, { usage: UsageTotals }>,
    db: Transaction<Database>,
  ): Promise<void> {
    for (const ids of chunks) {
      const rows = await db
        .selectFrom('events')
        .select((eb) => [
          'session_id',
          // Default each missing field to zero before summing across the log.
          // Results are validated on write. The bounded tail validates only
          // the payloads it reads, so older rows can reach this sum directly.
          //
          // `turns` counts the `result` rows unconditionally, which is what
          // `aggregateUsage` does with the same log: it adds a turn for every
          // `result` event it sees, without consulting the payload.
          usageSum('inputTokens').as('input_tokens'),
          usageSum('outputTokens').as('output_tokens'),
          usageSum('cacheReadTokens').as('cache_read_tokens'),
          usageSum('cacheCreationTokens').as('cache_creation_tokens'),
          eb.fn.countAll<string | number | bigint>().as('turns'),
        ])
        .where('session_id', 'in', ids)
        .where('type', '=', 'result')
        .groupBy('session_id')
        .execute();
      for (const row of rows) {
        const entry = into.get(row.session_id);
        if (entry === undefined) continue;
        entry.usage = {
          inputTokens: Number(row.input_tokens),
          outputTokens: Number(row.output_tokens),
          cacheReadTokens: Number(row.cache_read_tokens),
          cacheCreationTokens: Number(row.cache_creation_tokens),
          turns: Number(row.turns),
        };
      }
    }
  }

  /**
   * The projection slice ALONE, for callers that need the events and not the
   * counters.
   *
   * `GET /sessions/:id/activity` is the whole reason this exists. It polls every
   * 1.5 s per open session, and it reads the log for exactly one question: is a
   * background task still open behind a turn that already reported its result. It
   * never returns counters, usage, or quota states, so fetching the other
   * projection facts would add work whose result this caller discards.
   *
   * A separate method rather than a flag on the other one, because the flag would
   * have to leave `eventCount: 0` behind — and a zero count is not an absence,
   * it is what {@link deriveSessionStatusFromProjection} reads as `idle`.
   */
  async listSessionProjectionEvents(
    sessionIds: readonly string[],
    throughSeq?: number,
  ): Promise<Map<string, SequencedEvent[]>> {
    const slices = new Map<string, SequencedEvent[]>(
      sessionIds.map((sessionId) => [sessionId, []]),
    );
    if (slices.size === 0) return slices;
    await this.readProjectionSlices(idChunks([...slices.keys()]), slices, this.getDb(), throughSeq);
    return slices;
  }

  /** Batched fallback with one connection and at most one hydrated history plus a page.
   * Keyset pages bound decoding bursts without a connection checkout per session. */
  async visitSessionProjectionEvents(
    boundaries: ReadonlyMap<string, number>,
    visit: (sessionId: string, events: SequencedEvent[]) => Promise<void>,
  ): Promise<void> {
    if (boundaries.size === 0) return;
    const input = JSON.stringify([...boundaries].map(([session_id, seq]) => ({ session_id, seq })));
    await this.getDb()
      .connection()
      .execute(async (db) => {
        let afterSession = '';
        let afterSeq = 0;
        let currentId: string | undefined;
        let current: SequencedEvent[] = [];
        for (;;) {
          const page = await sql<{
            session_id: string;
            id: string | number;
            payload: unknown;
            created_at: Date;
          }>`
          select e.session_id, e.id, e.payload, e.created_at
          from jsonb_to_recordset(${input}::jsonb) as boundary(session_id text, seq bigint)
          join events e on e.session_id = boundary.session_id and e.id <= boundary.seq
          where e.type = any(${[...SESSION_PROJECTION_EVENT_TYPES]}::text[])
            and (e.session_id, e.id) > (${afterSession}, ${afterSeq}::bigint)
          order by e.session_id, e.id limit 500
        `.execute(db);
          for (const row of page.rows) {
            if (currentId !== undefined && currentId !== row.session_id) {
              await visit(currentId, current);
              current = [];
            }
            currentId = row.session_id;
            current.push(sequencedEvent(row.session_id, row.id, row.payload, row.created_at));
            afterSession = row.session_id;
            afterSeq = Number(row.id);
          }
          if (page.rows.length < 500) break;
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
        if (currentId !== undefined) await visit(currentId, current);
      });
  }

  /**
   * The TAIL of one session's projection slice — its newest `limit` events, still
   * ascending by `seq`.
   *
   * {@link listSessionProjectionEvents} is linear in log length, and the activity
   * poll that calls it runs every 1.5 s for every idle session. Measured against a
   * seeded log, that slice costs ~1.6 KB per event: a session with 800 prompts
   * spends ~50 MB a minute being asked a question whose answer is at the end of
   * its log. Nothing retains it, so this is churn rather than a leak — but V8 does
   * not return the peak to the OS, so the process wears it for good.
   *
   * WHY A TAIL IS ENOUGH is a fact about the status derivation, not about this
   * query, so the caller checks it: see `projectionTailIsSelfContained`. In short,
   * both passes of `deriveSessionStatusFromProjection` stop at the most recent
   * non-steered `prompt`, so a tail reaching back past one answers identically to
   * the whole slice. A tail that does NOT reach one proves nothing, and the caller
   * falls back to the full read.
   *
   * Ordering note: the LIMIT has to apply to a DESCENDING scan or it would return
   * the OLDEST `limit` events — the same cost, and the wrong half of the log. The
   * rows are reversed here so callers still see ascending `seq`, which is what
   * both passes of the derivation assume.
   */
  async listRecentSessionProjectionEvents(
    sessionId: string,
    limit: number,
  ): Promise<SequencedEvent[]> {
    const rows = await this.getDb()
      .selectFrom('events')
      .select(['id', 'payload', 'created_at'])
      .where('session_id', '=', sessionId)
      .where('type', 'in', [...SESSION_PROJECTION_EVENT_TYPES])
      .orderBy('id', 'desc')
      .limit(limit)
      .execute();
    const events: SequencedEvent[] = [];
    for (const row of rows.reverse()) {
      const parsed = parseAgentEvent(row.payload);
      // Same contract as the batched slice read below: a payload that does not
      // parse is a corrupted log, not a row to skip past.
      if (!parsed.success) {
        throw new Error(`corrupt event payload in session ${sessionId}: ${parsed.error.message}`);
      }
      events.push({ seq: Number(row.id), ts: row.created_at.getTime(), event: parsed.data });
    }
    return events;
  }

  /** Task updates must not hide the completion that releases a repair claim. */
  async latestSessionTurnControlEvent(
    sessionId: string,
    afterSeq: number,
  ): Promise<SequencedEvent | undefined> {
    const row = await this.getDb()
      .selectFrom('events')
      .select(['id', 'payload', 'created_at'])
      .where('session_id', '=', sessionId)
      .where('id', '>', afterSeq)
      .where('type', 'in', ['status', 'prompt', 'interrupted'])
      .orderBy('id', 'desc')
      .limit(1)
      .executeTakeFirst();
    if (!row) return undefined;
    const parsed = parseAgentEvent(row.payload);
    if (!parsed.success)
      throw new Error(`corrupt event payload in session ${sessionId}: ${parsed.error.message}`);
    return { seq: Number(row.id), ts: row.created_at.getTime(), event: parsed.data };
  }

  /**
   * Whether this session's log holds a `task` event ANYWHERE.
   *
   * The companion to {@link listRecentSessionProjectionEvents}, and the one
   * question a tail cannot answer for itself. The activity poll gates its
   * log-derived busy state on a task lifecycle existing at all — over the whole
   * log, not the current turn — so a tail that reaches back far enough for the
   * status derivation may still be short of this. Asking directly costs one
   * lookup in `events_session_id_type_id_idx` and fetches no payload, which is
   * the entire reason the tail is worth reading in the first place.
   *
   * `limit(1)` is the point: this is an existence question, and counting the
   * matching rows instead would restore exactly the full-log scan being avoided.
   */
  async sessionHasTaskLifecycleEvent(sessionId: string): Promise<boolean> {
    const row = await this.getDb()
      .selectFrom('events')
      .select('id')
      .where('session_id', '=', sessionId)
      .where('type', '=', 'task')
      .limit(1)
      .executeTakeFirst();
    return row !== undefined;
  }

  /** Append each session's projected events in `seq` order to its existing array. */
  private async readProjectionSlices(
    chunks: readonly (readonly string[])[],
    into: ReadonlyMap<string, SequencedEvent[]>,
    db: Kysely<Database> | Transaction<Database> = this.getDb(),
    throughSeq?: number,
  ): Promise<void> {
    for (const ids of chunks) {
      let query = db
        .selectFrom('events')
        .select(['session_id', 'id', 'payload', 'created_at'])
        .where('session_id', 'in', ids)
        .where('type', 'in', [...SESSION_PROJECTION_EVENT_TYPES]);
      if (throughSeq !== undefined) query = query.where('id', '<=', throughSeq);
      const rows = await query.orderBy('session_id', 'asc').orderBy('id', 'asc').execute();
      for (const row of rows) {
        const events = into.get(row.session_id);
        if (events === undefined) continue;
        const parsed = parseAgentEvent(row.payload);
        if (!parsed.success) {
          // Same contract as event history pagination: a payload that does not
          // parse is a corrupted log, not a row to skip past. Batching widens the
          // blast radius — one bad row now fails the whole list rather than one
          // session — and that is the right trade: events are validated on the
          // way IN, so a row that fails on the way out means the database no
          // longer holds what the server wrote, and a badge quietly rendered from
          // the surviving rows would hide it.
          throw new Error(
            `corrupt event payload in session ${row.session_id}: ${parsed.error.message}`,
          );
        }
        events.push({ seq: Number(row.id), ts: row.created_at.getTime(), event: parsed.data });
      }
    }
  }
}
