import type { FastifyInstance } from 'fastify';
import {
  AmbiguousDopplerConnectionError,
  DopplerBindingsChangedError,
  type EventStore,
} from '@verity/store';
import { z } from 'zod';
import './fastify-augmentation.js';
import { viewerId } from './view-state-routes.js';

type DopplerConnectionStore = Pick<
  EventStore,
  | 'userDopplerConnections'
  | 'projectDopplerBindings'
  | 'isActiveAdministrator'
  | 'dopplerConnections'
>;

const params = z.object({ id: z.string().min(1).max(200) }).strict();
const body = z
  .object({
    token: z.string().trim().min(1).max(4096),
    connectionId: z.string().min(1).max(200).optional(),
  })
  .strict();
const query = z.object({ connectionId: z.string().min(1).max(200).optional() }).strict();

/**
 * A person's own Doppler tokens for one project, one per Doppler connection its
 * bindings use (ADR 0023 §3, ADR 0031). Every route acts for the signed-in person
 * only: no user id is taken from the request, and the token never leaves the
 * store. Project membership with execute permission is enforced by the route
 * policy. Older clients may omit the connection id when the project uses one connection.
 */
export function registerDopplerConnectionRoutes(
  app: FastifyInstance,
  deps: {
    store: DopplerConnectionStore;
    /** Lists a bound config's secret names with the given token, proving it reads them. */
    listNames: (input: {
      dopplerProject: string;
      dopplerConfig: string;
      token: Uint8Array;
    }) => Promise<string[]>;
  },
): void {
  const view = async (userId: string, projectId: string) => {
    const [bindings, statuses, administrator] = await Promise.all([
      deps.store.projectDopplerBindings.list(projectId),
      deps.store.userDopplerConnections.statuses(userId, projectId),
      deps.store.isActiveAdministrator(userId),
    ]);
    const instanceTokens = new Set(
      administrator
        ? (await deps.store.dopplerConnections.list())
            .filter((connection) => connection.hasToken)
            .map(({ id }) => id)
        : [],
    );
    const connections = new Map<
      string,
      {
        connectionId: string;
        label: string;
        bindings: string[];
        connected: boolean;
        needsValidation: boolean;
        updatedAt: string | null;
        usesInstanceToken: boolean;
      }
    >();
    for (const binding of bindings) {
      const status = statuses.get(binding.connectionId);
      const entry = connections.get(binding.connectionId) ?? {
        connectionId: binding.connectionId,
        label: binding.connectionLabel,
        bindings: [],
        connected: status !== undefined,
        needsValidation: false,
        updatedAt: status?.updatedAt.toISOString() ?? null,
        // Without a token of their own, the administrator's turns keep using the
        // connection's instance token, which is theirs; nobody else's ever do.
        usesInstanceToken: status === undefined && instanceTokens.has(binding.connectionId),
      };
      if (status !== undefined && binding.createdAt.getTime() > status.updatedAt.getTime())
        entry.needsValidation = true;
      entry.bindings.push(`${binding.dopplerProject}/${binding.dopplerConfig}`);
      connections.set(binding.connectionId, entry);
    }
    const fallback = bindings.find((binding) => binding.isDefault);
    const primary = fallback === undefined ? undefined : connections.get(fallback.connectionId);
    return {
      canManageBindings: administrator,
      connections: [...connections.values()],
      // The default binding's connection, as clients for a single binding read it.
      connected: primary?.connected ?? false,
      updatedAt: primary?.updatedAt ?? null,
      binding:
        fallback === undefined
          ? null
          : { dopplerProject: fallback.dopplerProject, dopplerConfig: fallback.dopplerConfig },
      usesInstanceToken: primary?.usesInstanceToken ?? false,
    };
  };
  const connectionFor = async (projectId: string, connectionId: string | undefined) => {
    const bindings = await deps.store.projectDopplerBindings.list(projectId);
    if (
      connectionId === undefined &&
      new Set(bindings.map((binding) => binding.connectionId)).size > 1
    )
      return { error: new AmbiguousDopplerConnectionError().message };
    const id = connectionId ?? bindings.find((binding) => binding.isDefault)?.connectionId;
    return {
      connectionId: id,
      bindings: bindings.filter((binding) => binding.connectionId === id),
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
    const target = await connectionFor(projectId, input.data.connectionId);
    if ('error' in target) return reply.code(409).send({ error: target.error });
    const { connectionId, bindings } = target;
    if (connectionId === undefined || bindings.length === 0)
      return reply
        .code(409)
        .send({ error: 'this project has no Doppler config on that connection to connect to' });
    // The token must read every config the project binds on this connection.
    for (const bound of bindings) {
      const token = Buffer.from(input.data.token, 'utf8');
      try {
        await deps.listNames({ ...bound, token });
      } catch {
        return reply.code(400).send({
          error: `this token cannot read the Doppler config ${bound.dopplerProject}/${bound.dopplerConfig}; use a token for that config`,
        });
      } finally {
        token.fill(0);
      }
    }
    const userId = viewerId(request);
    try {
      await deps.store.userDopplerConnections.set(
        userId,
        projectId,
        connectionId,
        input.data.token,
        bindings.map(({ id }) => id),
        bindings[0]?.tokenRevision ?? null,
      );
    } catch (error) {
      if (error instanceof DopplerBindingsChangedError)
        return reply.code(409).send({ error: error.message });
      throw error;
    }
    reply.header('cache-control', 'no-store');
    return view(userId, projectId);
  });

  app.delete('/projects/:id/doppler/connection', async (request, reply) => {
    const parsed = params.safeParse(request.params);
    const filter = query.safeParse(request.query ?? {});
    if (!parsed.success || !filter.success)
      return reply.code(400).send({ error: 'invalid project id' });
    const target = await connectionFor(parsed.data.id, filter.data.connectionId);
    if ('error' in target) return reply.code(409).send({ error: target.error });
    const { connectionId } = target;
    if (connectionId !== undefined)
      await deps.store.userDopplerConnections.delete(
        viewerId(request),
        parsed.data.id,
        connectionId,
      );
    return reply.code(204).send();
  });
}
