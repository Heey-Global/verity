// The app's file management over knowledge without a session: a project's
// knowledge folder (`/projects/:id/knowledge/…`, project permissions) and Shared
// (`/knowledge/shared/…`, administrators). Both scopes offer the same calls under
// the same path rules (`knowledge-path-rules.ts`); a rename or move keeps the
// Wiki's links pointing at the right files (`knowledge-wiki-links.ts`).
import { join } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import {
  knowledgeChild,
  knowledgeContainer,
  knowledgeEntry,
  knowledgeMoveTarget,
  KnowledgePathRefusedError,
  type KnowledgeArea,
  type KnowledgeAreaPath,
} from './knowledge-path-rules.js';
import { projectWikiCatalog } from './knowledge-wiki.js';
import {
  knowledgeBacklinks,
  rewriteWikiLinksAfterMove,
  type WikiLinkCount,
} from './knowledge-wiki-links.js';
import { RECENT_SHARED_LIMIT_MAX, recentSharedKnowledge } from './shared-knowledge-recent.js';
import {
  fileName,
  sessionFileDeleteQuery,
  sessionFileQuery,
  sessionFileWriteBody,
  type RelocationHook,
  type SessionFileRouteDeps,
  type SessionFileTarget,
} from './session-file-routes.js';
import { sessionParams } from './session-route-schemas.js';

export type KnowledgeFileRouteDeps = Pick<
  SessionFileRouteDeps,
  | 'resolveProjectRoot'
  | 'resolveSharedRoot'
  | 'list'
  | 'content'
  | 'download'
  | 'write'
  | 'remove'
  | 'rename'
  | 'move'
  | 'upload'
  | 'createFolder'
>;

const renameBody = z.object({ path: z.string().min(1), name: fileName });
const moveBody = z.object({ path: z.string().min(1), toPath: z.string().min(1) });
const folderBody = z.object({ path: z.string().min(1), name: fileName });
const uploadQuery = z.object({ path: z.string().min(1), fileName });
const pathQuery = z.object({ path: z.string().min(1) });
const recentSharedQuery = z.object({
  limit: z.coerce.number().int().min(1).max(RECENT_SHARED_LIMIT_MAX).default(8),
});

/** One knowledge scope as a request resolved it. */
interface KnowledgeScope {
  kind: 'project' | 'shared';
  /** The scope's folder: `insights/` and `sources/` live directly inside. */
  dir: string;
}

type ScopeResolver = (
  request: FastifyRequest,
  reply: FastifyReply,
) => Promise<KnowledgeScope | undefined>;

/** Pages edited in the app: anything under the Wiki that does not climb out. */
const isWikiEditPath = (path: string) =>
  path.startsWith('insights/') && !path.replaceAll('\\', '/').split('/').includes('..');

/** The area folder an entry lives in, as the file operations address it. */
function areaTarget(scope: KnowledgeScope, area: KnowledgeArea): SessionFileTarget {
  return {
    root: area === 'insights' ? 'documents' : 'sources',
    dir: join(scope.dir, area),
    protectedPaths: area === 'insights' ? ['decisions'] : [],
    // The sandbox agent edits a project's Wiki; Shared and Sources are read-only to it.
    agentWritable: scope.kind === 'project' && area === 'insights',
    // The routes here check every path against the knowledge rules first.
    folderMoves: true,
  };
}

/** A result's area-relative `path` as the scope path the app addresses. */
function inArea(result: unknown, area: KnowledgeArea): unknown {
  if (!result || typeof result !== 'object' || !('path' in result)) return result;
  const path = String(result.path);
  return { ...result, path: path ? `${area}/${path}` : area };
}

function joinWarnings(...warnings: Array<string | undefined>): string | undefined {
  const present = warnings.filter((warning): warning is string => Boolean(warning));
  return present.length ? present.join(' ') : undefined;
}

