import type { FastifyInstance } from 'fastify';
import {
  DuplicateDopplerBindingError,
  SealedError,
  UnknownDopplerConnectionError,
  type EventStore,
  type ProjectDopplerBindingRecord,
} from '@verity/store';
import { z } from 'zod';

const projectParams = z.object({ id: z.string().min(1).max(200) }).strict();
const bindingParams = z
  .object({ id: z.string().min(1).max(200), bindingId: z.string().min(1).max(200) })
  .strict();
const slug = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u);
const addBody = z
  .object({ connectionId: z.string().min(1).max(200), dopplerProject: slug, dopplerConfig: slug })
  .strict();
const patchBody = z.object({ isDefault: z.literal(true) }).strict();

export interface DopplerBindingRouteContext {
  store: Pick<EventStore, 'getProject' | 'projectDopplerBindings' | 'dopplerConnections'>;
  /** Lists a config's secret names with a token, proving the token reads it. */
  listNames(input: {
    dopplerProject: string;
    dopplerConfig: string;
    token: Uint8Array;
  }): Promise<string[]>;
  /** Whether the store is sealed, so a connection's token cannot be read. */
  isSealed?: () => boolean;
}

function view(binding: ProjectDopplerBindingRecord) {
  return {
    id: binding.id,
    connectionId: binding.connectionId,
    connectionLabel: binding.connectionLabel,
    dopplerProject: binding.dopplerProject,
    dopplerConfig: binding.dopplerConfig,
    isDefault: binding.isDefault,
    // How agents address the binding's secrets (ADR 0031).
    reference: `${binding.dopplerProject}/${binding.dopplerConfig}`,
    createdAt: binding.createdAt.toISOString(),
  };
}

/**
 * A project's Doppler bindings (ADR 0031): any Doppler project and config from any
 * of the instance's connections, one of them the default. Reading them needs read
 * permission on the project; changing them stays with administrators, since adding
 * one reads Doppler with the connection's instance token.
 */
export function installDopplerBindings(app: FastifyInstance, ctx: DopplerBindingRouteContext) {
  const list = async (projectId: string) =>
    (await ctx.store.projectDopplerBindings.list(projectId)).map(view);

  app.get('/projects/:id/doppler/bindings', async (request, reply) => {
    const params = projectParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'invalid project id' });
    if ((await ctx.store.getProject(params.data.id)) === undefined)
      return reply.code(404).send({ error: 'project not found' });
    return { bindings: await list(params.data.id) };
  });

  app.post('/projects/:id/doppler/bindings', async (request, reply) => {
    const params = projectParams.safeParse(request.params);
    const input = addBody.safeParse(request.body);
    if (!params.success || !input.success)
      return reply.code(400).send({ error: 'invalid Doppler binding' });
    const projectId = params.data.id;
    if ((await ctx.store.getProject(projectId)) === undefined)
      return reply.code(404).send({ error: 'project not found' });
    const connection = await ctx.store.dopplerConnections.get(input.data.connectionId);
    if (connection === undefined)
      return reply.code(404).send({ error: 'Doppler connection not found' });
    // A connection with an instance token must be able to read what it is bound to.
    if (connection.hasToken) {
      if (ctx.isSealed?.() === true) throw new SealedError();
      const token = await ctx.store.dopplerConnections.tokenBytes(connection.id);
      try {
        if (token !== undefined)
          await ctx.listNames({
            dopplerProject: input.data.dopplerProject,
            dopplerConfig: input.data.dopplerConfig,
            token,
          });
      } catch {
        return reply.code(400).send({
          error: `${connection.label} cannot read the Doppler config ${input.data.dopplerProject}/${input.data.dopplerConfig}`,
        });
      } finally {
        token?.fill(0);
      }
    }
    try {
      const added = await ctx.store.projectDopplerBindings.add(projectId, input.data);
      reply.code(201);
      return view(added);
    } catch (error) {
      if (error instanceof DuplicateDopplerBindingError)
        return reply.code(409).send({ error: error.message });
      if (error instanceof UnknownDopplerConnectionError)
        return reply.code(404).send({ error: error.message });
      throw error;
    }
  });

  app.patch('/projects/:id/doppler/bindings/:bindingId', async (request, reply) => {
    const params = bindingParams.safeParse(request.params);
    const input = patchBody.safeParse(request.body);
    if (!params.success || !input.success)
      return reply.code(400).send({ error: 'invalid Doppler binding' });
    if (!(await ctx.store.projectDopplerBindings.setDefault(params.data.id, params.data.bindingId)))
      return reply.code(404).send({ error: 'Doppler binding not found' });
    return { bindings: await list(params.data.id) };
  });

  app.delete('/projects/:id/doppler/bindings/:bindingId', async (request, reply) => {
    const params = bindingParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'invalid Doppler binding' });
    if (!(await ctx.store.projectDopplerBindings.remove(params.data.id, params.data.bindingId)))
      return reply.code(404).send({ error: 'Doppler binding not found' });
    return reply.code(204).send();
  });
}
