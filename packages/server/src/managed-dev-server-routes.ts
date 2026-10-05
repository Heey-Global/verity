import type { EventStore } from '@verity/store';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { bearerToken } from './auth.js';
import type { GhTokenCapabilityRegistry } from './github-token-broker.js';
import { internalConnectionIdentity } from './internal-listener.js';
import {
  ManagedDevServerError,
  type ManagedDevServerManager,
  type ManagedServerView,
} from './managed-dev-server-manager.js';

const sessionParams = z.object({ sessionId: z.string().min(1) });
const serverParams = sessionParams.extend({ serverId: z.string().min(1) });

async function respond<T>(reply: FastifyReply, operation: () => Promise<T>): Promise<T | void> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof z.ZodError) return reply.code(400).send({ error: error.message });
    if (error instanceof ManagedDevServerError)
      return reply.code(error.statusCode).send({ error: error.message });
    throw error;
  }
}

/** The Preview sheet's view of the agent-configured servers (concept 2.6). */
export function registerManagedDevServerRoutes(
  app: FastifyInstance,
  deps: { manager?: ManagedDevServerManager | undefined },
): void {
  const manager = (reply: FastifyReply) => {
    if (!deps.manager) {
      void reply.code(503).send({ error: 'managed dev servers are unavailable' });
      return undefined;
    }
    return deps.manager;
  };
  app.get('/sessions/:sessionId/managed-dev-servers', async (request, reply) => {
    const m = manager(reply);
    if (!m) return;
    return respond(reply, async () => ({
      servers: await m.view(sessionParams.parse(request.params).sessionId),
    }));
  });
  const lifecycle =
    (action: 'start' | 'stop' | 'restart') =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      const m = manager(reply);
      if (!m) return;
      return respond(reply, async () => {
        const { sessionId, serverId } = serverParams.parse(request.params);
        const server =
          action === 'stop'
            ? await m.stop(sessionId, serverId)
            : action === 'restart'
              ? await m.restart(sessionId, serverId, 'operator')
              : await m.start(sessionId, serverId, 'operator');
        return { server };
      });
    };
  // Spelled out: the route-scope scan reads literal paths only.
  app.post('/sessions/:sessionId/managed-dev-servers/:serverId/start', lifecycle('start'));
  app.post('/sessions/:sessionId/managed-dev-servers/:serverId/stop', lifecycle('stop'));
  app.post('/sessions/:sessionId/managed-dev-servers/:serverId/restart', lifecycle('restart'));
  app.post('/sessions/:sessionId/managed-dev-servers/:serverId/approve', async (request, reply) => {
    const m = manager(reply);
    if (!m) return;
    return respond(reply, async () => {
      const { sessionId, serverId } = serverParams.parse(request.params);
      const seen = z
        .object({ command: z.string().min(1), workdir: z.string().min(1) })
        .strict()
        .parse(request.body);
      return { servers: await m.approve(sessionId, serverId, seen) };
    });
  });
  app.get('/sessions/:sessionId/managed-dev-servers/:serverId/logs', async (request, reply) => {
    const m = manager(reply);
    if (!m) return;
    return respond(reply, async () => {
      const { sessionId, serverId } = serverParams.parse(request.params);
      return { logs: await m.logs(sessionId, serverId) };
    });
  });
  app.delete('/sessions/:sessionId/managed-dev-servers/:serverId', async (request, reply) => {
    const m = manager(reply);
    if (!m) return;
    return respond(reply, async () => {
      const { sessionId, serverId } = serverParams.parse(request.params);
      await m.remove(sessionId, serverId);
      return reply.code(204).send();
    });
  });
  app.post(
    '/sessions/:sessionId/managed-dev-server-instances/:instanceId/stop',
    async (request, reply) => {
      const m = manager(reply);
      if (!m) return;
      return respond(reply, async () => {
        const { sessionId, instanceId } = sessionParams
          .extend({ instanceId: z.string().min(1) })
          .parse(request.params);
        return { servers: await m.stopElsewhere(sessionId, instanceId) };
      });
    },
  );
}