/** The route handlers shared by both scopes, bound to how a request names its scope. */
function knowledgeHandlers(deps: KnowledgeFileRouteDeps, resolveScope: ScopeResolver) {
  /** Runs `use` with checked paths; a path the rules refuse answers 403. */
  const checked = async (reply: FastifyReply, use: () => Promise<unknown>): Promise<unknown> => {
    try {
      return await use();
    } catch (error) {
      if (!(error instanceof KnowledgePathRefusedError)) throw error;
      return reply.code(403).send({ error: error.message });
    }
  };

  /** Rewrites the Wiki's links once the move is on disk, under the same lock. */
  const linkKeeper = (scope: KnowledgeScope, area: KnowledgeArea) => {
    const outcome: { linksUpdated: WikiLinkCount[]; warning?: string } = { linksUpdated: [] };
    const hook: RelocationHook = async ({ from, to }) => {
      try {
        Object.assign(
          outcome,
          await rewriteWikiLinksAfterMove(scope.dir, {
            from: `${area}/${from}`,
            to: `${area}/${to}`,
          }),
        );
      } catch {
        outcome.warning = 'Moved. Links to it in other Wiki pages could not be updated.';
      }
    };
    return { outcome, hook };
  };

  /** The rename/move response: the new path, any warning, the pages whose links changed. */
  const relocated = (
    result: unknown,
    area: KnowledgeArea,
    outcome: ReturnType<typeof linkKeeper>['outcome'],
  ) => {
    if (!result || typeof result !== 'object' || !('path' in result)) return result;
    const warning = joinWarnings(
      'warning' in result && typeof result.warning === 'string' ? result.warning : undefined,
      outcome.warning,
    );
    return {
      path: (inArea({ path: result.path }, area) as { path: string }).path,
      ...(warning ? { warning } : {}),
      linksUpdated: outcome.linksUpdated,
    };
  };

  const writeWiki = (reply: FastifyReply, scope: KnowledgeScope, request: FastifyRequest) => {
    const body = sessionFileWriteBody.parse(request.body);
    if (!isWikiEditPath(body.path))
      return reply.code(403).send({ error: 'Only Wiki files can be edited here.' });
    // A new page is a new entry: it obeys the same rules as an upload or a new
    // folder, so nothing is created among the recorded decisions or under a
    // name Verity reserves.
    if (body.expectedVersion === null) {
      try {
        knowledgeEntry(body.path);
      } catch (error) {
        if (!(error instanceof KnowledgePathRefusedError)) throw error;
        return reply.code(403).send({ error: error.message });
      }
    }
    // Resolve relative to the Wiki itself so intermediate symlinks cannot reach Sources.
    return (
      deps
        // Editing an existing page keeps its old reach, recorded decisions included;
        // only creating a page is held to the new-entry rules above.
        .write(
          reply,
          { ...areaTarget(scope, 'insights'), protectedPaths: [] },
          {
            ...body,
            root: 'documents',
            path: body.path.slice('insights/'.length),
          },
        )
        .then((result) =>
          result && typeof result === 'object' && 'path' in result
            ? { ...result, path: body.path }
            : result,
        )
    );
  };

  return {
    list: async (request: FastifyRequest, reply: FastifyReply) => {
      const { path } = sessionFileQuery.parse(request.query);
      const scope = await resolveScope(request, reply);
      return scope ? deps.list(reply, scopeTarget(scope), path) : reply;
    },
    content: async (request: FastifyRequest, reply: FastifyReply) => {
      const { path } = sessionFileQuery.parse(request.query);
      const scope = await resolveScope(request, reply);
      if (!scope) return reply;
      const content = await deps.content(reply, scopeTarget(scope), path);
      return content && typeof content === 'object' && 'editable' in content
        ? { ...content, editable: isWikiEditPath(path) && content.editable }
        : content;
    },
    download: async (request: FastifyRequest, reply: FastifyReply) => {
      const { path } = sessionFileQuery.parse(request.query);
      const scope = await resolveScope(request, reply);
      return scope ? deps.download(reply, scopeTarget(scope), path) : reply;
    },
    write: async (request: FastifyRequest, reply: FastifyReply) => {
      const scope = await resolveScope(request, reply);
      return scope ? writeWiki(reply, scope, request) : reply;
    },
    remove: async (request: FastifyRequest, reply: FastifyReply) => {
      const { path } = sessionFileDeleteQuery.parse(request.query);
      return checked(reply, async () => {
        const entry = knowledgeEntry(path);
        const scope = await resolveScope(request, reply);
        if (!scope) return reply;
        return inArea(
          await deps.remove(reply, areaTarget(scope, entry.area), entry.rel),
          entry.area,
        );
      });
    },
    rename: async (request: FastifyRequest, reply: FastifyReply) => {
      const rename = deps.rename;
      const body = renameBody.parse(request.body);
      return checked(reply, async () => {
        const entry = knowledgeEntry(body.path);
        knowledgeChild(parentOf(entry), body.name);
        const scope = await resolveScope(request, reply);
        if (!scope) return reply;
        if (!rename) return reply.code(501).send({ error: 'Renaming is not available here.' });
        const links = linkKeeper(scope, entry.area);
        const result = await rename(
          reply,
          areaTarget(scope, entry.area),
          entry.rel,
          body.name,
          links.hook,
        );
        return relocated(result, entry.area, links.outcome);
      });
    },
    move: async (request: FastifyRequest, reply: FastifyReply) => {
      const body = moveBody.parse(request.body);
      return checked(reply, async () => {
        const entry = knowledgeEntry(body.path);
        knowledgeMoveTarget(entry, body.toPath);
        const folder = knowledgeContainer(body.toPath);
        const scope = await resolveScope(request, reply);
        if (!scope) return reply;
        const target = areaTarget(scope, entry.area);
        const links = linkKeeper(scope, entry.area);
        const result = await deps.move(
          reply,
          target,
          target,
          { root: target.root, path: entry.rel, toRoot: target.root, toPath: folder.rel },
          links.hook,
        );
        return relocated(result, entry.area, links.outcome);
      });
    },
    upload: async (request: FastifyRequest, reply: FastifyReply) => {
      const query = uploadQuery.parse(request.query);
      return checked(reply, async () => {
        const folder = knowledgeContainer(query.path);
        knowledgeChild(folder, query.fileName);
        const scope = await resolveScope(request, reply);
        if (!scope) return reply;
        const target = areaTarget(scope, folder.area);
        return inArea(
          await deps.upload(request, reply, target, {
            root: target.root,
            path: folder.rel,
            fileName: query.fileName,
          }),
          folder.area,
        );
      });
    },
    createFolder: async (request: FastifyRequest, reply: FastifyReply) => {
      const createFolder = deps.createFolder;
      const body = folderBody.parse(request.body);
      return checked(reply, async () => {
        const folder = knowledgeContainer(body.path);
        knowledgeChild(folder, body.name);
        const scope = await resolveScope(request, reply);
        if (!scope) return reply;
        if (!createFolder)
          return reply.code(501).send({ error: 'Creating folders is not available here.' });
        return inArea(
          await createFolder(reply, areaTarget(scope, folder.area), folder.rel, body.name),
          folder.area,
        );
      });
    },
    backlinks: async (request: FastifyRequest, reply: FastifyReply) => {
      const { path } = pathQuery.parse(request.query);
      return checked(reply, async () => {
        const entry = knowledgeEntry(path);
        const scope = await resolveScope(request, reply);
        if (!scope) return reply;
        return { pages: await knowledgeBacklinks(scope.dir, entry.path) };
      });
    },
  };
}

