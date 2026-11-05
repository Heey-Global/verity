import { join } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { SESSION_FILE_ROOTS, isKnowledgeRoot, type SessionFileRootName } from './session-files.js';
import { sessionParams } from './session-route-schemas.js';

/** Which of the explorer's roots a request addresses. Omitted → the worktree, so
 *  every pre-knowledge client keeps browsing exactly what it browsed before. */
const sessionFileRoot = z
  .enum([...SESSION_FILE_ROOTS, 'wiki', 'raw-sources'])
  .default('worktree')
  .transform((root): SessionFileRootName =>
    root === 'wiki' ? 'documents' : root === 'raw-sources' ? 'sources' : root,
  );

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

const sessionFileWriteBody = z.object({
  root: sessionFileRoot,
  path: z.string().min(1),
  content: z.string().max(1_000_000),
  expectedVersion: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
});
type SessionFileWriteBody = z.infer<typeof sessionFileWriteBody>;

type SessionFileUploadQuery = z.infer<typeof sessionFileUploadQuery>;
type SessionFileMoveBody = z.infer<typeof sessionFileMoveBody>;

/** A resolved explorer root: the directory on disk plus the name it was reached
 *  by, which decides what is hidden from a listing and what may be written. */
interface SessionFileTarget {
  root: SessionFileRootName;
  dir: string;
}

export class SessionFileRootUnavailableError extends Error {
  constructor(
    message: string,
    readonly status: 404 | 503,
  ) {
    super(message);
  }
}

