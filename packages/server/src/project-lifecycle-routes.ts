import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ProjectRecord } from '@verity/store';
import { z } from 'zod';

const projectParams = z.object({ id: z.string().min(1) });
const deprovisionQuery = z.object({
  purge: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => value === 'true'),
});

type ErrorResponse = { error: string; status?: 'sealed' };
type DeleteOutcome = {
  code: number;
  body: { projectId: string } | { error: string };
};
type DeprovisionOutcome =
  { code: 200; project: ProjectRecord } | { code: 404 | 409 | 503; error: string };
type RepairOutcome =
  | { code: 200 | 202; project: ProjectRecord }
  | { code: 404 | 503; error: string; status?: 'sealed' }
  | { code: 409; requiresConfirmation: true; warnings: string[] };

export interface ProjectLifecycleRouteDeps {
  deleteProject: (request: FastifyRequest, projectId: string) => Promise<DeleteOutcome>;
  deprovision: (
    request: FastifyRequest,
    projectId: string,
    purge: boolean,
  ) => Promise<DeprovisionOutcome>;
  repair: (
    request: FastifyRequest,
    projectId: string,
    confirmWarnings: boolean,
  ) => Promise<RepairOutcome>;
}

/** Registers destructive and restorative project lifecycle routes. */
export function registerProjectLifecycleRoutes(
  app: FastifyInstance,
  deps: ProjectLifecycleRouteDeps,
): void {
  app.delete(
    '/projects/:id',
    async (request, reply): Promise<{ projectId: string } | { error: string }> => {
      const { id } = projectParams.parse(request.params);
      const outcome = await deps.deleteProject(request, id);
      reply.code(outcome.code);
      return outcome.body;
    },
  );

  app.post(
    '/projects/:id/deprovision',
    async (request, reply): Promise<{ project: ProjectRecord } | { error: string }> => {
      const { id } = projectParams.parse(request.params);
      const { purge } = deprovisionQuery.parse(request.query);
      const outcome = await deps.deprovision(request, id, purge);
      reply.code(outcome.code);
      return 'project' in outcome ? { project: outcome.project } : { error: outcome.error };
    },
  );

  app.post(
    '/projects/:id/repair',
    async (
      request,
      reply,
    ): Promise<
      | { project: ProjectRecord }
      | ErrorResponse
      | { requiresConfirmation: true; warnings: string[] }
    > => {
      const { id } = projectParams.parse(request.params);
      const confirmWarnings =
        (request.body as { confirmWarnings?: boolean } | undefined)?.confirmWarnings === true;
      const outcome = await deps.repair(request, id, confirmWarnings);
      reply.code(outcome.code);
      if ('project' in outcome) return { project: outcome.project };
      if ('requiresConfirmation' in outcome) {
        return { requiresConfirmation: true, warnings: outcome.warnings };
      }
      return {
        error: outcome.error,
        ...(outcome.status === undefined ? {} : { status: outcome.status }),
      };
    },
  );
}
