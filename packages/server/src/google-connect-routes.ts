import rateLimitPlugin from '@fastify/rate-limit';
import { SealedError, type EventStore, type SealableSecretCipher } from '@verity/store';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { googleAppClient } from './google-app-client.js';
import { GoogleDriveError, exchangeGoogleAuthCode, type GoogleFetch } from './google-drive.js';
import {
  hasGoogleCalendarScopes,
  hasGoogleContactsScopes,
  hasGoogleDriveScopes,
  hasGoogleGmailScopes,
  hasGoogleWorkspaceScope,
} from './google-oauth-scopes.js';

const connectBody = z.object({
  accountId: z.string().min(1).optional(),
  code: z.string().trim().min(1).max(4096),
  codeVerifier: z.string().trim().min(1).max(256),
  redirectUri: z.string().trim().min(1).max(2048),
});

interface GoogleConnectRouteDeps {
  eventStore: Pick<EventStore, 'googleAccounts' | 'updateVeritySettings'>;
  googleClientId?: string;
  stagingGoogleClientId?: string;
  secretCipher?: SealableSecretCipher;
  fetch?: GoogleFetch;
  onCredentialsChanged?: () => void;
}

/** Any service grant makes the account usable; the rest can be granted later. */
function grantsAnyService(scopes: readonly string[]): boolean {
  return (
    hasGoogleDriveScopes(scopes) ||
    hasGoogleGmailScopes(scopes) ||
    hasGoogleCalendarScopes(scopes) ||
    hasGoogleContactsScopes(scopes) ||
    // Docs, Sheets and Slides are one bundle, as the app counts them.
    (['docs', 'sheets', 'slides'] as const).every((kind) => hasGoogleWorkspaceScope(scopes, kind))
  );
}

async function googleIdentity(
  accessToken: string,
  doFetch: GoogleFetch = fetch,
): Promise<{ email: string; subject?: string } | undefined> {
  const response = await doFetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok)
    throw new GoogleDriveError('Google profile request failed', `http_${response.status}`);
  const body = (await response.json().catch(() => ({}))) as { email?: unknown; id?: unknown };
  if (typeof body.email !== 'string' || body.email.length === 0) return undefined;
  return {
    email: body.email,
    ...(typeof body.id === 'string' && body.id.length > 0 ? { subject: body.id } : {}),
  };
}

/**
 * One consent for every Google service. Google lets the user deselect individual
 * permissions, so the account keeps whatever was granted and the app shows what is missing.
 */
export function registerGoogleConnectRoutes(
  app: FastifyInstance,
  deps: GoogleConnectRouteDeps,
): void {
  app.register(async (instance) => {
    await instance.register(rateLimitPlugin, { global: false });
    instance.post(
      '/google/connect',
      { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
      async (request, reply) => {
        if (deps.secretCipher?.isSealed() === true) throw new SealedError();
        const body = connectBody.parse(request.body);
        const clientId =
          googleAppClient(request, deps.googleClientId, deps.stagingGoogleClientId) ?? '';
        if (!clientId)
          return reply.code(400).send({ error: 'Google is not configured on this server' });
        let tokens;
        try {
          tokens = await exchangeGoogleAuthCode(
            { clientId, ...body },
            deps.fetch === undefined ? {} : { fetch: deps.fetch },
          );
        } catch (error) {
          const reason = error instanceof GoogleDriveError ? error.reason : 'exchange_failed';
          request.log.error({ reason }, 'verity: Google code exchange failed');
          return reply.code(502).send({ error: `Google sign-in failed (${reason})` });
        }
        if (tokens.refreshToken === undefined)
          return reply.code(400).send({
            error: 'Google did not return a refresh token — reconnect and allow offline access',
          });
        const scopes = tokens.scopes ?? [];
        if (!grantsAnyService(scopes))
          return reply
            .code(400)
            .send({ error: 'Google did not grant access to any Google service' });
        let identity;
        try {
          identity = await googleIdentity(tokens.accessToken, deps.fetch);
        } catch {
          identity = undefined;
        }
        if (!identity)
          return reply.code(502).send({ error: 'Could not verify the connected Google account' });
        let account;
        try {
          account = await deps.eventStore.googleAccounts.save({
            email: identity.email,
            ...(identity.subject === undefined ? {} : { subject: identity.subject }),
            clientId,
            refreshToken: tokens.refreshToken,
            scopes,
            ...(body.accountId === undefined ? {} : { expectedAccountId: body.accountId }),
          });
        } catch (error) {
          if (error instanceof SealedError) throw error;
          return reply
            .code(409)
            .send({ error: 'The selected Google account does not match the signed-in account' });
        }
        // The legacy settings fields still describe a lone account for older readers.
        if ((await deps.eventStore.googleAccounts.list()).length === 1) {
          await deps.eventStore.updateVeritySettings({
            googleDriveClientId: clientId,
            googleDriveRefreshToken: tokens.refreshToken,
            googleDriveAccountEmail: account.email,
            googleGrantedScopes: scopes,
            gmailAuthorized: hasGoogleGmailScopes(scopes),
            calendarAuthorized: hasGoogleCalendarScopes(scopes),
            contactsAuthorized: hasGoogleContactsScopes(scopes),
          });
        }
        deps.onCredentialsChanged?.();
        return {
          connected: true as const,
          accountEmail: account.email,
          accountId: account.id,
          scopes: account.scopes,
        };
      },
    );
  });
}
