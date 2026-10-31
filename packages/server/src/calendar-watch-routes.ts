// Which Google calendars Verity watches for online meetings (docs/live-meeting-calendar.md).
// A calendar carries no project: meetings joined from it start unassigned.
import type { EventStore } from '@verity/store';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  GoogleCalendarHttpError,
  listCalendars,
  type CalendarListEntry,
} from './google-calendar.js';
import type { GoogleFetch } from './google-drive.js';
import { hasGoogleCalendarScopes } from './google-oauth-scopes.js';
import { retentionDays } from './live-meeting-intake.js';

/** Roles that can read event details, and with them the meeting links. */
const READABLE_ROLES = new Set(['reader', 'writer', 'owner']);

export interface CalendarWatchRouteDeps {
  store: Pick<EventStore, 'googleAccounts' | 'calendarWatch' | 'getVeritySettingsRaw'>;
  googleAccessToken: (accountId?: string) => Promise<string | undefined>;
  fetch?: GoogleFetch;
  log: { warn(obj: unknown, msg?: string): void };
}

export interface CalendarWatchAccountView {
  id: string;
  email: string;
  displayName: string | null;
  /** `missing_scope`: the account was connected without Calendar; `unavailable`: Google
   * could not be asked, so only the calendars already watched are listed. */
  access: 'ok' | 'missing_scope' | 'unavailable';
  calendars: {
    id: string;
    summary: string;
    primary: boolean;
    watched: boolean;
    autoJoin: boolean;
  }[];
}

const updateBody = z
  .object({
    accountId: z.string().min(1).max(200),
    calendarId: z.string().min(1).max(1024),
    watched: z.boolean(),
    autoJoin: z.boolean().default(false),
  })
  .strict();

class CalendarWatchError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function registerCalendarWatchRoutes(
  app: FastifyInstance,
  deps: CalendarWatchRouteDeps,
): void {
  const readable = async (accountId: string): Promise<CalendarListEntry[]> => {
    const token = await deps.googleAccessToken(accountId);
    if (!token) throw new CalendarWatchError(503, 'Google is not available right now.');
    return (await listCalendars(token, deps.fetch)).filter((calendar) =>
      READABLE_ROLES.has(calendar.accessRole),
    );
  };

  app.get('/settings/calendar-watch', async () => {
    const watched = await deps.store.calendarWatch.list();
    const accounts: CalendarWatchAccountView[] = [];
    for (const account of await deps.store.googleAccounts.list()) {
      const mine = watched.filter((item) => item.accountId === account.id);
      const view = { id: account.id, email: account.email, displayName: account.displayName };
      const stored = mine.map((item) => ({
        id: item.calendarId,
        summary: item.summary,
        primary: false,
        watched: true,
        autoJoin: item.autoJoin,
      }));
      if (!hasGoogleCalendarScopes(account.scopes)) {
        accounts.push({ ...view, access: 'missing_scope', calendars: stored });
        continue;
      }
      try {
        const calendars = (await readable(account.id))
          .map((calendar) => {
            const choice = mine.find((item) => item.calendarId === calendar.id);
            return {
              id: calendar.id,
              summary: calendar.summary,
              primary: calendar.primary,
              watched: choice !== undefined,
              autoJoin: choice?.autoJoin ?? false,
            };
          })
          // The primary calendar first; Google's own order for the rest.
          .sort((a, b) => Number(b.primary) - Number(a.primary));
        accounts.push({ ...view, access: 'ok', calendars });
      } catch (err) {
        deps.log.warn({ err, accountId: account.id }, 'calendar list for meeting watch failed');
        accounts.push({ ...view, access: 'unavailable', calendars: stored });
      }
    }
    return { accounts, retentionDays: await retentionDays(deps.store) };
  });

  app.put('/settings/calendar-watch', async (request, reply) => {
    const body = updateBody.parse(request.body);
    try {
      if (!body.watched) {
        // Stopping never needs Google, so it works with a revoked or unreachable account.
        await deps.store.calendarWatch.unwatch(body.accountId, body.calendarId);
        return { watched: false, autoJoin: false };
      }
      const account = await deps.store.googleAccounts.get(body.accountId);
      if (!account) throw new CalendarWatchError(404, 'Google account not found.');
      if (!hasGoogleCalendarScopes(account.scopes))
        throw new CalendarWatchError(409, 'Grant Calendar access to this Google account first.');
      const calendar = (await readable(account.id)).find((item) => item.id === body.calendarId);
      if (!calendar)
        throw new CalendarWatchError(404, 'This calendar is not available to the account.');
      await deps.store.calendarWatch.watch({
        accountId: account.id,
        calendarId: calendar.id,
        summary: calendar.summary,
        autoJoin: body.autoJoin,
      });
      return { watched: true, autoJoin: body.autoJoin };
    } catch (error) {
      if (error instanceof CalendarWatchError)
        return reply.code(error.status).send({ error: error.message });
      if (error instanceof GoogleCalendarHttpError)
        return reply.code(502).send({ error: 'Google Calendar could not be reached.' });
      throw error;
    }
  });
}