export interface SessionFileRouteDeps {
  resolveProjectRoot?: (projectId: string) => Promise<string | undefined>;
  resolveSharedRoot?: () => Promise<string | undefined>;
  documentStatus?:
    | ((sessionId: string) => Promise<
        | {
            pending: boolean;
            running: boolean;
            warning?: string;
            inspectionError?: boolean;
            excludedEntries?: { path: string; reason: 'generated' | 'unsupported' }[];
          }
        | undefined
      >)
    | undefined;
  /** The directory backing `root` for this session, or `undefined` when the
   *  session does not exist — or, for a knowledge root, when the session has no
   *  project or the deployment has no knowledge folder configured. */
  codeAvailable?: ((sessionId: string) => Promise<boolean>) | undefined;
  workspaceKind?: ((sessionId: string) => Promise<'documents' | 'code'>) | undefined;
  resolveRoot: (sessionId: string, root: SessionFileRootName) => Promise<string | undefined>;
  list: (reply: FastifyReply, target: SessionFileTarget, path: string) => Promise<unknown>;
  upload: (
    request: FastifyRequest,
    reply: FastifyReply,
    target: SessionFileTarget,
    query: SessionFileUploadQuery,
  ) => Promise<unknown>;
  history: (
    reply: FastifyReply,
    target: SessionFileTarget,
    path: string,
    version?: string,
  ) => Promise<unknown>;
  content: (reply: FastifyReply, target: SessionFileTarget, path: string) => Promise<unknown>;
  write: (
    reply: FastifyReply,
    target: SessionFileTarget,
    body: SessionFileWriteBody,
  ) => Promise<unknown>;
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
  // Resolve writes relative to Wiki itself so intermediate symlinks cannot reach Sources.
  const writeWiki = async (
    reply: FastifyReply,
    target: SessionFileTarget,
    body: SessionFileWriteBody,
  ) => {
    const result = await deps.write(
      reply,
      { root: 'documents', dir: join(target.dir, 'insights') },
      {
        ...body,
        root: 'documents',
        path: body.path.slice('insights/'.length),
      },
    );
    return result && typeof result === 'object' && 'path' in result
      ? { ...result, path: body.path }
      : result;
  };
  const resolveProjectRoot = deps.resolveProjectRoot;
  if (resolveProjectRoot) {
    const projectTarget = async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = sessionParams.parse(request.params);
      const dir = await resolveProjectRoot(id);
      if (!dir) {
        reply.code(404).send({ error: 'Project knowledge not found' });
        return undefined;
      }
      return { root: 'knowledge' as const, dir };
    };
    const wikiPath = (path: string) =>
      path.startsWith('insights/') && !path.replaceAll('\\', '/').split('/').includes('..');
    app.get('/projects/:id/knowledge/files', async (request, reply) => {
      const { path } = sessionFileQuery.parse(request.query);
      const target = await projectTarget(request, reply);
      return target ? deps.list(reply, target, path) : reply;
    });
    app.get('/projects/:id/knowledge/files/content', async (request, reply) => {
      const { path } = sessionFileQuery.parse(request.query);
      const target = await projectTarget(request, reply);
      if (!target) return reply;
      const content = await deps.content(reply, target, path);
      return content && typeof content === 'object' && 'editable' in content
        ? { ...content, editable: wikiPath(path) && content.editable }
        : content;
    });
    app.get('/projects/:id/knowledge/files/download', async (request, reply) => {
      const { path } = sessionFileQuery.parse(request.query);
      const target = await projectTarget(request, reply);
      return target ? deps.download(reply, target, path) : reply;
    });
    app.put(
      '/projects/:id/knowledge/files/content',
      { bodyLimit: 6_100_000 },
      async (request, reply) => {
        const body = sessionFileWriteBody.parse(request.body);
        if (!wikiPath(body.path))
          return reply.code(403).send({ error: 'Only Wiki files can be edited here.' });
        const target = await projectTarget(request, reply);
        return target ? writeWiki(reply, target, body) : reply;
      },
    );
  }
  const resolveSharedRoot = deps.resolveSharedRoot;
  if (resolveSharedRoot) {
    const isSharedWikiPath = (path: string) =>
      path.startsWith('insights/') && !path.replaceAll('\\', '/').split('/').includes('..');
    const sharedTarget = async (reply: FastifyReply) => {
      const dir = await resolveSharedRoot();
      if (!dir) {
        reply.code(404).send({ error: 'Shared knowledge is not configured' });
        return undefined;
      }
      return { root: 'shared' as const, dir };
    };
    app.get('/knowledge/shared/files', async (request, reply) => {
      const { path } = sessionFileQuery.parse(request.query);
      const value = await sharedTarget(reply);
      return value ? deps.list(reply, value, path) : reply;
    });
    app.get('/knowledge/shared/files/content', async (request, reply) => {
      const { path } = sessionFileQuery.parse(request.query);
      const value = await sharedTarget(reply);
      if (!value) return reply;
      const content = await deps.content(reply, value, path);
      return content && typeof content === 'object' && 'editable' in content
        ? { ...content, editable: isSharedWikiPath(path) && content.editable }
        : content;
    });
    app.get('/knowledge/shared/files/download', async (request, reply) => {
      const { path } = sessionFileQuery.parse(request.query);
      const value = await sharedTarget(reply);
      return value ? deps.download(reply, value, path) : reply;
    });
    app.put('/knowledge/shared/files/content', { bodyLimit: 6_100_000 }, async (request, reply) => {
      const body = sessionFileWriteBody.parse(request.body);
      if (!isSharedWikiPath(body.path))
        return reply.code(403).send({ error: 'Only Shared Wiki files can be edited here.' });
      const value = await sharedTarget(reply);
      return value ? writeWiki(reply, value, body) : reply;
    });
  }

  const target = async (
    id: string,
    root: SessionFileRootName,
    reply: FastifyReply,
  ): Promise<SessionFileTarget | undefined> => {
    let dir: string | undefined;
    try {
      dir = await deps.resolveRoot(id, root);
    } catch (error) {
      if (!(error instanceof SessionFileRootUnavailableError)) throw error;
      reply.code(error.status).send({ error: error.message });
      return undefined;
    }
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

  /** Between the knowledge folders a move is a scope change; inside the worktree
   *  it can only be a rename or a reshuffle. Crossing between the worktree and a
   *  knowledge folder is neither — that is an import, with its own route. */
  const sameKind = (from: SessionFileRootName, to: SessionFileRootName, reply: FastifyReply) => {
    if (isKnowledgeRoot(from) === isKnowledgeRoot(to)) return true;
    reply.code(400).send({ error: 'only knowledge files can be changed this way' });
    return false;
  };

  app.get('/sessions/:id/files', async (request, reply): Promise<unknown> => {
    const { id } = sessionParams.parse(request.params);
    const { root, path } = sessionFileQuery.parse(request.query);
    const value = await target(id, root, reply);
    if (value === undefined) return reply;
    const listed = await deps.list(reply, value, path);
    return listed !== reply &&
      deps.workspaceKind &&
      listed &&
      typeof listed === 'object' &&
      'entries' in listed
      ? {
          ...listed,
          workspaceKind: await deps.workspaceKind(id),
          codeAvailable: await deps.codeAvailable?.(id),
          documentStatus: await deps.documentStatus?.(id),
        }
      : listed;
  });

  app.post('/sessions/:id/files', async (request, reply): Promise<unknown> => {
    const { id } = sessionParams.parse(request.params);
    const query = sessionFileUploadQuery.parse(request.query);
    if (query.root === 'drafts')
      return reply
        .code(403)
        .send({ error: 'Session drafts are read-only here; edit them in their session.' });
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

  app.get('/sessions/:id/files/history', async (request, reply): Promise<unknown> => {
    const { id } = sessionParams.parse(request.params);
    const { root, path, version } = sessionFileQuery
      .extend({
        version: z
          .string()
          .regex(/^save-[A-Za-z0-9]+\/(snapshot|original)$/)
          .optional(),
      })
      .parse(request.query);
    const value = await target(id, root, reply);
    if (value === undefined) return reply;
    return deps.history(reply, value, path, version);
  });

  app.put(
    '/sessions/:id/files/content',
    { bodyLimit: 6_100_000 },
    async (request, reply): Promise<unknown> => {
      const { id } = sessionParams.parse(request.params);
      const body = sessionFileWriteBody.parse(request.body);
      if (body.root === 'drafts' || body.root === 'sources')
        return reply.code(403).send({ error: 'This area is read-only.' });
      const value = await target(id, body.root, reply);
      if (value === undefined) return reply;
      return deps.write(reply, value, body);
    },
  );

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
    if (root === 'drafts')
      return reply
        .code(403)
        .send({ error: 'Session drafts are retained until explicitly resolved.' });
    const value = await target(id, root, reply);
    if (value === undefined) return reply;
    return deps.remove(reply, value, path);
  });

  app.post('/sessions/:id/files/move', async (request, reply): Promise<unknown> => {
    const { id } = sessionParams.parse(request.params);
    const body = sessionFileMoveBody.parse(request.body);
    if (body.root === 'drafts' || body.toRoot === 'drafts')
      return reply.code(403).send({ error: 'Session drafts are read-only here.' });
    if (!sameKind(body.root, body.toRoot, reply)) return reply;
    const from = await target(id, body.root, reply);
    if (from === undefined) return reply;
    const to = await target(id, body.toRoot, reply);
    if (to === undefined) return reply;
    return deps.move(reply, from, to, body);
  });
}
