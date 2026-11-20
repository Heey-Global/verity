import type { FastifyInstance } from 'fastify';
import type { ServerContext } from './server-context.js';
import { registerServerSessionFiles } from './server-session-files.js';
import { WikiProposals } from './wiki-proposals.js';
import { registerWikiProposalRoutes } from './wiki-proposal-routes.js';

export function createServerWikiProposals(app: FastifyInstance, ctx: ServerContext) {
  const { deps, conductor, resources } = ctx;
  // Proposals write through the Wiki's file routes, which are registered further below.
  const sessionFiles: { current?: ReturnType<typeof registerServerSessionFiles> } = {};
  const wikiFiles = () => {
    if (!sessionFiles.current) throw new Error('Wiki files are not ready');
    return sessionFiles.current;
  };
  const wikiProposals =
    deps.dataRoot === undefined
      ? undefined
      : new WikiProposals(deps.dataRoot, {
          readProjectWiki: (projectId, path) => wikiFiles().readProjectWiki(projectId, path),
          writeProjectWiki: (projectId, path, content, version) =>
            wikiFiles().writeProjectWiki(projectId, path, content, version),
          onFailure: (err, details) =>
            app.log.warn({ err, ...details }, 'Wiki proposal page could not be written'),
          onChange: (projectId) =>
            resources.invalidate(`/projects/${encodeURIComponent(projectId)}/knowledge/proposals`),
        });
  const installWikiFiles = () => {
    sessionFiles.current = registerServerSessionFiles(app, deps, conductor);
    if (wikiProposals)
      registerWikiProposalRoutes(app, wikiProposals, async (projectId) => {
        const project = await deps.eventStore.getProject(projectId);
        return project !== undefined && !project.hiddenAt;
      });
  };
  return { wikiProposals, installWikiFiles };
}
