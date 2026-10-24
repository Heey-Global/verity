import { googleAppClient } from './google-app-client.js';
import rateLimitPlugin from '@fastify/rate-limit';
import {
  SealedError,
  type EventStore,
  type SealableSecretCipher,
  type VeritySettingsRecord,
} from '@verity/store';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { hasGoogleCalendarScopes } from './google-oauth-scopes.js';

const sessionParams = z.object({
  id: z
    .string()
    .min(1)
    .regex(/^[A-Za-z0-9_-]+$/),
});

type CalendarRouteStore = Pick<EventStore, 'getVeritySettings' | 'updateVeritySettings'> &
  Partial<Pick<EventStore, 'googleAccounts'>> &
  Pick<
    EventStore,
    | 'getSession'
    | 'getSessionCalendarConnection'
    | 'enableSessionCalendar'
    | 'disableSessionCalendar'
    | 'clearSessionCalendarConnections'
    | 'clearSessionContactsConnections'
    | 'clearSessionGmailConnections'
  >;

interface CalendarRouteDeps {
  eventStore: CalendarRouteStore;
  googleClientId?: string;
  stagingGoogleClientId?: string;
  secretCipher?: SealableSecretCipher;
}

/** Shared-Google-account Calendar consent and explicit per-session enablement. */
export function registerGoogleCalendarRoutes(app: FastifyInstance, deps: CalendarRouteDeps): void {
  app.register(async (instance) => {
    await instance.register(rateLimitPlugin, { global: false });

    const settings = async (): Promise<VeritySettingsRecord | undefined> => {
      if (deps.secretCipher?.isSealed() === true) return undefined;
      try {
        return await deps.eventStore.getVeritySettings();
      } catch (error) {
        if (error instanceof SealedError) return undefined;
        throw error;
      }
    };

    instance.get('/calendar/connection', async () => {
      if (deps.eventStore.googleAccounts) {
        const accounts = (await deps.eventStore.googleAccounts.list()).filter((account) =>
          hasGoogleCalendarScopes(account.scopes),
        );
        return {
          connected: accounts.length > 0,
          accountEmail: accounts.length === 1 ? accounts[0]!.email : null,
        };
      }
      const current = await settings();
      const connected =
        current?.calendarAuthorized === true && Boolean(current.googleDriveRefreshToken?.trim());
      return {
        connected,
        accountEmail: connected ? (current?.googleDriveAccountEmail ?? null) : null,
      };
    });

    instance.get('/sessions/:id/calendar', async (request, reply) => {
      const { id } = sessionParams.parse(request.params);
      if ((await deps.eventStore.getSession(id)) === undefined) {
        reply.code(404);
        return { error: `session ${id} not found` };
      }
      if (deps.eventStore.googleAccounts) {
        const accounts = (await deps.eventStore.googleAccounts.list()).filter((account) =>
          hasGoogleCalendarScopes(account.scopes),
        );
        const effective = await deps.eventStore.googleAccounts.effectiveAccess(id, 'calendar');
        const access = await deps.eventStore.googleAccounts.sessionAccess(id, 'calendar');
        return {
          enabled: effective !== undefined && hasGoogleCalendarScopes(effective.account.scopes),
          connected: accounts.length > 0,
          clientId:
            googleAppClient(request, deps.googleClientId, deps.stagingGoogleClientId) ??
            effective?.account.clientId ??
            accounts[0]?.clientId ??
            null,
          accountId: effective?.account.id ?? null,
          accountEmail: effective?.account.email ?? null,
          source: effective?.source ?? null,
          mode: access.mode,
        };
      }
      const connection = await deps.eventStore.getSessionCalendarConnection(id);
      const current = await settings();
      const connected =
        current?.calendarAuthorized === true && Boolean(current.googleDriveRefreshToken?.trim());
      return {
        enabled: connection !== undefined,
        connected,
        clientId:
          googleAppClient(request, deps.googleClientId, deps.stagingGoogleClientId) ??
          (request.headers['x-verity-app-variant'] === undefined
            ? current?.googleDriveClientId
            : null) ??
          null,
        accountEmail: connection === undefined ? null : (current?.googleDriveAccountEmail ?? null),
      };
    });

    instance.put('/sessions/:id/calendar', async (request, reply) => {
      const { id } = sessionParams.parse(request.params);
      if ((await deps.eventStore.getSession(id)) === undefined) {
        reply.code(404);
        return { error: `session ${id} not found` };
      }
      if (deps.eventStore.googleAccounts) {
        const accounts = (await deps.eventStore.googleAccounts.list()).filter((account) =>
          hasGoogleCalendarScopes(account.scopes),
        );
        if (accounts.length !== 1)
          return reply.code(409).send({ error: 'Choose an authorized Google account' });
        const account = accounts[0]!;
        await deps.eventStore.googleAccounts.setSessionAccess(id, 'calendar', {
          mode: 'account',
          accountId: account.id,
        });
        return {
          enabled: true,
          connected: true,
          accountId: account.id,
          accountEmail: account.email,
          clientId:
            googleAppClient(request, deps.googleClientId, deps.stagingGoogleClientId) ??
            account.clientId,
          source: 'session',
          mode: 'account',
        };
      }
      const current = await settings();
      if (current?.calendarAuthorized !== true || !current.googleDriveRefreshToken?.trim()) {
        reply.code(409);
        return { error: 'Calendar is not connected' };
      }
      const accountEmail = current.googleDriveAccountEmail;
      if (!accountEmail) {
        reply.code(409);
        return { error: 'Calendar account identity is unavailable' };
      }
      await deps.eventStore.enableSessionCalendar(id, accountEmail);
      return {
        enabled: true as const,
        connected: true as const,
        clientId:
          googleAppClient(request, deps.googleClientId, deps.stagingGoogleClientId) ??
          (request.headers['x-verity-app-variant'] === undefined
            ? current.googleDriveClientId
            : null),
        accountEmail: current.googleDriveAccountEmail,
      };
    });

    instance.delete('/sessions/:id/calendar', async (request, reply) => {
      const { id } = sessionParams.parse(request.params);
      if ((await deps.eventStore.getSession(id)) === undefined) {
        reply.code(404);
        return { error: `session ${id} not found` };
      }
      await deps.eventStore.disableSessionCalendar(id);
      // Older clients must not report a successful logout while project access remains.
      if ((await deps.eventStore.getSessionCalendarConnection(id)) !== undefined) {
        return reply.code(409).send({
          error:
            'Google access is enabled for this project. Manage it in project settings with an updated app.',
        });
      }
      reply.code(204);
    });
  });
}
