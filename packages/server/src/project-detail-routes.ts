import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  PROJECT_AGENTS,
  PROJECT_MEMORY_MAX_CHARS,
  SealedError,
  type ProjectSettingsPatch,
} from '@verity/store';
import { isValidBranchName } from './branches.js';
import type { BrokeredGrantRecord } from './brokered-http-grants.js';
import { ProjectAgentNotAllowedError } from './project-agent-policy.js';

const projectParams = z.object({ id: z.string().min(1) });
const grantParams = z.object({ id: z.string().min(1), grantId: z.string().min(1) });
const collapsedBody = z.object({ collapsed: z.boolean() });
const setupStatusBody = z.object({
  status: z.enum(['pending', 'secrets_skipped', 'complete']),
});
const settingsBody = z
  .object({
    googleDriveAccessMode: z.enum(['read-only', 'read-write']).optional(),
    dopplerProject: z.string().nullable().optional(),
    dopplerConfig: z.string().nullable().optional(),
    defaultBranch: z
      .string()
      .trim()
      .refine((branch) => branch.length === 0 || isValidBranchName(branch), 'invalid branch name')
      .nullable()
      .optional(),
    defaultModel: z.string().nullable().optional(),
    // Null allows every connected agent; a list must keep at least one agent.
    allowedAgents: z
      .array(z.enum(PROJECT_AGENTS))
      .min(1, 'at least one agent must stay allowed')
      .refine((agents) => new Set(agents).size === agents.length, 'duplicate agent')
      .nullable()
      .optional(),
    memory: z
      .string()
      .max(
        PROJECT_MEMORY_MAX_CHARS,
        `project memory limit is ${PROJECT_MEMORY_MAX_CHARS} characters`,
      )
      .nullable()
      .optional(),
  })
  .strict();

export interface ProjectDetailRouteDeps {
  getDetail: (projectId: string) => Promise<unknown>;
  projectExists: (projectId: string) => Promise<boolean>;
  listGrants?: ((projectId: string) => Promise<BrokeredGrantRecord[]>) | undefined;
  revokeGrant?: ((projectId: string, grantId: string) => Promise<boolean>) | undefined;
  setSetupStatus: (
    projectId: string,
    status: 'pending' | 'secrets_skipped' | 'complete',
  ) => Promise<unknown>;
  setCollapsed: (projectId: string, collapsed: boolean) => Promise<unknown>;
  isSealed: () => boolean;
  updateSettings: (projectId: string, patch: ProjectSettingsPatch) => Promise<unknown>;
}

/** Registers project detail, presentation state, settings, and secret-grant routes. */
export function registerProjectDetailRoutes(
  app: FastifyInstance,
  deps: ProjectDetailRouteDeps,
): void {
  app.get('/projects/:id', async (request, reply): Promise<unknown> => {
    const { id } = projectParams.parse(request.params);
    const detail = await deps.getDetail(id);
    if (detail === undefined) {
      reply.code(404);
      return { error: `project ${id} not found` };
    }
    return detail;
  });

  app.get('/projects/:id/secret-grants', async (request, reply): Promise<unknown> => {
    const { id } = projectParams.parse(request.params);
    if (deps.listGrants === undefined) {
      reply.code(501);
      return { error: 'brokered secret grants are not configured', grants: [] };
    }
    if (!(await deps.projectExists(id))) {
      reply.code(404);
      return { error: 'project not found', grants: [] };
    }
    return { grants: await deps.listGrants(id) };
  });

  app.delete('/projects/:id/secret-grants/:grantId', async (request, reply): Promise<unknown> => {
    const { id, grantId } = grantParams.parse(request.params);
    if (deps.revokeGrant === undefined) {
      reply.code(501);
      return { error: 'brokered secret grants are not configured' };
    }
    if (!(await deps.revokeGrant(id, grantId))) {
      reply.code(404);
      return { error: 'grant not found' };
    }
    reply.code(204);
    return null;
  });

  app.patch('/projects/:id/setup-status', async (request, reply): Promise<unknown> => {
    const { id } = projectParams.parse(request.params);
    const { status } = setupStatusBody.parse(request.body);
    const project = await deps.setSetupStatus(id, status);
    if (project === undefined) {
      reply.code(404);
      return { error: 'project not found' };
    }
    return project;
  });

  app.patch('/projects/:id/collapsed', async (request, reply): Promise<unknown> => {
    const { id } = projectParams.parse(request.params);
    const { collapsed } = collapsedBody.parse(request.body);
    const project = await deps.setCollapsed(id, collapsed);
    if (project === undefined) {
      reply.code(404);
      return { error: 'project not found' };
    }
    return project;
  });

  app.patch('/projects/:id/settings', async (request, reply): Promise<unknown> => {
    if (deps.isSealed()) throw new SealedError();
    const { id } = projectParams.parse(request.params);
    const patch: ProjectSettingsPatch = settingsBody.parse(request.body);
    if (!(await deps.projectExists(id))) {
      reply.code(404);
      return { error: `project ${id} not found` };
    }
    let settings: unknown;
    try {
      settings = await deps.updateSettings(id, patch);
    } catch (error) {
      if (!(error instanceof ProjectAgentNotAllowedError)) throw error;
      reply.code(400);
      return { error: error.message };
    }
    if (settings === undefined) {
      reply.code(404);
      return { error: `project ${id} not found` };
    }
    return { settings };
  });
}
