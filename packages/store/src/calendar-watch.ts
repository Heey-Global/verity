import { createHash } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { SecretCipher } from './crypto.js';
import type { Database } from './schema.js';

/** A Google calendar Verity watches for online meetings. */
export interface WatchedCalendar {
  accountId: string;
  calendarId: string;
  /** The calendar's name when it was chosen, shown in notifications. */
  summary: string;
  /** Join at the start time without asking first. */
  autoJoin: boolean;
}

/** A joinable event as the watcher found it in a watched calendar. */
export interface CalendarWatchEventInput {
  eventId: string;
  title: string | null;
  meetingUrl: string;
  startsAt: number;
  endsAt: number;
  /** The owner accepted or organizes it; only then is it joined without asking. */
  accepted: boolean;
}

/** A joinable event and what Verity already did about it. */
export interface CalendarWatchEvent extends CalendarWatchEventInput {
  /** Stable, opaque id for routes and notifications; derived from account, calendar and event. */
  key: string;
  accountId: string;
  calendarId: string;
  notifiedAt: number | null;
  decision: 'joined' | 'skipped' | 'failed' | null;
  meetingId: string | null;
  startedNotifiedAt: number | null;
}

export function calendarEventKey(accountId: string, calendarId: string, eventId: string): string {
  return createHash('sha256')
    .update(JSON.stringify([accountId, calendarId, eventId]))
    .digest('base64url')
    .slice(0, 32);
}

const iso = (ms: number) => new Date(ms).toISOString();

