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
const REQUIRED_GMAIL_SCOPES = new Set([
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/presentations',
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/gmail.settings.basic',
]);

type GmailRouteStore = Pick<EventStore, 'getVeritySettings' | 'updateVeritySettings'> &
  Pick<
    EventStore,
    | 'getSession'
    | 'getSessionGmailConnection'
    | 'enableSessionGmail'
    | 'disableSessionGmail'
    | 'clearSessionGmailConnections'
  >;

interface GmailRouteDeps {
  eventStore: GmailRouteStore;
  googleClientId?: string;
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
        const clientId = deps.googleClientId ?? '';
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
          return { error: 'Google did not grant the required Workspace and Gmail permissions' };
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
        const previous = await settings();
        if (
          previous?.googleDriveAccountEmail !== null &&
          previous?.googleDriveAccountEmail !== undefined &&
          previous.googleDriveAccountEmail.toLowerCase() !== accountEmail.toLowerCase()
        ) {
          await deps.eventStore.clearSessionGmailConnections();
        }
        await deps.eventStore.updateVeritySettings({
          googleDriveClientId: clientId,
          googleDriveRefreshToken: tokens.refreshToken,
          googleDriveAccountEmail: accountEmail,
          gmailAuthorized: true,
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
      const connection = await deps.eventStore.getSessionGmailConnection(id);
      const current = await settings();
      const connected =
        current?.gmailAuthorized === true && Boolean(current.googleDriveRefreshToken?.trim());
      return {
        enabled: connection !== undefined,
        connected,
        clientId: deps.googleClientId ?? current?.googleDriveClientId ?? null,
        accountEmail: connection === undefined ? null : (current?.googleDriveAccountEmail ?? null),
      };
    });

    instance.put('/sessions/:id/gmail', async (request, reply) => {
      const { id } = sessionParams.parse(request.params);
      if ((await deps.eventStore.getSession(id)) === undefined) {
        reply.code(404);
        return { error: `session ${id} not found` };
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
        clientId: deps.googleClientId ?? current.googleDriveClientId,
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
      reply.code(204);
    });
  });
}
