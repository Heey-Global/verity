import './fastify-augmentation.js';
import { viewerId } from './view-state-routes.js';
import { GoogleAccountCleanupPendingError } from '@verity/store';
import type { EventStore, GoogleService } from '@verity/store';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  hasGoogleGmailScopes,
  hasGoogleCalendarScopes,
  hasGoogleContactsScopes,
} from './google-oauth-scopes.js';

const serviceParams = z.object({
  id: z.string().min(1),
  service: z.enum(['gmail', 'calendar', 'contacts']),
});
const accountParams = z.object({ accountId: z.string().min(1) });
const accessBody = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('inherit') }),
  z.object({ mode: z.literal('disabled') }),
  z.object({ mode: z.literal('account'), accountId: z.string().min(1) }),
]);
const checks = {
  gmail: hasGoogleGmailScopes,
  calendar: hasGoogleCalendarScopes,
  contacts: hasGoogleContactsScopes,
};

export function registerGoogleAccountRoutes(app: FastifyInstance, store: EventStore): void {
  // Every route acts for the signed-in person: they see, rename, remove and
  // choose only Google accounts they connected themselves (ADR 0023 §3).
  const userOf = (request: FastifyRequest): string | undefined => viewerId(request);
  app.get('/google/accounts', async (request) => ({
    accounts: await Promise.all(
      (await store.googleAccounts.list(userOf(request) ?? '')).map(async (account) => ({
        ...account,
        ...(await store.googleAccounts.usage(account.id)),
      })),
    ),
  }));
  app.patch('/google/accounts/:accountId', async (request, reply) => {
    const { accountId } = accountParams.parse(request.params);
    const { displayName } = z
      .object({ displayName: z.string().trim().max(100).nullable() })
      .parse(request.body);
    if (!(await store.googleAccounts.getOwned(accountId, userOf(request))))
      return reply.code(404).send({ error: 'Google account not found' });
    await store.googleAccounts.rename(accountId, displayName);
    return { account: await store.googleAccounts.getOwned(accountId, userOf(request)) };
  });
  app.delete('/google/accounts/:accountId', async (request, reply) => {
    const { accountId } = accountParams.parse(request.params);
    if (!(await store.googleAccounts.getOwned(accountId, userOf(request))))
      return reply.code(404).send({ error: 'Google account not found' });
    try {
      await store.googleAccounts.remove(accountId);
    } catch (error) {
      if (error instanceof GoogleAccountCleanupPendingError)
        return reply.code(409).send({ error: error.message });
      throw error;
    }
    return reply.code(204).send();
  });

  async function sessionStatus(id: string, service: GoogleService, userId: string | undefined) {
    const access = await store.googleAccounts.sessionAccess(id, service);
    const effective = await store.googleAccounts.effectiveAccess(id, service, userId);
    const account = effective?.account;
    const accounts = userId === undefined ? [] : await store.googleAccounts.list(userId);
    return {
      connected: accounts.some((candidate) => checks[service](candidate.scopes)),
      clientId: account?.clientId ?? accounts[0]?.clientId ?? null,
      mode: access.mode,
      enabled: account !== undefined && checks[service](account.scopes),
      accountId: account?.id ?? null,
      accountEmail: account?.email ?? null,
      accountName: account?.displayName ?? null,
      source: effective?.source ?? null,
    };
  }
  app.get('/sessions/:id/google/:service', async (request, reply) => {
    const { id, service } = serviceParams.parse(request.params);
    if (!(await store.getSession(id))) return reply.code(404).send({ error: 'Session not found' });
    return sessionStatus(id, service, userOf(request));
  });
  app.put('/sessions/:id/google/:service', async (request, reply) => {
    const { id, service } = serviceParams.parse(request.params);
    const access = accessBody.parse(request.body);
    if (!(await store.getSession(id))) return reply.code(404).send({ error: 'Session not found' });
    if (access.mode === 'account') {
      const account = await store.googleAccounts.getOwned(access.accountId, userOf(request));
      if (!account || !checks[service](account.scopes))
        return reply
          .code(409)
          .send({ error: 'Connect this Google service for the selected account first' });
    }
    await store.googleAccounts.setSessionAccess(id, service, access);
    return sessionStatus(id, service, userOf(request));
  });
}
