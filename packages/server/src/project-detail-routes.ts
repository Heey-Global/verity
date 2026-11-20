import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { viewerId } from './view-state-routes.js';
import {
  InvalidProjectNameError,
  PROJECT_AGENTS,
  PROJECT_MEMORY_MAX_CHARS,
  PROJECT_NAME_MAX_CHARS,
  SealedError,
  type ProjectRecord,
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
// Name and description, edited in place on the project page. A route of its
// own so that a member with manage rights can change them without being able
// to reach the rest of the settings, which stay with administrators.
const PROJECT_DESCRIPTION_MAX_CHARS = 200;
const profileBody = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, 'project name is required')
      .refine(
        (name) => name.length <= PROJECT_NAME_MAX_CHARS,
        `project name is limited to ${PROJECT_NAME_MAX_CHARS} characters`,
      )
      .optional(),
    description: z.string().trim().max(PROJECT_DESCRIPTION_MAX_CHARS).nullable().optional(),
  })
  .strict()
  .refine((body) => body.name !== undefined || body.description !== undefined, 'nothing to change');
const settingsBody = z
  .object({
    devcontainerEnabled: z.boolean().optional(),
    googleDriveAccessMode: z.enum(['read-only', 'read-write']).optional(),
    designLevel: z.enum(['off', 'on_request', 'required']).optional(),
    description: z.string().trim().max(200).nullable().optional(),
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

const defaultModelBody = z.object({ model: z.string().trim().min(1).max(200).nullable() }).strict();

export interface ProjectDetailRouteDeps {
  /** The project with its sessions as `viewer` sees them (read marks, dismissals). */
  getDetail: (projectId: string, viewer: string) => Promise<unknown>;
  projectExists: (projectId: string) => Promise<boolean>;
  listGrants?: ((projectId: string) => Promise<BrokeredGrantRecord[]>) | undefined;
  revokeGrant?: ((projectId: string, grantId: string) => Promise<boolean>) | undefined;
  setSetupStatus: (
    projectId: string,
    status: 'pending' | 'secrets_skipped' | 'complete',
  ) => Promise<unknown>;
  /** Folds the project for `viewer` only. */
  setCollapsed: (projectId: string, collapsed: boolean, viewer: string) => Promise<unknown>;
  isSealed: () => boolean;
  /** Applies a settings patch; a default model in it becomes `viewer`'s own. */
  updateSettings: (
    projectId: string,
    patch: ProjectSettingsPatch,
    viewer: string,
  ) => Promise<unknown>;
  /** Sets `viewer`'s own default model for the project (ADR 0023 §3). */
  setOwnDefaultModel: (
    projectId: string,
    viewer: string,
    model: string | null,
  ) => Promise<{ defaultModel: string | null }>;
  renameProject: (projectId: string, name: string) => Promise<ProjectRecord | undefined>;
}

/** Registers project detail, presentation state, settings, and secret-grant routes. */
export function registerProjectDetailRoutes(
  app: FastifyInstance,
  deps: ProjectDetailRouteDeps,
): void {
  app.get('/projects/:id', async (request, reply): Promise<unknown> => {
    const { id } = projectParams.parse(request.params);
    const detail = await deps.getDetail(id, viewerId(request));
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
    const project = await deps.setCollapsed(id, collapsed, viewerId(request));
    if (project === undefined) {
      reply.code(404);
      return { error: 'project not found' };
    }
    return project;
  });

  app.patch('/projects/:id/profile', async (request, reply): Promise<unknown> => {
    if (deps.isSealed()) throw new SealedError();
    const { id } = projectParams.parse(request.params);
    const parsed = profileBody.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: parsed.error.issues[0]?.message ?? 'invalid request' };
    }
    const { name, description } = parsed.data;
    if (!(await deps.projectExists(id))) {
      reply.code(404);
      return { error: `project ${id} not found` };
    }
    const answer: { name?: string; description?: string | null } = {};
    if (name !== undefined) {
      let renamed: ProjectRecord | undefined;
      try {
        renamed = await deps.renameProject(id, name);
      } catch (error) {
        if (!(error instanceof InvalidProjectNameError)) throw error;
        reply.code(400);
        return { error: error.message };
      }
      if (renamed === undefined) {
        reply.code(404);
        return { error: `project ${id} not found` };
      }
      answer.name = renamed.name;
    }
    if (description !== undefined) {
      const settings = (await deps.updateSettings(id, { description }, viewerId(request))) as
        { description?: string | null } | undefined;
      if (settings === undefined) {
        reply.code(404);
        return { error: `project ${id} not found` };
      }
      answer.description = settings.description ?? null;
    }
    return answer;
  });

  // Each person picks their own default model for a project; it needs only the
  // permission to work in it, not to manage it.
  app.put('/projects/:id/default-model', async (request, reply): Promise<unknown> => {
    if (deps.isSealed()) throw new SealedError();
    const { id } = projectParams.parse(request.params);
    const { model } = defaultModelBody.parse(request.body);
    if (!(await deps.projectExists(id))) {
      reply.code(404);
      return { error: `project ${id} not found` };
    }
    try {
      return await deps.setOwnDefaultModel(id, viewerId(request), model);
    } catch (error) {
      if (!(error instanceof ProjectAgentNotAllowedError)) throw error;
      reply.code(400);
      return { error: error.message };
    }
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
      settings = await deps.updateSettings(id, patch, viewerId(request));
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
