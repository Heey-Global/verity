import type { FastifyInstance } from 'fastify';
import { SealedError, type EventStore, type SealableSecretCipher } from '@verity/store';
import { z } from 'zod';
import './fastify-augmentation.js';
import type { AgentLoginService } from './agent-login.js';
import { viewerId } from './view-state-routes.js';

type Store = Pick<EventStore, 'userProviderConnections' | 'isActiveAdministrator'>;

const loginProvider = z.object({ provider: z.enum(['claude', 'codex']) }).strict();
const anyProvider = z.object({ provider: z.enum(['claude', 'codex', 'opencode']) }).strict();
const loginSession = z.object({ sessionId: z.string().min(1).max(100) }).strict();
const codeBody = z.object({ code: z.string().trim().min(1).max(4096) }).strict();
const openCodeBody = z
  .object({
    baseUrl: z.string().trim().url().max(2048),
    apiKey: z.string().trim().min(1).max(4096),
  })
  .strict();

/**
 * A person's own Claude, Codex and OpenCode accounts (ADR 0023 §3). Every route
 * acts for the signed-in person only: no user id is taken from the request, a
 * login session belongs to the person who started it, and no credential is
 * ever returned.
 */
export function registerProviderConnectionRoutes(
  app: FastifyInstance,
  deps: {
    store: Store;
    agentLogin: AgentLoginService;
    secretCipher?: SealableSecretCipher | undefined;
    /** Lists the provider's models with the given address and key, proving both work. */
    listOpenCodeModels: (baseUrl: string, apiKey: string) => Promise<string[]>;
  },
): void {
  const unsealed = () => {
    if (deps.secretCipher?.isSealed() === true) throw new SealedError();
  };

  app.get('/me/provider-connections', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const userId = viewerId(request);
    const [connections, administrator] = await Promise.all([
      deps.store.userProviderConnections.status(userId),
      deps.store.isActiveAdministrator(userId),
    ]);
    return {
      connections: connections.map((connection) => ({
        provider: connection.provider,
        baseUrl: connection.baseUrl,
        models: connection.models === null ? [] : connection.models.split('\n').filter(Boolean),
        updatedAt: connection.updatedAt.toISOString(),
      })),
      // The administrator's turns fall back to the instance login, which was theirs.
      usesInstanceLogins: administrator,
    };
  });

  app.post('/me/provider-connections/:provider/login', async (request, reply) => {
    unsealed();
    const { provider } = loginProvider.parse(request.params);
    reply.header('cache-control', 'no-store');
    return { login: await deps.agentLogin.start(provider, viewerId(request)) };
  });

  app.get('/me/provider-connections/logins/:sessionId', async (request, reply) => {
    const { sessionId } = loginSession.parse(request.params);
    reply.header('cache-control', 'no-store');
    try {
      return { login: await deps.agentLogin.get(sessionId, viewerId(request)) };
    } catch {
      return reply.code(404).send({ error: 'login session not found' });
    }
  });

  app.post('/me/provider-connections/logins/:sessionId/code', async (request, reply) => {
    unsealed();
    const { sessionId } = loginSession.parse(request.params);
    const { code } = codeBody.parse(request.body);
    reply.header('cache-control', 'no-store');
    try {
      return { login: await deps.agentLogin.submitCode(sessionId, code, viewerId(request)) };
    } catch (error) {
      return reply
        .code(error instanceof Error && error.message === 'login session not found' ? 404 : 409)
        .send({ error: error instanceof Error ? error.message : 'login failed' });
    }
  });

  app.put('/me/provider-connections/opencode', async (request, reply) => {
    unsealed();
    const input = openCodeBody.safeParse(request.body);
    if (!input.success) return reply.code(400).send({ error: 'invalid OpenCode connection' });
    let models: string[];
    try {
      models = await deps.listOpenCodeModels(input.data.baseUrl, input.data.apiKey);
    } catch {
      return reply
        .code(400)
        .send({ error: 'this address and key did not answer with a model list' });
    }
    await deps.store.userProviderConnections.set(viewerId(request), 'opencode', {
      credential: input.data.apiKey,
      baseUrl: input.data.baseUrl,
      models: models.join('\n'),
    });
    reply.header('cache-control', 'no-store');
    return { provider: 'opencode', baseUrl: input.data.baseUrl, models };
  });

  app.delete('/me/provider-connections/:provider', async (request, reply) => {
    const { provider } = anyProvider.parse(request.params);
    await deps.store.userProviderConnections.delete(viewerId(request), provider);
    return reply.code(204).send();
  });
}
