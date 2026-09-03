import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

const projectParams = z.object({ id: z.string().min(1) });
const setupBody = z.object({
  fingerprint: z.string().min(1),
  confirmWarnings: z.boolean().optional().default(false),
  devServers: z
    .array(
      z.object({
        sourceKey: z.string().min(1),
        name: z.string().min(1),
        command: z.string().min(1),
        workdir: z.string().nullable(),
        containerPort: z.string().min(1).nullable(),
      }),
    )
    .min(1),
});

type ProjectDevServerSetup = z.infer<typeof setupBody>;
export interface ProjectDevServerSetupRouteDeps {
  isAvailable: () => boolean;
  setup: (
    request: FastifyRequest,
    reply: FastifyReply,
    projectId: string,
    body: ProjectDevServerSetup,
  ) => Promise<unknown>;
}

/** Registers the route that applies reviewed, detected Dev Server configurations. */
export function registerProjectDevServerSetupRoute(
  app: FastifyInstance,
  deps: ProjectDevServerSetupRouteDeps,
): void {
  const locks = new Map<string, Promise<void>>();
  const acquireLock = async (projectId: string): Promise<() => void> => {
    const previous = locks.get(projectId) ?? Promise.resolve();
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const tail = previous.then(() => gate);
    locks.set(projectId, tail);
    await previous;
    return () => {
      releaseGate();
      if (locks.get(projectId) === tail) locks.delete(projectId);
    };
  };

  app.post('/projects/:id/setup-dev-servers', async (request, reply): Promise<unknown> => {
    if (!deps.isAvailable()) {
      reply.code(503);
      return { error: 'project setup is not configured' };
    }
    const { id } = projectParams.parse(request.params);
    const body = setupBody.parse(request.body ?? {});
    const release = await acquireLock(id);
    try {
      return await deps.setup(request, reply, id, body);
    } finally {
      release();
    }
  });
}
