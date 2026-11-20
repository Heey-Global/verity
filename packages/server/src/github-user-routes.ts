import type { FastifyInstance, FastifyReply } from 'fastify';
import type { EventStore } from '@verity/store';
import { z } from 'zod';
import './fastify-augmentation.js';
import {
  GitHubUserAuthorizationError,
  type GitHubUserAuthorization,
} from './github-user-authorization.js';
import { viewerId } from './view-state-routes.js';

const completion = z
  .object({
    code: z.string().min(1).max(512),
    state: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
  })
  .strict();
const oauthClient = z
  .object({
    clientId: z.string().trim().min(1).max(128),
    clientSecret: z.string().trim().min(1).max(512),
  })
  .strict();

function refused(reply: FastifyReply, error: unknown) {
  if (!(error instanceof GitHubUserAuthorizationError)) throw error;
  const status =
    error.code === 'not_configured' || error.code === 'invalid_state'
      ? 409
      : error.code === 'rejected'
        ? 400
        : 502;
  return reply.code(status).send({ error: error.message });
}

/**
 * A person's own GitHub connection (ADR 0023 §3). Every `/me/github` route acts
 * for the signed-in person only; no user id is taken from the request. Setting
 * the App's OAuth client is instance administration and stays administrator-only.
 */
export function registerGitHubUserRoutes(
  app: FastifyInstance,
  deps: {
    authorization: GitHubUserAuthorization;
    store: Pick<EventStore, 'updateVeritySettings'>;
    /** Runs after a person connected GitHub. Best effort: a failure here must not
     *  undo or misreport the connection itself. */
    onConnected?: ((userId: string) => Promise<void>) | undefined;
  },
): void {
  app.get('/me/github', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    return deps.authorization.status(viewerId(request));
  });
  app.post('/me/github/authorize', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    try {
      return await deps.authorization.start(viewerId(request));
    } catch (error) {
      return refused(reply, error);
    }
  });
  app.post('/me/github/authorize/complete', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const input = completion.safeParse(request.body);
    if (!input.success) return reply.code(400).send({ error: 'Invalid GitHub sign-in response' });
    try {
      const userId = viewerId(request);
      const connected = await deps.authorization.complete(userId, input.data);
      await deps.onConnected?.(userId).catch((error: unknown) => {
        request.log.warn({ err: error }, 'post-connection setup for GitHub failed');
      });
      return connected;
    } catch (error) {
      return refused(reply, error);
    }
  });
  app.delete('/me/github', async (request, reply) => {
    await deps.authorization.disconnect(viewerId(request));
    return reply.code(204).send();
  });
  app.put('/settings/github/oauth-client', async (request, reply) => {
    const input = oauthClient.safeParse(request.body);
    if (!input.success) return reply.code(400).send({ error: 'Invalid GitHub App OAuth client' });
    await deps.store.updateVeritySettings({
      githubAppClientId: input.data.clientId,
      githubAppClientSecret: input.data.clientSecret,
    });
    return { configured: true };
  });
}
