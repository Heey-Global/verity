import { randomUUID } from 'node:crypto';
import { SealedError, type EventStore } from '@verity/store';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ForgejoTransport } from './forgejo-transport.js';

const connectionBody = z.object({
  label: z.string().trim().min(1).max(120),
  baseUrl: z.string().max(2048),
  token: z.string().min(1).max(8192),
  customCaPem: z.string().max(256_000).nullable().optional(),
});
const patchBody = connectionBody.omit({ baseUrl: true }).partial();

export function registerForgeConnectionRoutes(
  app: FastifyInstance,
  store: EventStore,
  githubRepositories: () => Promise<unknown[]> = () => Promise.resolve([]),
): void {
  const authorize = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.localUserId || !(await store.isActiveAdministrator(request.localUserId))) {
      reply.code(403).send({ error: 'administrator required' });
      return false;
    }
    return true;
  };
  const failure = (reply: FastifyReply, error: unknown) => {
    if (error instanceof SealedError) return reply.code(503).send({ error: 'credentials sealed' });
    return reply.code(422).send({ error: 'Forgejo connection validation failed' });
  };
  app.get('/connections', async (request, reply) => {
    if (!(await authorize(request, reply))) return;
    return { connections: await store.forgeConnections.list() };
  });
  app.post('/connections', async (request, reply) => {
    if (!(await authorize(request, reply))) return;
    const body = connectionBody.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid connection' });
    try {
      const transport = new ForgejoTransport(
        body.data.baseUrl,
        () => Promise.resolve(body.data.token),
        body.data.customCaPem,
      );
      await transport.validate();
      const id = randomUUID();
      await store.forgeConnections.upsert({
        id,
        provider: 'forgejo',
        baseUrl: transport.baseUrl,
        label: body.data.label,
        customCaPem: body.data.customCaPem ?? null,
        personalToken: body.data.token,
        githubAppId: null,
        githubAppInstallationId: null,
        githubAppPrivateKey: null,
      });
      return reply.code(201).send(await store.forgeConnections.get(id));
    } catch (error) {
      return failure(reply, error);
    }
  });
  app.patch('/connections/:id', async (request, reply) => {
    if (!(await authorize(request, reply))) return;
    const { id } = request.params as { id: string };
    const body = patchBody.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid connection' });
    const existing = await store.forgeConnections.get(id);
    if (!existing) return reply.code(404).send({ error: 'connection not found' });
    if (existing.provider !== 'forgejo')
      return reply.code(409).send({ error: 'use GitHub configuration' });
    try {
      const credentials = await store.forgeConnections.credentials(id);
      const token = body.data.token ?? credentials?.personalToken;
      if (!token) return reply.code(422).send({ error: 'token required' });
      const customCaPem =
        body.data.customCaPem === undefined ? existing.customCaPem : body.data.customCaPem;
      await new ForgejoTransport(
        existing.baseUrl,
        () => Promise.resolve(token),
        customCaPem,
      ).validate();
      await store.forgeConnections.upsert({
        ...existing,
        label: body.data.label ?? existing.label,
        customCaPem: customCaPem ?? null,
        personalToken: token,
        githubAppId: null,
        githubAppInstallationId: null,
        githubAppPrivateKey: null,
      });
      return store.forgeConnections.get(id);
    } catch (error) {
      return failure(reply, error);
    }
  });
  app.delete('/connections/:id', async (request, reply) => {
    if (!(await authorize(request, reply))) return;
    const { id } = request.params as { id: string };
    const existing = await store.forgeConnections.get(id);
    if (!existing) return reply.code(404).send({ error: 'connection not found' });
    if (existing.provider !== 'forgejo')
      return reply.code(409).send({ error: 'use GitHub configuration' });
    try {
      await store.forgeConnections.delete(id);
      return reply.code(204).send();
    } catch {
      return reply.code(409).send({ error: 'connection is in use' });
    }
  });
  app.get('/connections/:id/repositories', async (request, reply) => {
    if (!(await authorize(request, reply))) return;
    const { id } = request.params as { id: string };
    const connection = await store.forgeConnections.get(id);
    if (!connection) return reply.code(404).send({ error: 'connection not found' });
    if (connection.provider !== 'forgejo') return { repositories: await githubRepositories() };
    try {
      const transport = new ForgejoTransport(
        connection.baseUrl,
        async () => (await store.forgeConnections.credentials(id))?.personalToken ?? undefined,
        connection.customCaPem,
      );
      return { repositories: await transport.repositories() };
    } catch (error) {
      return failure(reply, error);
    }
  });
}
