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

import { hasGoogleContactsScopes } from './google-oauth-scopes.js';

const sessionParams = z.object({
  id: z
    .string()
    .min(1)
    .regex(/^[A-Za-z0-9_-]+$/),
});

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
