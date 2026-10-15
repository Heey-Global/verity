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

import {
  hasGoogleGmailScopes,
  hasGoogleCalendarScopes,
  hasGoogleContactsScopes,
} from './google-oauth-scopes.js';
import { GoogleDriveError, exchangeGoogleAuthCode, type GoogleFetch } from './google-drive.js';

const connectBody = z.object({
  accountId: z.string().min(1).optional(),
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
const REQUIRED_GMAIL_SCOPES = new Set([
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/gmail.settings.basic',
]);

type GmailRouteStore = Pick<EventStore, 'getVeritySettings' | 'updateVeritySettings'> &
  Partial<Pick<EventStore, 'googleAccounts'>> &
  Pick<
    EventStore,
    | 'getSession'
    | 'getSessionGmailConnection'
    | 'enableSessionGmail'
    | 'disableSessionGmail'
    | 'clearSessionGmailConnections'
    | 'clearSessionCalendarConnections'
    | 'clearSessionContactsConnections'
  >;

interface GmailRouteDeps {
  eventStore: GmailRouteStore;
  googleClientId?: string;
  stagingGoogleClientId?: string;
  secretCipher?: SealableSecretCipher;
  fetch?: GoogleFetch;
  onCredentialsChanged?: () => void;
}

async function gmailAccountEmail(
  accessToken: string,
  doFetch: GoogleFetch = fetch,
): Promise<string | undefined> {
  const response = await doFetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok)
    throw new GoogleDriveError('Gmail profile request failed', `http_${response.status}`);
  const body = (await response.json().catch(() => ({}))) as { emailAddress?: unknown };
  return typeof body.emailAddress === 'string' && body.emailAddress.length > 0
    ? body.emailAddress
    : undefined;
}

/** Shared-Google-account Gmail consent and explicit per-session enablement. */
export function registerGmailRoutes(app: FastifyInstance, deps: GmailRouteDeps): void {
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

    instance.get('/gmail/connection', async () => {
      if (deps.eventStore.googleAccounts) {
        const accounts = (await deps.eventStore.googleAccounts.list()).filter((account) =>
          hasGoogleGmailScopes(account.scopes),
        );
        return {
          connected: accounts.length > 0,
          accountEmail: accounts.length === 1 ? accounts[0]!.email : null,
        };
      }
      const current = await settings();
      const connected =
        current?.gmailAuthorized === true && Boolean(current.googleDriveRefreshToken?.trim());
      return {
        connected,
        accountEmail: connected ? (current?.googleDriveAccountEmail ?? null) : null,
      };
    });

    instance.post(
      '/gmail/connect',
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
          request.log.error({ reason }, 'verity: Gmail code exchange failed');
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
          tokens.scopes === undefined ||
          [...REQUIRED_GMAIL_SCOPES].some((scope) => !tokens.scopes?.includes(scope))
        ) {
          reply.code(400);
          return { error: 'Google did not grant the required Gmail permissions' };
        }
        let accountEmail: string;
        try {
          accountEmail =
            (await gmailAccountEmail(tokens.accessToken, deps.fetch)) ??
            (() => {
              throw new Error('missing Gmail account email');
            })();
        } catch {
          reply.code(502);
          return { error: 'Could not verify the connected Gmail account' };
        }
        if (deps.eventStore.googleAccounts) {
          if (!accountEmail)
            return reply.code(502).send({ error: 'Could not verify the connected Google account' });
          let account;
          try {
            account = await deps.eventStore.googleAccounts.save({
              email: accountEmail,
              clientId,
              refreshToken: tokens.refreshToken,
              scopes: tokens.scopes ?? [],
              ...(body.accountId === undefined ? {} : { expectedAccountId: body.accountId }),
            });
          } catch (error) {
            if (error instanceof SealedError) throw error;
            return reply
              .code(409)
              .send({ error: 'The selected Google account does not match the signed-in account' });
          }
          if ((await deps.eventStore.googleAccounts.list()).length === 1) {
            await deps.eventStore.updateVeritySettings({
              googleDriveClientId: clientId,
              googleDriveRefreshToken: tokens.refreshToken,
              googleDriveAccountEmail: accountEmail,
              googleGrantedScopes: tokens.scopes ?? [],
              gmailAuthorized: hasGoogleGmailScopes(tokens.scopes),
              calendarAuthorized: hasGoogleCalendarScopes(tokens.scopes),
              contactsAuthorized: hasGoogleContactsScopes(tokens.scopes),
            });
          }
          deps.onCredentialsChanged?.();
          return { connected: true as const, accountEmail, accountId: account.id };
        }
        const previous = await settings();
        const contactsAuthorized = hasGoogleContactsScopes(tokens.scopes);
        const calendarAuthorized = hasGoogleCalendarScopes(tokens.scopes);
        const accountChanged =
          previous?.googleDriveAccountEmail !== null &&
          previous?.googleDriveAccountEmail !== undefined &&
          previous.googleDriveAccountEmail.toLowerCase() !== accountEmail.toLowerCase();
        if (!contactsAuthorized || accountChanged)
          await deps.eventStore.clearSessionContactsConnections();
        if (accountChanged) await deps.eventStore.clearSessionGmailConnections();
        if (!calendarAuthorized || accountChanged) {
          await deps.eventStore.clearSessionCalendarConnections();
        }
        await deps.eventStore.updateVeritySettings({
          googleGrantedScopes: tokens.scopes ?? [],
          contactsAuthorized,
          googleDriveClientId: clientId,
          googleDriveRefreshToken: tokens.refreshToken,
          googleDriveAccountEmail: accountEmail,
          gmailAuthorized: true,
          calendarAuthorized,
        });
        deps.onCredentialsChanged?.();
        return { connected: true as const, accountEmail };
      },
    );

    instance.get('/sessions/:id/gmail', async (request, reply) => {
      const { id } = sessionParams.parse(request.params);
      if ((await deps.eventStore.getSession(id)) === undefined) {
        reply.code(404);
        return { error: `session ${id} not found` };
      }
      if (deps.eventStore.googleAccounts) {
        const accounts = (await deps.eventStore.googleAccounts.list()).filter((account) =>
          hasGoogleGmailScopes(account.scopes),
        );
        const effective = await deps.eventStore.googleAccounts.effectiveAccess(id, 'gmail');
        const access = await deps.eventStore.googleAccounts.sessionAccess(id, 'gmail');
        return {
          enabled: effective !== undefined && hasGoogleGmailScopes(effective.account.scopes),
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
      const connection = await deps.eventStore.getSessionGmailConnection(id);
      const current = await settings();
      const connected =
        current?.gmailAuthorized === true && Boolean(current.googleDriveRefreshToken?.trim());
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

    instance.put('/sessions/:id/gmail', async (request, reply) => {
      const { id } = sessionParams.parse(request.params);
      if ((await deps.eventStore.getSession(id)) === undefined) {
        reply.code(404);
        return { error: `session ${id} not found` };
      }
      if (deps.eventStore.googleAccounts) {
        const accounts = (await deps.eventStore.googleAccounts.list()).filter((account) =>
          hasGoogleGmailScopes(account.scopes),
        );
        if (accounts.length !== 1)
          return reply.code(409).send({ error: 'Choose an authorized Google account' });
        const account = accounts[0]!;
        await deps.eventStore.googleAccounts.setSessionAccess(id, 'gmail', {
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
      if (current?.gmailAuthorized !== true || !current.googleDriveRefreshToken?.trim()) {
        reply.code(409);
        return { error: 'Gmail is not connected' };
      }
      const accountEmail = current.googleDriveAccountEmail;
      if (!accountEmail) {
        reply.code(409);
        return { error: 'Gmail account identity is unavailable' };
      }
      await deps.eventStore.enableSessionGmail(id, accountEmail);
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

    instance.delete('/sessions/:id/gmail', async (request, reply) => {
      const { id } = sessionParams.parse(request.params);
      if ((await deps.eventStore.getSession(id)) === undefined) {
        reply.code(404);
        return { error: `session ${id} not found` };
      }
      await deps.eventStore.disableSessionGmail(id);
      // Older clients must not report a successful logout while project access remains.
      if ((await deps.eventStore.getSessionGmailConnection(id)) !== undefined) {
        return reply.code(409).send({
          error:
            'Google access is enabled for this project. Manage it in project settings with an updated app.',
        });
      }
      reply.code(204);
    });
  });
}
