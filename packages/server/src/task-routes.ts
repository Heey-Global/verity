import type { Conductor } from '@verity/session';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { parseOwnerRepo } from './canonical.js';
import type { IssueSummary } from './github.js';
import type { GitHubTaskService, TaskBoard, TaskItem } from './github-tasks.js';
import { buildRefinePrompt, parseRefinedTask, type RefinedTask } from './task-refine.js';

/**
 * Plan-tab routes: cached issue discovery, Projects v2 task CRUD, and the
 * stateless voice-note refiner (ADR 0007). The module receives only the four
 * capabilities these routes use, keeping the rest of the server dependency bag
 * and session lifecycle out of this boundary.
 *
 * Task reads are best-effort; writes return 502 when GitHub cannot confirm them.
 * No route polls GitHub. Without a task service the board endpoints return 503,
 * which is how clients know to hide task management.
 */
const notConfigured = { error: 'Task management is not configured' } as const;
const draftBody = z.object({ title: z.string().min(1), body: z.string().optional() });
const issueBody = z.object({
  title: z.string().min(1),
  body: z.string().optional(),
  repo: z.string().min(1).optional(),
  repositoryId: z.string().min(1).optional(),
});
const convertBody = z.object({
  repo: z.string().min(1).optional(),
  repositoryId: z.string().min(1).optional(),
});
const updateIssueBody = z.object({
  title: z.string().optional(),
  body: z.string().optional(),
  state: z.enum(['OPEN', 'CLOSED']).optional(),
});
const reorderBody = z.object({
  itemId: z.string().min(1),
  afterId: z.string().min(1).nullable().optional(),
});
const taskItemParams = z.object({ itemId: z.string().min(1) });
const taskIssueParams = z.object({ issueId: z.string().min(1) });
const setFieldBody = z.object({ field: z.string().min(1), value: z.string().min(1) });
const REFINE_TIMEOUT_MS = 45_000;
const refineBody = z.object({
  transcript: z.string().min(1).max(8000),
  model: z.string().min(1).optional(),
});

type ResolvedRepo =
  | { ok: true; repositoryId: string; repo?: { owner: string; repo: string } | undefined }
  | { ok: false; status: 400 | 502; error: string };

const unresolvable: ResolvedRepo = {
  ok: false,
  status: 502,
  error: 'Could not resolve the repository',
};

async function resolveTaskRepoId(
  service: GitHubTaskService,
  repositoryId?: string,
  repo?: string,
): Promise<ResolvedRepo> {
  // An explicit node id wins for identity, while a friendly owner/repo is still
  // validated and retained as the token-mint target. With neither, use origin.
  if (repo !== undefined) {
    const parsed = parseOwnerRepo(repo);
    if (!parsed) {
      return { ok: false, status: 400, error: 'Invalid repository (expected "owner/repo")' };
    }
    if (repositoryId !== undefined) {
      return { ok: true, repositoryId, repo: { owner: parsed.owner, repo: parsed.repo } };
    }
    const id = await service.repositoryIdFor({ owner: parsed.owner, repo: parsed.repo });
    return id === null
      ? unresolvable
      : { ok: true, repositoryId: id, repo: { owner: parsed.owner, repo: parsed.repo } };
  }
  if (repositoryId !== undefined) return { ok: true, repositoryId };
  const id = await service.repositoryId();
  return id === null ? unresolvable : { ok: true, repositoryId: id };
}

