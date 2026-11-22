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

export const sessionFileQuery = z.object({
  root: sessionFileRoot,
  path: z.string().optional().default(''),
});

export const fileName = z
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

export const sessionFileDeleteQuery = z.object({
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

const sessionFolderBody = z.object({
  root: sessionFileRoot,
  path: z.string().default(''),
  name: fileName,
});

export const sessionFileWriteBody = z.object({
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
export interface SessionFileTarget {
  root: SessionFileRootName;
  dir: string;
  protectedPaths?: readonly string[];
  /** Whether new files and folders must stay writable for the sandbox agent, as
   *  a project's Wiki is. Unset, it follows from the root and path. */
  agentWritable?: boolean;
  /** Whether folders may move inside this knowledge root: only the knowledge
   *  routes set it, after their path rules (no Decisions, no import folders,
   *  one area) have passed. The worktree moves its folders freely. */
  folderMoves?: boolean;
}

/** Runs under the knowledge mutation lock right after an entry was renamed or
 *  moved, with both paths relative to the target's directory. */
export type RelocationHook = (move: { from: string; to: string }) => Promise<void>;

export class SessionFileRootUnavailableError extends Error {
  constructor(
    message: string,
    readonly status: 404 | 409 | 503,
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
  /** Whether the requester may change the code working copy by hand, which is
   *  part of the Code permission (ADR 0023 §1). Reading it stays with read: the
   *  agent shows its files in the conversation anyway. Absent → no restriction. */
  mayChangeCode?: ((request: FastifyRequest, sessionId: string) => Promise<boolean>) | undefined;
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
    afterMove?: RelocationHook,
  ) => Promise<unknown>;
  /** Creates an empty folder `name` inside `path`, never replacing an entry. */
  createFolder?: (
    reply: FastifyReply,
    target: SessionFileTarget,
    path: string,
    name: string,
  ) => Promise<unknown>;
  /** Gives a file or folder a new name in its own folder, never replacing one. */
  rename?: (
    reply: FastifyReply,
    target: SessionFileTarget,
    path: string,
    name: string,
    afterMove?: RelocationHook,
  ) => Promise<unknown>;
}

/** Registers file browsing, upload, preview, download, delete, and move routes
 *  over the session's worktree and the project's knowledge folders. The routes
 *  over a project's or Shared knowledge without a session live in
 *  `knowledge-file-routes.ts`. */
export function registerSessionFileRoutes(app: FastifyInstance, deps: SessionFileRouteDeps): void {
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

  /** False after refusing: changing the worktree by hand needs the Code permission. */
  const codeWritable = async (
    request: FastifyRequest,
    reply: FastifyReply,
    id: string,
    ...roots: SessionFileRootName[]
  ) => {
    if (!roots.includes('worktree') || deps.mayChangeCode === undefined) return true;
    if (await deps.mayChangeCode(request, id)) return true;
    reply.code(403).send({ error: 'Changing code files needs permission to work with code.' });
    return false;
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
    // Every listing reports a missing checkout, so a sheet opened on Documents still
    // offers the Code tab and its Restore instead of disabling it.
    const codeWorkspaceUnavailable =
      deps.workspaceKind !== undefined &&
      (await deps.resolveRoot(id, 'worktree').then(
        () => false,
        (error: unknown) =>
          error instanceof SessionFileRootUnavailableError && error.status === 409,
      ));
    if (root === 'worktree' && deps.workspaceKind) {
      // A missing checkout lists as empty and unavailable, so the client can offer to
      // restore it instead of showing an error or quietly switching to Documents.
      if (codeWorkspaceUnavailable)
        return {
          root,
          path: '',
          entries: [],
          truncated: false,
          workspaceKind: await deps.workspaceKind(id),
          codeAvailable: false,
          codeWorkspaceUnavailable: true,
          documentStatus: await deps.documentStatus?.(id),
        };
    }
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
          ...(codeWorkspaceUnavailable ? { codeWorkspaceUnavailable } : {}),
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
    if (!(await codeWritable(request, reply, id, query.root))) return reply;
    const value = await target(id, query.root, reply);
    if (value === undefined) return reply;
    return deps.upload(request, reply, value, query);
  });

  const createFolder = deps.createFolder;
  if (createFolder)
    app.post('/sessions/:id/files/folders', async (request, reply): Promise<unknown> => {
      const { id } = sessionParams.parse(request.params);
      const body = sessionFolderBody.parse(request.body);
      if (body.root === 'drafts')
        return reply
          .code(403)
          .send({ error: 'Session drafts are read-only here; edit them in their session.' });
      // Shared knowledge is managed by administrators from Settings; a session's
      // execute permission must not reach it through this route.
      if (body.root === 'shared')
        return reply
          .code(403)
          .send({ error: 'Shared knowledge is managed in Settings › Shared knowledge.' });
      if (!(await codeWritable(request, reply, id, body.root))) return reply;
      const value = await target(id, body.root, reply);
      if (value === undefined) return reply;
      return createFolder(reply, value, body.path, body.name);
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
      if (!(await codeWritable(request, reply, id, body.root))) return reply;
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
    if (!(await codeWritable(request, reply, id, root))) return reply;
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
    if (!(await codeWritable(request, reply, id, body.root, body.toRoot))) return reply;
    const from = await target(id, body.root, reply);
    if (from === undefined) return reply;
    const to = await target(id, body.toRoot, reply);
    if (to === undefined) return reply;
    return deps.move(reply, from, to, body);
  });
}
