import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { sessionParams } from './session-route-schemas.js';

const sessionFileQuery = z.object({
  path: z.string().optional().default(''),
});

const sessionFileUploadQuery = z.object({
  path: z.string().default(''),
  fileName: z
    .string()
    .min(1)
    .max(255)
    .refine(
      (name) =>
        name !== '.' &&
        name !== '..' &&
        !/[\0\\/]/.test(name) &&
        Buffer.byteLength(name, 'utf8') <= 255,
      'invalid file name',
    ),
});

type SessionFileUploadQuery = z.infer<typeof sessionFileUploadQuery>;

export interface SessionFileRouteDeps {
  getWorktree: (sessionId: string) => Promise<string | undefined>;
  list: (reply: FastifyReply, worktree: string, path: string) => Promise<unknown>;
  upload: (
    request: FastifyRequest,
    reply: FastifyReply,
    sessionId: string,
    query: SessionFileUploadQuery,
  ) => Promise<unknown>;
  content: (reply: FastifyReply, worktree: string, path: string) => Promise<unknown>;
  download: (reply: FastifyReply, worktree: string, path: string) => Promise<unknown>;
}

/** Registers worktree file browsing, upload, preview, and download routes. */
export function registerSessionFileRoutes(app: FastifyInstance, deps: SessionFileRouteDeps): void {
  const worktree = async (id: string, reply: FastifyReply): Promise<string | undefined> => {
    const value = await deps.getWorktree(id);
    if (value === undefined) {
      reply.code(404).send({ error: `session ${id} not found` });
    }
    return value;
  };

  app.get('/sessions/:id/files', async (request, reply): Promise<unknown> => {
    const { id } = sessionParams.parse(request.params);
    const { path } = sessionFileQuery.parse(request.query);
    const value = await worktree(id, reply);
    if (value === undefined) return reply;
    return deps.list(reply, value, path);
  });

  app.post('/sessions/:id/files', async (request, reply): Promise<unknown> => {
    const { id } = sessionParams.parse(request.params);
    const query = sessionFileUploadQuery.parse(request.query);
    return deps.upload(request, reply, id, query);
  });

  app.get('/sessions/:id/files/content', async (request, reply): Promise<unknown> => {
    const { id } = sessionParams.parse(request.params);
    const { path } = sessionFileQuery.parse(request.query);
    const value = await worktree(id, reply);
    if (value === undefined) return reply;
    return deps.content(reply, value, path);
  });

  app.get('/sessions/:id/files/download', async (request, reply): Promise<unknown> => {
    const { id } = sessionParams.parse(request.params);
    const { path } = sessionFileQuery.parse(request.query);
    const value = await worktree(id, reply);
    if (value === undefined) return reply;
    return deps.download(reply, value, path);
  });
}
