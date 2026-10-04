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

import { GoogleDriveError, exchangeGoogleAuthCode, type GoogleFetch } from './google-drive.js';
import {
  hasGoogleCalendarScopes,
  hasGoogleContactsScopes,
  hasGoogleGmailScopes,
} from './google-oauth-scopes.js';

const connectBody = z.object({
  code: z.string().trim().min(1).max(4096),
  codeVerifier: z.string().trim().min(1).max(256),
  redirectUri: z.string().trim().min(1).max(2048),
});
const sessionParams = z.object({
  id: z
    .string()
    .min(1)
    .regex(/^[A-Za-z0-9_-]+$/),
});
const REQUIRED_CALENDAR_SCOPES = new Set(['https://www.googleapis.com/auth/userinfo.email']);

type CalendarRouteStore = Pick<EventStore, 'getVeritySettings' | 'updateVeritySettings'> &
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
  fetch?: GoogleFetch;
  onCredentialsChanged?: () => void;
}

async function calendarAccountEmail(
  accessToken: string,
  doFetch: GoogleFetch = fetch,
): Promise<string | undefined> {
  const response = await doFetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok)
    throw new GoogleDriveError('Calendar profile request failed', `http_${response.status}`);
  const body = (await response.json().catch(() => ({}))) as { email?: unknown };
  return typeof body.email === 'string' && body.email.length > 0 ? body.email : undefined;
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
      const current = await settings();
      const connected =
        current?.calendarAuthorized === true && Boolean(current.googleDriveRefreshToken?.trim());
      return {
        connected,
        accountEmail: connected ? (current?.googleDriveAccountEmail ?? null) : null,
      };
    });

    instance.post(
      '/calendar/connect',
      { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
      async (request, reply) => {
        if (deps.secretCipher?.isSealed() === true) throw new SealedError();
        const body = connectBody.parse(request.body);
        const clientId =
          googleAppClient(request, deps.googleClientId, deps.stagingGoogleClientId) ?? '';
        if (!clientId) {
          reply.code(400);
          return { error: 'Google is not configured on this server' };
        }
        let tokens;
        try {
          tokens = await exchangeGoogleAuthCode(
            { clientId, ...body },
            deps.fetch === undefined ? {} : { fetch: deps.fetch },
          );
        } catch (error) {
          const reason = error instanceof GoogleDriveError ? error.reason : 'exchange_failed';
          request.log.error({ reason }, 'verity: Calendar code exchange failed');
          reply.code(502);
          return { error: `Google sign-in failed (${reason})` };
        }
        if (tokens.refreshToken === undefined) {
          reply.code(400);
          return {
            error: 'Google did not return a refresh token — reconnect and allow offline access',
          };
        }
        if (
          !hasGoogleCalendarScopes(tokens.scopes) ||
          [...REQUIRED_CALENDAR_SCOPES].some((scope) => !tokens.scopes?.includes(scope))
        ) {
          reply.code(400);
          return { error: 'Google did not grant the required Calendar permissions' };
        }
        let accountEmail: string;
        try {
          accountEmail =
            (await calendarAccountEmail(tokens.accessToken, deps.fetch)) ??
            (() => {
              throw new Error('missing Calendar account email');
            })();
        } catch {
          reply.code(502);
          return { error: 'Could not verify the connected Calendar account' };
        }
        const previous = await settings();
        const contactsAuthorized = hasGoogleContactsScopes(tokens.scopes);
        if (
          previous?.googleDriveAccountEmail !== null &&
          previous?.googleDriveAccountEmail !== undefined &&
          previous.googleDriveAccountEmail.toLowerCase() !== accountEmail.toLowerCase()
        ) {
          await deps.eventStore.clearSessionCalendarConnections();
          await deps.eventStore.clearSessionGmailConnections();
          await deps.eventStore.clearSessionContactsConnections();
        }
        const gmailAuthorized = hasGoogleGmailScopes(tokens.scopes);
        if (!contactsAuthorized) await deps.eventStore.clearSessionContactsConnections();
        if (!gmailAuthorized) await deps.eventStore.clearSessionGmailConnections();
        await deps.eventStore.updateVeritySettings({
          googleGrantedScopes: tokens.scopes ?? [],
          contactsAuthorized,
          googleDriveClientId: clientId,
          googleDriveRefreshToken: tokens.refreshToken,
          googleDriveAccountEmail: accountEmail,
          calendarAuthorized: true,
          gmailAuthorized,
        });
        deps.onCredentialsChanged?.();
        return { connected: true as const, accountEmail };
      },
    );

    instance.get('/sessions/:id/calendar', async (request, reply) => {
      const { id } = sessionParams.parse(request.params);
      if ((await deps.eventStore.getSession(id)) === undefined) {
        reply.code(404);
        return { error: `session ${id} not found` };
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
