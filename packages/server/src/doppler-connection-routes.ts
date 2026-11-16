import type { FastifyInstance } from 'fastify';
import type { EventStore } from '@verity/store';
import { z } from 'zod';
import './fastify-augmentation.js';
import { viewerId } from './view-state-routes.js';

type DopplerConnectionStore = Pick<
  EventStore,
  'userDopplerConnections' | 'getProjectSettings' | 'isActiveAdministrator'
>;

const params = z.object({ id: z.string().min(1).max(200) }).strict();
const body = z.object({ token: z.string().trim().min(1).max(4096) }).strict();

/**
 * A person's own Doppler token for one project (ADR 0023 §3). Every route acts for
 * the signed-in person only: no user id is taken from the request, and the token
 * never leaves the store. Project membership with execute permission is enforced
 * by the route policy.
 */
export function registerDopplerConnectionRoutes(
  app: FastifyInstance,
  deps: {
    store: DopplerConnectionStore;
    /** Lists the bound config's secret names with the given token, proving it reads them. */
    listNames: (input: {
      dopplerProject: string;
      dopplerConfig: string;
      token: Uint8Array;
    }) => Promise<string[]>;
  },
): void {
  const binding = async (projectId: string) => {
    const settings = await deps.store.getProjectSettings(projectId);
    const dopplerProject = settings?.dopplerProject?.trim();
    const dopplerConfig = settings?.dopplerConfig?.trim();
    return dopplerProject && dopplerConfig ? { dopplerProject, dopplerConfig } : undefined;
  };
  const view = async (userId: string, projectId: string) => {
    const [status, bound, administrator] = await Promise.all([
      deps.store.userDopplerConnections.status(userId, projectId),
      binding(projectId),
      deps.store.isActiveAdministrator(userId),
    ]);
    return {
      connected: status !== undefined,
      updatedAt: status?.updatedAt.toISOString() ?? null,
      binding: bound ?? null,
      // Without a connection of their own, the administrator's turns keep using
      // the instance token, which was theirs; nobody else's ever do.
      usesInstanceToken: status === undefined && administrator,
    };
  };

  app.get('/projects/:id/doppler/connection', async (request, reply) => {
    const parsed = params.safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid project id' });
    reply.header('cache-control', 'no-store');
    return view(viewerId(request), parsed.data.id);
  });

  app.put('/projects/:id/doppler/connection', async (request, reply) => {
    const parsed = params.safeParse(request.params);
    const input = body.safeParse(request.body);
    if (!parsed.success || !input.success)
      return reply.code(400).send({ error: 'invalid Doppler token' });
    const projectId = parsed.data.id;
    const bound = await binding(projectId);
    if (bound === undefined)
      return reply.code(409).send({ error: 'this project has no Doppler config to connect to' });
    const token = Buffer.from(input.data.token, 'utf8');
    try {
      await deps.listNames({ ...bound, token });
    } catch {
      return reply.code(400).send({
        error: `this token cannot read the Doppler config ${bound.dopplerProject}/${bound.dopplerConfig}; use a service token for that config`,
      });
    } finally {
      token.fill(0);
    }
    const userId = viewerId(request);
    await deps.store.userDopplerConnections.set(userId, projectId, input.data.token);
    reply.header('cache-control', 'no-store');
    return view(userId, projectId);
  });

  app.delete('/projects/:id/doppler/connection', async (request, reply) => {
    const parsed = params.safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid project id' });
    await deps.store.userDopplerConnections.delete(viewerId(request), parsed.data.id);
    return reply.code(204).send();
  });
}