export function registerTaskRoutes(
  app: FastifyInstance,
  deps: {
    taskService?: GitHubTaskService;
    listIssues?: () => Promise<IssueSummary[]>;
    refineCwd?: string;
    query: Conductor['query'];
  },
): void {
  app.get('/issues', async (_request, reply): Promise<IssueSummary[] | { error: string }> => {
    if (!deps.listIssues) {
      reply.code(503);
      return { error: 'GitHub issues are not configured' };
    }
    return deps.listIssues();
  });

  app.get(
    '/tasks',
    async (_request, reply): Promise<{ board: TaskBoard | null } | { error: string }> => {
      if (!deps.taskService) {
        reply.code(503);
        return notConfigured;
      }
      return { board: await deps.taskService.getBoard() };
    },
  );

  app.post(
    '/tasks/drafts',
    async (request, reply): Promise<{ item: TaskItem } | { error: string }> => {
      if (!deps.taskService) {
        reply.code(503);
        return notConfigured;
      }
      const { title, body } = draftBody.parse(request.body);
      const item = await deps.taskService.createDraft({
        title,
        ...(body !== undefined ? { body } : {}),
      });
      if (item === null) {
        reply.code(502);
        return { error: 'Failed to create draft' };
      }
      reply.code(201);
      return { item };
    },
  );

  app.post(
    '/tasks/issues',
    async (
      request,
      reply,
    ): Promise<
      | { issue: { issueId: string; itemId: string | null; number: number | null; url: string } }
      | { error: string }
    > => {
      if (!deps.taskService) {
        reply.code(503);
        return notConfigured;
      }
      const { title, body, repo, repositoryId } = issueBody.parse(request.body);
      const resolved = await resolveTaskRepoId(deps.taskService, repositoryId, repo);
      if (!resolved.ok) {
        reply.code(resolved.status);
        return { error: resolved.error };
      }
      const issue = await deps.taskService.createIssue({
        repositoryId: resolved.repositoryId,
        ...(resolved.repo !== undefined ? { repo: resolved.repo } : {}),
        title,
        ...(body !== undefined ? { body } : {}),
      });
      if (issue === null) {
        reply.code(502);
        return { error: 'Failed to create issue' };
      }
      reply.code(201);
      return { issue };
    },
  );

  app.post(
    '/tasks/:itemId/convert',
    async (
      request,
      reply,
    ): Promise<
      { result: { itemId: string; number: number | null; url: string } } | { error: string }
    > => {
      if (!deps.taskService) {
        reply.code(503);
        return notConfigured;
      }
      const { itemId } = taskItemParams.parse(request.params);
      const { repo, repositoryId } = convertBody.parse(request.body ?? {});
      const resolved = await resolveTaskRepoId(deps.taskService, repositoryId, repo);
      if (!resolved.ok) {
        reply.code(resolved.status);
        return { error: resolved.error };
      }
      const result = await deps.taskService.convertDraftToIssue({
        itemId,
        repositoryId: resolved.repositoryId,
        ...(resolved.repo !== undefined ? { repo: resolved.repo } : {}),
      });
      if (result === null) {
        reply.code(502);
        return { error: 'Failed to convert draft' };
      }
      return { result };
    },
  );

  app.patch(
    '/tasks/issues/:issueId',
    async (request, reply): Promise<{ ok: true } | { error: string }> => {
      if (!deps.taskService) {
        reply.code(503);
        return notConfigured;
      }
      const { issueId } = taskIssueParams.parse(request.params);
      const patch = updateIssueBody.parse(request.body ?? {});
      const ok = await deps.taskService.updateIssue({ issueId, ...patch });
      if (!ok) {
        reply.code(502);
        return { error: 'Failed to update issue' };
      }
      return { ok: true };
    },
  );

  app.post('/tasks/reorder', async (request, reply): Promise<{ ok: true } | { error: string }> => {
    if (!deps.taskService) {
      reply.code(503);
      return notConfigured;
    }
    const { itemId, afterId } = reorderBody.parse(request.body);
    const ok = await deps.taskService.reorder({ itemId, afterId: afterId ?? null });
    if (!ok) {
      reply.code(502);
      return { error: 'Failed to reorder' };
    }
    return { ok: true };
  });

  app.delete(
    '/tasks/:itemId',
    async (request, reply): Promise<{ ok: true } | { error: string }> => {
      if (!deps.taskService) {
        reply.code(503);
        return notConfigured;
      }
      const { itemId } = taskItemParams.parse(request.params);
      const ok = await deps.taskService.removeItem({ itemId });
      if (!ok) {
        reply.code(502);
        return { error: 'Failed to remove task item' };
      }
      return { ok: true };
    },
  );

  app.post(
    '/tasks/:itemId/field',
    async (request, reply): Promise<{ ok: true } | { error: string }> => {
      if (!deps.taskService) {
        reply.code(503);
        return notConfigured;
      }
      const { itemId } = taskItemParams.parse(request.params);
      const { field, value } = setFieldBody.parse(request.body);
      const ok = await deps.taskService.setField({ itemId, field, option: value });
      if (!ok) {
        reply.code(502);
        return { error: 'Failed to set field (unknown field/option or write failed)' };
      }
      return { ok: true };
    },
  );

  app.post(
    '/tasks/refine',
    async (request, reply): Promise<{ refined: RefinedTask } | { error: string }> => {
      if (deps.refineCwd === undefined) {
        reply.code(503);
        return { error: 'Task refinement is not configured' };
      }
      const { transcript, model } = refineBody.parse(request.body);
      // One bounded stateless query: the input schema caps prompt size and the
      // timeout covers backends that do not impose a default of their own.
      const raw = await deps.query({
        prompt: buildRefinePrompt(transcript),
        cwd: deps.refineCwd,
        signal: AbortSignal.timeout(REFINE_TIMEOUT_MS),
        ...(model !== undefined ? { model } : {}),
      });
      const refined = parseRefinedTask(raw);
      if (refined === null) {
        reply.code(502);
        return { error: 'Refinement failed' };
      }
      return { refined };
    },
  );
}