const agentBody = z
  .object({
    action: z.enum([
      'list',
      'add',
      'update',
      'remove',
      'start',
      'stop',
      'restart',
      'status',
      'logs',
    ]),
    sessionId: z.string().min(1),
    name: z.string().min(1).optional(),
    newName: z.string().min(1).optional(),
    command: z.string().min(1).optional(),
    workdir: z.string().optional(),
  })
  .strict()
  .refine((value) => value.action === 'list' || value.name !== undefined, 'name is required')
  .refine((value) => value.action !== 'add' || value.command !== undefined, 'command is required');

/** One line the agent can repeat to the operator. Never names a sandbox port. */
export function describeForAgent(server: ManagedServerView): string {
  const instance = server.instance;
  if (!instance || instance.state === 'stopped') return `${server.name}: stopped`;
  if (instance.state === 'crashed')
    return `${server.name}: crashed. ${instance.detail ?? ''} Read the output with: verity-dev-server logs "${server.name}"`.trim();
  if (instance.state === 'starting') return `${server.name}: starting`;
  if (instance.url) return `${server.name}: running at ${instance.url}`;
  if (instance.awaitingApproval)
    return `${server.name}: running, not shared yet: tap Open on network in the Preview list`;
  return `${server.name}: running${instance.detail ? `. ${instance.detail}` : ''}`;
}

/**
 * `POST /internal/dev-servers`, called by the sandbox's `verity-dev-server`. Like
 * the memory broker it authenticates with the per-container capability and binds
 * to the project that capability resolves to; the session id in the body is only
 * attribution and must belong to that project.
 */
export function registerManagedDevServerAgentRoute(
  app: FastifyInstance,
  deps: {
    manager?: ManagedDevServerManager | undefined;
    capabilities?: GhTokenCapabilityRegistry | undefined;
    eventStore: EventStore;
  },
): void {
  if (deps.capabilities === undefined) return;
  const capabilities = deps.capabilities;
  app.post('/internal/dev-servers', async (request, reply) => {
    const presented = bearerToken(request.headers.authorization) ?? '';
    const binding = presented === '' ? undefined : await capabilities.resolve(presented);
    const socket = internalConnectionIdentity(request);
    if (
      binding === undefined ||
      socket === undefined ||
      socket.projectId !== binding.projectId ||
      socket.containerGeneration !== binding.containerGeneration
    )
      return reply.code(401).send({ error: 'unauthorized' });
    if (!deps.manager)
      return reply.code(503).send({ error: 'managed dev servers are unavailable on this server' });
    const m = deps.manager;
    return respond(reply, async () => {
      const body = agentBody.parse(request.body);
      const session = await deps.eventStore.getSession(body.sessionId);
      if (!session || session.projectId !== binding.projectId)
        return reply.code(404).send({ error: 'session not found in this project' });
      const name = body.name ?? '';
      switch (body.action) {
        case 'list': {
          const servers = await m.view(body.sessionId);
          return {
            servers: servers.map((server) => ({
              name: server.name,
              command: server.command,
              workdir: server.workdir,
              status: describeForAgent(server),
            })),
          };
        }
        case 'add': {
          const created = await m.add(body.sessionId, {
            name,
            command: body.command ?? '',
            workdir: body.workdir,
          });
          return {
            message: `Added ${created.name}. Start it with: verity-dev-server start "${created.name}"`,
          };
        }
        case 'update': {
          const updated = await m.update(body.sessionId, name, {
            name: body.newName,
            command: body.command,
            workdir: body.workdir,
          });
          return {
            message: `Updated ${updated.name}. A running instance keeps its old command until restarted, and the operator must approve the new command again.`,
          };
        }
        case 'remove':
          await m.remove(body.sessionId, name);
          return { message: `Removed ${name}.` };
        case 'start':
          return { server: describeForAgent(await m.start(body.sessionId, name, 'agent')) };
        case 'restart':
          return { server: describeForAgent(await m.restart(body.sessionId, name, 'agent')) };
        case 'stop':
          return { server: describeForAgent(await m.stop(body.sessionId, name)) };
        case 'status': {
          const server = (await m.view(body.sessionId)).find(
            (value) => value.name.toLowerCase() === name.toLowerCase() || value.id === name,
          );
          if (!server) return reply.code(404).send({ error: `no server named "${name}"` });
          return {
            server: describeForAgent(server),
            state: server.instance?.state ?? 'stopped',
          };
        }
        case 'logs':
          return { logs: await m.logs(body.sessionId, name) };
      }
    });
  });
}
