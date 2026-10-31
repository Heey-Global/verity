import type { Kysely } from 'kysely';
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

export class CalendarWatchStore {
  constructor(private readonly db: Kysely<Database>) {}

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
}
