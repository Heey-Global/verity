import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { SESSION_FILE_ROOTS, isKnowledgeRoot, type SessionFileRootName } from './session-files.js';
import { sessionParams } from './session-route-schemas.js';

/** Which of the explorer's roots a request addresses. Omitted → the worktree, so
 *  every pre-knowledge client keeps browsing exactly what it browsed before. */
const sessionFileRoot = z.enum(SESSION_FILE_ROOTS).default('worktree');

const sessionFileQuery = z.object({
  root: sessionFileRoot,
  path: z.string().optional().default(''),
});

const fileName = z
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
  );

const sessionFileUploadQuery = z.object({
  root: sessionFileRoot,
  path: z.string().default(''),
  fileName,
});

const sessionFileDeleteQuery = z.object({
  root: sessionFileRoot,
  path: z.string().min(1),
});

const sessionFileMoveBody = z.object({
  root: sessionFileRoot,
  path: z.string().min(1),
  toRoot: sessionFileRoot,
  toPath: z.string().default(''),
  toFileName: fileName.optional(),
});

type SessionFileUploadQuery = z.infer<typeof sessionFileUploadQuery>;
type SessionFileMoveBody = z.infer<typeof sessionFileMoveBody>;

/** A resolved explorer root: the directory on disk plus the name it was reached
 *  by, which decides what is hidden from a listing and what may be written. */
export interface SessionFileTarget {
  root: SessionFileRootName;
  dir: string;
}

export interface SessionFileRouteDeps {
  /** The directory backing `root` for this session, or `undefined` when the
   *  session does not exist — or, for a knowledge root, when the session has no
   *  project or the deployment has no knowledge folder configured. */
  resolveRoot: (sessionId: string, root: SessionFileRootName) => Promise<string | undefined>;
  list: (reply: FastifyReply, target: SessionFileTarget, path: string) => Promise<unknown>;
  upload: (
    request: FastifyRequest,
    reply: FastifyReply,
    target: SessionFileTarget,
    query: SessionFileUploadQuery,
  ) => Promise<unknown>;
  content: (reply: FastifyReply, target: SessionFileTarget, path: string) => Promise<unknown>;
  download: (reply: FastifyReply, target: SessionFileTarget, path: string) => Promise<unknown>;
  remove: (reply: FastifyReply, target: SessionFileTarget, path: string) => Promise<unknown>;
  move: (
    reply: FastifyReply,
    from: SessionFileTarget,
    to: SessionFileTarget,
    body: SessionFileMoveBody,
  ) => Promise<unknown>;
}

/** Registers file browsing, upload, preview, download, delete, and move routes
 *  over the session's worktree and the project's knowledge folders. */
export function registerSessionFileRoutes(app: FastifyInstance, deps: SessionFileRouteDeps): void {
  const target = async (
    id: string,
    root: SessionFileRootName,
    reply: FastifyReply,
  ): Promise<SessionFileTarget | undefined> => {
    const dir = await deps.resolveRoot(id, root);
    if (dir === undefined) {
      // A knowledge root is missing for more reasons than a missing session —
      // a session without a project, a deployment without a data root — and
      // "session not found" would send the operator looking for the wrong fault.
      reply.code(404).send({
        error: isKnowledgeRoot(root)
          ? 'this session has no knowledge folder'
          : `session ${id} not found`,
      });
      return undefined;
    }
    return { root, dir };
  };

  /** Deleting and moving are knowledge-folder actions (ADR 0022 D2). The
   *  worktree belongs to the agent and to git, which already have their own
   *  ways to remove a file; the explorer must not grow a second one. */
  const knowledgeOnly = (root: SessionFileRootName, reply: FastifyReply): boolean => {
    if (isKnowledgeRoot(root)) return true;
    reply.code(400).send({ error: 'only knowledge files can be changed this way' });
    return false;
  };

  app.get('/sessions/:id/files', async (request, reply): Promise<unknown> => {
    const { id } = sessionParams.parse(request.params);
    const { root, path } = sessionFileQuery.parse(request.query);
    const value = await target(id, root, reply);
    if (value === undefined) return reply;
    return deps.list(reply, value, path);
  });

  app.post('/sessions/:id/files', async (request, reply): Promise<unknown> => {
    const { id } = sessionParams.parse(request.params);
    const query = sessionFileUploadQuery.parse(request.query);
    const value = await target(id, query.root, reply);
    if (value === undefined) return reply;
    return deps.upload(request, reply, value, query);
  });

  app.get('/sessions/:id/files/content', async (request, reply): Promise<unknown> => {
    const { id } = sessionParams.parse(request.params);
    const { root, path } = sessionFileQuery.parse(request.query);
    const value = await target(id, root, reply);
    if (value === undefined) return reply;
    return deps.content(reply, value, path);
  });

  app.get('/sessions/:id/files/download', async (request, reply): Promise<unknown> => {
    const { id } = sessionParams.parse(request.params);
    const { root, path } = sessionFileQuery.parse(request.query);
    const value = await target(id, root, reply);
    if (value === undefined) return reply;
    return deps.download(reply, value, path);
  });

  app.delete('/sessions/:id/files', async (request, reply): Promise<unknown> => {
    const { id } = sessionParams.parse(request.params);
    const { root, path } = sessionFileDeleteQuery.parse(request.query);
    if (!knowledgeOnly(root, reply)) return reply;
    const value = await target(id, root, reply);
    if (value === undefined) return reply;
    return deps.remove(reply, value, path);
  });

  app.post('/sessions/:id/files/move', async (request, reply): Promise<unknown> => {
    const { id } = sessionParams.parse(request.params);
    const body = sessionFileMoveBody.parse(request.body);
    if (!knowledgeOnly(body.root, reply) || !knowledgeOnly(body.toRoot, reply)) return reply;
    const from = await target(id, body.root, reply);
    if (from === undefined) return reply;
    const to = await target(id, body.toRoot, reply);
    if (to === undefined) return reply;
    return deps.move(reply, from, to, body);
  });
}
