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
const REQUIRED_CONTACTS_SCOPES = new Set(['https://www.googleapis.com/auth/userinfo.email']);

type ContactsRouteStore = Pick<EventStore, 'getVeritySettings' | 'updateVeritySettings'> &
  Partial<Pick<EventStore, 'googleAccounts'>> &
  Pick<
    EventStore,
    | 'getSession'
    | 'getSessionContactsConnection'
    | 'enableSessionContacts'
    | 'disableSessionContacts'
    | 'clearSessionContactsConnections'
    | 'clearSessionCalendarConnections'
    | 'clearSessionGmailConnections'
  >;

interface ContactsRouteDeps {
  eventStore: ContactsRouteStore;
  googleClientId?: string;
  stagingGoogleClientId?: string;
  secretCipher?: SealableSecretCipher;
  fetch?: GoogleFetch;
  onCredentialsChanged?: () => void;
}

async function contactsAccountEmail(
  accessToken: string,
  doFetch: GoogleFetch = fetch,
): Promise<string | undefined> {
  const response = await doFetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok)
    throw new GoogleDriveError('Contacts profile request failed', `http_${response.status}`);
  const body = (await response.json().catch(() => ({}))) as { email?: unknown };
  return typeof body.email === 'string' && body.email.length > 0 ? body.email : undefined;
}

/** Shared-Google-account Contacts consent and explicit per-session enablement. */
export function registerGoogleContactsRoutes(app: FastifyInstance, deps: ContactsRouteDeps): void {
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

    instance.get('/contacts/connection', async () => {
      if (deps.eventStore.googleAccounts) {
        const accounts = (await deps.eventStore.googleAccounts.list()).filter((account) =>
          hasGoogleContactsScopes(account.scopes),
        );
        return {
          connected: accounts.length > 0,
          accountEmail: accounts.length === 1 ? accounts[0]!.email : null,
        };
      }
      const current = await settings();
      const connected =
        current?.contactsAuthorized === true && Boolean(current.googleDriveRefreshToken?.trim());
      return {
        connected,
        accountEmail: connected ? (current?.googleDriveAccountEmail ?? null) : null,
      };
    });

    instance.post(
      '/contacts/connect',
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
          request.log.error({ reason }, 'verity: Contacts code exchange failed');
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
          !hasGoogleContactsScopes(tokens.scopes) ||
          [...REQUIRED_CONTACTS_SCOPES].some((scope) => !tokens.scopes?.includes(scope))
        ) {
          reply.code(400);
          return { error: 'Google did not grant the required Contacts permissions' };
        }
        let accountEmail: string;
        try {
          accountEmail =
            (await contactsAccountEmail(tokens.accessToken, deps.fetch)) ??
            (() => {
              throw new Error('missing Contacts account email');
            })();
        } catch {
          reply.code(502);
          return { error: 'Could not verify the connected Contacts account' };
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
        const calendarAuthorized = hasGoogleCalendarScopes(tokens.scopes);
        if (
          previous?.googleDriveAccountEmail !== null &&
          previous?.googleDriveAccountEmail !== undefined &&
          previous.googleDriveAccountEmail.toLowerCase() !== accountEmail.toLowerCase()
        ) {
          await deps.eventStore.clearSessionContactsConnections();
          await deps.eventStore.clearSessionGmailConnections();
          await deps.eventStore.clearSessionCalendarConnections();
        }
        const gmailAuthorized = hasGoogleGmailScopes(tokens.scopes);
        if (!calendarAuthorized) await deps.eventStore.clearSessionCalendarConnections();
        if (!gmailAuthorized) await deps.eventStore.clearSessionGmailConnections();
        await deps.eventStore.updateVeritySettings({
          googleGrantedScopes: tokens.scopes ?? [],
          calendarAuthorized,
          googleDriveClientId: clientId,
          googleDriveRefreshToken: tokens.refreshToken,
          googleDriveAccountEmail: accountEmail,
          contactsAuthorized: true,
          gmailAuthorized,
        });
        deps.onCredentialsChanged?.();
        return { connected: true as const, accountEmail };
      },
    );

    instance.get('/sessions/:id/contacts', async (request, reply) => {
      const { id } = sessionParams.parse(request.params);
      if ((await deps.eventStore.getSession(id)) === undefined) {
        reply.code(404);
        return { error: `session ${id} not found` };
      }
      if (deps.eventStore.googleAccounts) {
        const accounts = (await deps.eventStore.googleAccounts.list()).filter((account) =>
          hasGoogleContactsScopes(account.scopes),
        );
        const effective = await deps.eventStore.googleAccounts.effectiveAccess(id, 'contacts');
        const access = await deps.eventStore.googleAccounts.sessionAccess(id, 'contacts');
        return {
          enabled: effective !== undefined && hasGoogleContactsScopes(effective.account.scopes),
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
      const connection = await deps.eventStore.getSessionContactsConnection(id);
      const current = await settings();
      const connected =
        current?.contactsAuthorized === true && Boolean(current.googleDriveRefreshToken?.trim());
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

    instance.put('/sessions/:id/contacts', async (request, reply) => {
      const { id } = sessionParams.parse(request.params);
      if ((await deps.eventStore.getSession(id)) === undefined) {
        reply.code(404);
        return { error: `session ${id} not found` };
      }
      if (deps.eventStore.googleAccounts) {
        const accounts = (await deps.eventStore.googleAccounts.list()).filter((account) =>
          hasGoogleContactsScopes(account.scopes),
        );
        if (accounts.length !== 1)
          return reply.code(409).send({ error: 'Choose an authorized Google account' });
        const account = accounts[0]!;
        await deps.eventStore.googleAccounts.setSessionAccess(id, 'contacts', {
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
      if (current?.contactsAuthorized !== true || !current.googleDriveRefreshToken?.trim()) {
        reply.code(409);
        return { error: 'Contacts is not connected' };
      }
      const accountEmail = current.googleDriveAccountEmail;
      if (!accountEmail) {
        reply.code(409);
        return { error: 'Contacts account identity is unavailable' };
      }
      await deps.eventStore.enableSessionContacts(id, accountEmail);
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

    instance.delete('/sessions/:id/contacts', async (request, reply) => {
      const { id } = sessionParams.parse(request.params);
      if ((await deps.eventStore.getSession(id)) === undefined) {
        reply.code(404);
        return { error: `session ${id} not found` };
      }
      await deps.eventStore.disableSessionContacts(id);
      // Older clients must not report a successful logout while project access remains.
      if ((await deps.eventStore.getSessionContactsConnection(id)) !== undefined) {
        return reply.code(409).send({
          error:
            'Google access is enabled for this project. Manage it in project settings with an updated app.',
        });
      }
      reply.code(204);
    });
  });
}
