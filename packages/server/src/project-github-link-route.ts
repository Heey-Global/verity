import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

const projectParams = z.object({ id: z.string().min(1) });
const linkBody = z.object({ repo: z.string().min(1) });

export interface ProjectGitHubLinkRouteDeps {
  isAvailable: () => boolean;
  link: (
    request: FastifyRequest,
    reply: FastifyReply,
    projectId: string,
    repository: string,
  ) => Promise<unknown>;
}

/** Registers the bridge that publishes a local project to an existing GitHub repository. */
export function registerProjectGitHubLinkRoute(
  app: FastifyInstance,
  deps: ProjectGitHubLinkRouteDeps,
): void {
  app.post('/projects/:id/link-github', async (request, reply): Promise<unknown> => {
    if (!deps.isAvailable()) {
      reply.code(503);
      return { error: 'linking a project to GitHub is not configured' };
    }
    const { id } = projectParams.parse(request.params);
    const { repo } = linkBody.parse(request.body);
    return deps.link(request, reply, id, repo);
  });
}