/** The whole scope folder, as listing and reading address it. */
function scopeTarget(scope: KnowledgeScope): SessionFileTarget {
  return { root: scope.kind === 'project' ? 'knowledge' : 'shared', dir: scope.dir };
}

function parentOf(entry: KnowledgeAreaPath): KnowledgeAreaPath {
  return knowledgeContainer(entry.path.slice(0, entry.path.lastIndexOf('/')));
}

/** Registers the project and Shared knowledge file routes. */
export function registerKnowledgeFileRoutes(
  app: FastifyInstance,
  deps: KnowledgeFileRouteDeps,
): void {
  const resolveProjectRoot = deps.resolveProjectRoot;
  if (resolveProjectRoot) {
    const project = knowledgeHandlers(deps, async (request, reply) => {
      const { id } = sessionParams.parse(request.params);
      const dir = await resolveProjectRoot(id);
      if (dir) return { kind: 'project', dir };
      reply.code(404).send({ error: 'Project knowledge not found' });
      return undefined;
    });
    app.get('/projects/:id/knowledge/files', project.list);
    app.get('/projects/:id/knowledge/files/content', project.content);
    app.get('/projects/:id/knowledge/files/download', project.download);
    app.get('/projects/:id/knowledge/files/backlinks', project.backlinks);
    app.put('/projects/:id/knowledge/files/content', { bodyLimit: 6_100_000 }, project.write);
    app.post('/projects/:id/knowledge/files', project.upload);
    app.delete('/projects/:id/knowledge/files', project.remove);
    app.post('/projects/:id/knowledge/files/rename', project.rename);
    app.post('/projects/:id/knowledge/files/move', project.move);
    app.post('/projects/:id/knowledge/folders', project.createFolder);
    app.get('/projects/:id/knowledge/wiki', async (request, reply) => {
      const { id } = sessionParams.parse(request.params);
      const dir = await resolveProjectRoot(id);
      if (!dir) return reply.code(404).send({ error: 'Project knowledge not found' });
      return projectWikiCatalog(dir);
    });
  }

  const resolveSharedRoot = deps.resolveSharedRoot;
  if (resolveSharedRoot) {
    const resolveShared = async (reply: FastifyReply): Promise<KnowledgeScope | undefined> => {
      const dir = await resolveSharedRoot();
      if (dir) return { kind: 'shared', dir };
      reply.code(404).send({ error: 'Shared knowledge is not configured' });
      return undefined;
    };
    const shared = knowledgeHandlers(deps, (_request, reply) => resolveShared(reply));
    app.get('/knowledge/shared/files', shared.list);
    app.get('/knowledge/shared/files/content', shared.content);
    app.get('/knowledge/shared/files/download', shared.download);
    app.get('/knowledge/shared/files/backlinks', shared.backlinks);
    app.put('/knowledge/shared/files/content', { bodyLimit: 6_100_000 }, shared.write);
    app.post('/knowledge/shared/files', shared.upload);
    app.delete('/knowledge/shared/files', shared.remove);
    app.post('/knowledge/shared/files/rename', shared.rename);
    app.post('/knowledge/shared/files/move', shared.move);
    app.post('/knowledge/shared/folders', shared.createFolder);
    // The most recently changed pages, for Verity's page in the app.
    app.get('/knowledge/shared/recent', async (request, reply) => {
      const query = recentSharedQuery.safeParse(request.query);
      if (!query.success) return reply.code(400).send({ error: 'Invalid limit' });
      const scope = await resolveShared(reply);
      if (!scope) return reply;
      reply.header('cache-control', 'no-store');
      return recentSharedKnowledge(scope.dir, query.data.limit);
    });
  }
}