export class CalendarWatchStore {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly cipher: SecretCipher,
  ) {}

  async list(): Promise<WatchedCalendar[]> {
    const rows = await this.db
      .selectFrom('calendar_watch_calendars')
      .select(['account_id', 'calendar_id', 'summary', 'auto_join'])
      .orderBy('account_id')
      .orderBy('calendar_id')
      .execute();
    return rows.map((row) => ({
      accountId: row.account_id,
      calendarId: row.calendar_id,
      summary: row.summary,
      autoJoin: row.auto_join,
    }));
  }

  /** Starts or updates watching a calendar. */
  async watch(calendar: WatchedCalendar): Promise<void> {
    await this.db
      .insertInto('calendar_watch_calendars')
      .values({
        account_id: calendar.accountId,
        calendar_id: calendar.calendarId,
        summary: calendar.summary,
        auto_join: calendar.autoJoin,
      })
      .onConflict((conflict) =>
        conflict.columns(['account_id', 'calendar_id']).doUpdateSet({
          summary: calendar.summary,
          auto_join: calendar.autoJoin,
          updated_at: new Date().toISOString(),
        }),
      )
      .execute();
  }

  async unwatch(accountId: string, calendarId: string): Promise<void> {
    await this.db
      .deleteFrom('calendar_watch_calendars')
      .where('account_id', '=', accountId)
      .where('calendar_id', '=', calendarId)
      .execute();
  }

  /**
   * Records the joinable events of one calendar in [from, to). An event that moved starts
   * over: it is announced again unless Verity already joined it. Events no longer returned
   * (cancelled, declined, link removed) are forgotten unless joined.
   */
  async syncEvents(
    accountId: string,
    calendarId: string,
    window: { from: number; to: number },
    events: readonly CalendarWatchEventInput[],
  ): Promise<void> {
    await this.db.transaction().execute(async (tx) => {
      const existing = await tx
        .selectFrom('calendar_watch_events')
        .select(['event_key', 'starts_at', 'decision'])
        .where('account_id', '=', accountId)
        .where('calendar_id', '=', calendarId)
        .execute();
      const seen = new Set<string>();
      for (const event of events) {
        const key = calendarEventKey(accountId, calendarId, event.eventId);
        seen.add(key);
        const previous = existing.find((row) => row.event_key === key);
        const fields = {
          title: event.title === null ? null : this.cipher.encrypt(event.title),
          meeting_url: this.cipher.encrypt(event.meetingUrl),
          starts_at: iso(event.startsAt),
          ends_at: iso(event.endsAt),
          accepted: event.accepted,
          updated_at: new Date().toISOString(),
        };
        if (!previous) {
          await tx
            .insertInto('calendar_watch_events')
            .values({
              event_key: key,
              account_id: accountId,
              calendar_id: calendarId,
              event_id: event.eventId,
              ...fields,
            })
            .execute();
          continue;
        }
        await tx
          .updateTable('calendar_watch_events')
          .set(fields)
          .where('event_key', '=', key)
          .execute();
        // A moved meeting is asked about again. The condition is checked again in the update,
        // since a join can claim the event after `previous` was read.
        if (previous.starts_at.getTime() !== event.startsAt && previous.decision !== 'joined')
          await tx
            .updateTable('calendar_watch_events')
            .set({ notified_at: null, decision: null, started_notified_at: null })
            .where('event_key', '=', key)
            .where((eb) => eb.or([eb('decision', 'is', null), eb('decision', '!=', 'joined')]))
            .execute();
      }
      const gone = existing
        .filter((row) => !seen.has(row.event_key) && row.decision !== 'joined')
        .map((row) => row.event_key);
      if (gone.length)
        await tx
          .deleteFrom('calendar_watch_events')
          .where('event_key', 'in', gone)
          .where('ends_at', '>', new Date(window.from))
          .where('starts_at', '<', new Date(window.to))
          .execute();
    });
  }

  /** Forgets events that ended before `before`. */
  async pruneEvents(before: number): Promise<void> {
    await this.db
      .deleteFrom('calendar_watch_events')
      .where('ends_at', '<', new Date(before))
      .execute();
  }

  async listEvents(): Promise<CalendarWatchEvent[]> {
    const rows = await this.db
      .selectFrom('calendar_watch_events')
      .selectAll()
      .orderBy('starts_at')
      .orderBy('event_key')
      .execute();
    return rows.map((row) => ({
      key: row.event_key,
      accountId: row.account_id,
      calendarId: row.calendar_id,
      eventId: row.event_id,
      title: row.title === null ? null : this.cipher.decrypt(row.title),
      meetingUrl: this.cipher.decrypt(row.meeting_url),
      startsAt: row.starts_at.getTime(),
      endsAt: row.ends_at.getTime(),
      accepted: row.accepted,
      notifiedAt: row.notified_at?.getTime() ?? null,
      decision: row.decision,
      meetingId: row.meeting_id,
      startedNotifiedAt: row.started_notified_at?.getTime() ?? null,
    }));
  }

  async getEvent(key: string): Promise<CalendarWatchEvent | undefined> {
    return (await this.listEvents()).find((event) => event.key === key);
  }

  async markNotified(key: string): Promise<void> {
    await this.db
      .updateTable('calendar_watch_events')
      .set({ notified_at: new Date().toISOString() })
      .where('event_key', '=', key)
      .execute();
  }

  async markStartedNotified(key: string): Promise<void> {
    await this.db
      .updateTable('calendar_watch_events')
      .set({ started_notified_at: new Date().toISOString() })
      .where('event_key', '=', key)
      .execute();
  }

  /**
   * Claims the event for joining. Only one caller wins: a notification action, the app and
   * the automatic join can race, and a meeting must never get two bots.
   */
  async claimJoin(key: string, options: { automatic?: boolean } = {}): Promise<boolean> {
    const result = await this.db
      .updateTable('calendar_watch_events')
      .set({ decision: 'joined', updated_at: new Date().toISOString() })
      .where('event_key', '=', key)
      // Someone may join a meeting they skipped earlier; the automatic join must not, even
      // when the Skip lands between the watcher reading the event and claiming it.
      .where((eb) =>
        options.automatic
          ? eb('decision', 'is', null)
          : eb.or([eb('decision', 'is', null), eb('decision', '!=', 'joined')]),
      )
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }

  async setJoinResult(
    key: string,
    result: { meetingId: string } | { failed: true },
  ): Promise<void> {
    await this.db
      .updateTable('calendar_watch_events')
      .set(
        'meetingId' in result
          ? { meeting_id: result.meetingId }
          : { decision: 'failed', meeting_id: null },
      )
      .where('event_key', '=', key)
      .execute();
  }

  /** Gives back joins claimed by a process that stopped before the bot started; nothing
   * else would ever resolve them. Run before anything in this process claims. */
  async releaseUnfinishedJoins(): Promise<void> {
    await this.db
      .updateTable('calendar_watch_events')
      .set({ decision: null, updated_at: new Date().toISOString() })
      .where('decision', '=', 'joined')
      .where('meeting_id', 'is', null)
      .execute();
  }

  /** Gives a claimed join back after the bot could not start, so it can be tried again. */
  async releaseJoin(key: string): Promise<void> {
    await this.db
      .updateTable('calendar_watch_events')
      .set({ decision: null, meeting_id: null, updated_at: new Date().toISOString() })
      .where('event_key', '=', key)
      .where('decision', '=', 'joined')
      .where('meeting_id', 'is', null)
      .execute();
  }

  /** Skips the event; false when it was already joined or is unknown. */
  async skip(key: string): Promise<boolean> {
    const result = await this.db
      .updateTable('calendar_watch_events')
      .set({ decision: 'skipped', updated_at: new Date().toISOString() })
      .where('event_key', '=', key)
      .where((eb) => eb.or([eb('decision', 'is', null), eb('decision', '!=', 'joined')]))
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }
}
