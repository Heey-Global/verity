import { randomUUID } from 'node:crypto';

import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';

import { attachmentUploadSchema, type AgentEvent, type TasksRequest } from '@verity/events';
import {
  OPEN_TASK_STATUSES,
  TASK_ATTACHMENTS_MAX,
  TASK_DETAIL_MAX,
  TASK_RESULT_MAX,
  TASK_STATUSES,
  TASK_TITLE_MAX,
  TaskInputError,
  TaskNotFoundError,
  TaskRevisionConflictError,
  type EventStore,
  type TaskRecord,
} from '@verity/store';

/** Mirrors the legacy-administrator fallback the HTTP MCP connection routes use:
 *  deployments without the auth gate have one implicit user. */
const legacyAdministratorId = '00000000-0000-4000-8000-000000000001';

function ownerId(request: { localUserId: string | null }): string {
  return request.localUserId ?? legacyAdministratorId;
}

const taskStatus = z.enum(TASK_STATUSES as [string, ...string[]]);
const attachment = z
  .object({
    hash: z.string().regex(/^[a-f0-9]{64}$/),
    filename: z.string().trim().min(1).max(255),
    mimeType: z.string().trim().min(1).max(255),
  })
  .strict();
const sessionIdSchema = z.string().trim().min(1).max(128);

const listQuery = z
  .object({
    /** `general` selects the bucket without a project. */
    projectId: z.string().trim().min(1).max(128).optional(),
    sessionId: sessionIdSchema.optional(),
    status: z
      .string()
      .transform((value) => value.split(','))
      .pipe(z.array(taskStatus).min(1))
      .optional(),
  })
  .strict();

const taskParams = z.object({ id: z.string().regex(/^[0-9a-f-]{36}$/i, 'invalid task id') });

const putBody = z
  .object({
    projectId: z.string().trim().min(1).max(128).nullable().optional(),
    sessionId: sessionIdSchema.nullable().optional(),
    sourceSessionId: sessionIdSchema.nullable().optional(),
    title: z.string().trim().min(1).max(TASK_TITLE_MAX),
    detail: z.string().trim().max(TASK_DETAIL_MAX).nullable().optional(),
    uploads: z
      .array(
        attachmentUploadSchema.refine(
          (upload) =>
            upload.data.length <= (upload.kind === 'image' ? 10_000_000 : 35_000_000) &&
            /^[A-Za-z0-9+/]+={0,2}$/.test(upload.data),
          'invalid or oversized attachment',
        ),
      )
      .max(TASK_ATTACHMENTS_MAX)
      .optional(),
    attachments: z.array(attachment).max(TASK_ATTACHMENTS_MAX).optional(),
    status: taskStatus.optional(),
    sort: z.number().int().min(0).max(1_000_000).optional(),
  })
  .strict();

const patchBody = z
  .object({
    projectId: z.string().trim().min(1).max(128).nullable().optional(),
    sessionId: sessionIdSchema.nullable().optional(),
    title: z.string().trim().min(1).max(TASK_TITLE_MAX).optional(),
    detail: z.string().trim().max(TASK_DETAIL_MAX).nullable().optional(),
    attachments: z.array(attachment).max(TASK_ATTACHMENTS_MAX).optional(),
    status: taskStatus.optional(),
    result: z.string().trim().max(TASK_RESULT_MAX).nullable().optional(),
    sort: z.number().int().min(0).max(1_000_000).optional(),
    origin: z.enum(['user', 'agent']).optional(),
    expectedRevision: z.number().int().positive().optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).some((key) => key !== 'expectedRevision'), {
    message: 'nothing to change',
  });

export interface TasksRouteDeps {
  eventStore: EventStore;
  /** Fan a {@link AgentEvent} out to a session's live stream after it is stored. */
  publish: (sessionId: string, event: AgentEvent) => Promise<void>;
}

function taskResponse(task: TaskRecord): Record<string, unknown> {
  return {
    id: task.id,
    projectId: task.projectId,
    sessionId: task.sessionId,
    sourceSessionId: task.sourceSessionId,
    origin: task.origin,
    title: task.title,
    detail: task.detail,
    attachments: task.attachments,
    status: task.status,
    result: task.result,
    sort: task.sort,
    revision: task.revision,
    createdAt: task.createdAt.toISOString(),
    updatedAt: task.updatedAt.toISOString(),
    completedAt: task.completedAt?.toISOString() ?? null,
  };
}

/**
 * Owner-scoped CRUD for the user's task list (docs/TASKS_AND_QUICK_CAPTURE_CONCEPT.md
 * §7). Every route reads the owner from the paired bearer, never from the body, so
 * a task id alone grants nothing. A project on a task additionally needs read
 * access to that project; assigning a task to a session needs execute, because
 * the assignment is what starts a turn there.
 */
export function registerTasksRoutes(app: FastifyInstance, deps: TasksRouteDeps): void {
  const tasks = deps.eventStore.tasks;

  async function canUseProject(
    userId: string | null,
    projectId: string | null,
    permission: 'read' | 'execute',
  ): Promise<boolean> {
    if (projectId === null)
      return (
        permission === 'read' ||
        userId === null ||
        (await deps.eventStore.isActiveAdministrator(userId))
      );
    const project = await deps.eventStore.getProject(projectId);
    if (project === undefined) return false;
    // No auth gate: the implicit administrator reaches every project.
    if (userId === null) return true;
    return deps.eventStore.hasProjectPermission(userId, projectId, permission);
  }

  /** The session a task is assigned to must exist and sit in the task's project. */
  async function sessionFits(sessionId: string | null, projectId: string | null): Promise<boolean> {
    if (sessionId === null) return true;
    const session = await deps.eventStore.getSession(sessionId);
    return session !== undefined && session.projectId === projectId;
  }

  async function notify(
    task: TaskRecord,
    previousSessionId: string | null,
    change: 'added' | 'updated' | 'completed' | 'dropped' | 'deleted',
  ): Promise<void> {
    const sessions = new Set([task.sessionId, previousSessionId]);
    for (const sessionId of sessions) {
      if (sessionId === null) continue;
      await deps.publish(sessionId, {
        t: 'tasks_updated',
        origin: 'user',
        change,
        taskIds: [task.id],
      });
    }
  }

  function failure(reply: FastifyReply, error: unknown): { error: string } | undefined {
    if (error instanceof TaskNotFoundError) {
      reply.code(404);
      return { error: 'task not found' };
    }
    if (error instanceof TaskRevisionConflictError) {
      reply.code(409);
      return { error: `task changed; current revision is ${String(error.currentRevision)}` };
    }
    if (error instanceof TaskInputError) {
      reply.code(400);
      return { error: error.message };
    }
    return undefined;
  }

  app.get('/tasks/:id/attachments/:hash', async (request, reply) => {
    const { id, hash } = z
      .object({ id: taskParams.shape.id, hash: attachment.shape.hash })
      .parse(request.params);
    const task = await tasks.get(id, ownerId(request));
    if (
      task === undefined ||
      !(await canUseProject(request.localUserId, task.projectId, 'read')) ||
      !task.attachments.some((item) => item.hash === hash)
    )
      return reply.code(404).send({ error: 'attachment not found' });
    const blob = await deps.eventStore.getAttachment(hash);
    if (blob === undefined) return reply.code(404).send({ error: 'attachment not found' });
    return reply
      .header('Content-Type', blob.mediaType)
      .header('Cache-Control', 'private, max-age=31536000, immutable')
      .send(blob.bytes);
  });

  app.get('/tasks', async (request) => {
    const query = listQuery.parse(request.query);
    const list = await tasks.list({
      ownerUserId: ownerId(request),
      projectId:
        query.projectId === undefined
          ? undefined
          : query.projectId === 'general'
            ? null
            : query.projectId,
      sessionId: query.sessionId,
      statuses: query.status as TaskRecord['status'][] | undefined,
    });
    const readable = new Set<string | null>();
    for (const projectId of new Set(list.map((task) => task.projectId))) {
      if (await canUseProject(request.localUserId, projectId, 'read')) readable.add(projectId);
    }
    return { tasks: list.filter((task) => readable.has(task.projectId)).map(taskResponse) };
  });

  app.put('/tasks/:id', { bodyLimit: 48 * 1024 * 1024 }, async (request, reply) => {
    const { id } = taskParams.parse(request.params);
    const body = putBody.parse(request.body);
    const owner = ownerId(request);
    const previous = await tasks.get(id, owner);
    if (
      previous !== undefined &&
      !(await canUseProject(
        request.localUserId,
        previous.projectId,
        previous.sessionId === null ? 'read' : 'execute',
      ))
    ) {
      reply.code(404);
      return { error: 'task not found' };
    }
    // PUT is capture creation/retry. Edits use PATCH with a revision.
    if (previous !== undefined) return { task: taskResponse(previous) };
    const projectId = body.projectId ?? null;
    const sessionId = body.sessionId ?? null;
    if (
      !(await canUseProject(
        request.localUserId,
        projectId,
        sessionId === null ? 'read' : 'execute',
      ))
    ) {
      reply.code(404);
      return { error: 'project not found' };
    }
    if (!(await sessionFits(sessionId, projectId))) {
      reply.code(400);
      return { error: 'session is not in the task project' };
    }
    try {
      const attachments = [...(body.attachments ?? [])];
      if (attachments.length + (body.uploads?.length ?? 0) > TASK_ATTACHMENTS_MAX)
        return reply.code(400).send({ error: 'too many attachments' });
      if (
        (body.uploads ?? []).reduce((total, upload) => total + upload.data.length, 0) > 45_000_000
      )
        return reply.code(400).send({ error: 'attachments exceed the total size limit' });
      for (const upload of body.uploads ?? []) {
        attachments.push({
          hash: await deps.eventStore.putAttachment(upload.mediaType, upload.data),
          filename:
            upload.kind === 'file'
              ? upload.fileName
              : `image.${upload.mediaType.split('/')[1] ?? 'png'}`,
          mimeType: upload.mediaType,
        });
      }
      const task = await tasks.upsert(
        {
          id,
          ownerUserId: owner,
          projectId,
          sessionId,
          sourceSessionId: body.sourceSessionId ?? null,
          origin: 'user',
          title: body.title,
          detail: body.detail ?? null,
          attachments,
          status: body.status as TaskRecord['status'] | undefined,
          sort: body.sort,
        },
        0,
      );
      await notify(task, null, 'added');
      reply.code(201);
      return { task: taskResponse(task) };
    } catch (error) {
      if (error instanceof TaskRevisionConflictError) {
        const saved = await tasks.get(id, owner);
        if (
          saved !== undefined &&
          (await canUseProject(
            request.localUserId,
            saved.projectId,
            saved.sessionId === null ? 'read' : 'execute',
          ))
        )
          return { task: taskResponse(saved) };
      }
      const handled = failure(reply, error);
      if (handled === undefined) throw error;
      return handled;
    }
  });

  app.patch('/tasks/:id', async (request, reply) => {
    const { id } = taskParams.parse(request.params);
    const body = patchBody.parse(request.body);
    const owner = ownerId(request);
    const previous = await tasks.get(id, owner);
    if (previous === undefined) {
      reply.code(404);
      return { error: 'task not found' };
    }
    const projectId = body.projectId === undefined ? previous.projectId : body.projectId;
    const sessionId = body.sessionId === undefined ? previous.sessionId : body.sessionId;
    if (
      !(await canUseProject(
        request.localUserId,
        previous.projectId,
        previous.sessionId === null ? 'read' : 'execute',
      )) ||
      !(await canUseProject(
        request.localUserId,
        projectId,
        sessionId === null ? 'read' : 'execute',
      ))
    ) {
      reply.code(404);
      return { error: 'project not found' };
    }
    if (
      (body.projectId !== undefined || body.sessionId !== undefined) &&
      !(await sessionFits(sessionId, projectId))
    ) {
      reply.code(400);
      return { error: 'session is not in the task project' };
    }
    const { expectedRevision, ...patch } = body;
    try {
      if (expectedRevision !== undefined && expectedRevision !== previous.revision)
        throw new TaskRevisionConflictError(id, previous.revision);
      const task = await tasks.patch(
        id,
        owner,
        {
          ...patch,
          status: patch.status as TaskRecord['status'] | undefined,
        },
        previous.revision,
      );
      const change =
        task.status === previous.status
          ? 'updated'
          : task.status === 'done'
            ? 'completed'
            : task.status === 'dropped'
              ? 'dropped'
              : 'updated';
      await notify(task, previous.sessionId, change);
      return { task: taskResponse(task) };
    } catch (error) {
      const handled = failure(reply, error);
      if (handled === undefined) throw error;
      return handled;
    }
  });

  app.delete('/tasks/:id', async (request, reply) => {
    const { id } = taskParams.parse(request.params);
    const owner = ownerId(request);
    const previous = await tasks.get(id, owner);
    if (
      previous === undefined ||
      !(await canUseProject(
        request.localUserId,
        previous.projectId,
        previous.sessionId === null ? 'read' : 'execute',
      ))
    ) {
      reply.code(404);
      return { error: 'task not found' };
    }
    try {
      if (!(await tasks.delete(id, owner, previous.revision))) {
        reply.code(404);
        return { error: 'task not found' };
      }
    } catch (error) {
      const handled = failure(reply, error);
      if (handled === undefined) throw error;
      return handled;
    }
    await notify(previous, null, 'deleted');
    return { deleted: true };
  });
}

/** The agent's view of a task: no owner, no revision, attachments as a count. */
function agentTaskView(task: TaskRecord): Record<string, unknown> {
  return {
    id: task.id,
    status: task.status,
    origin: task.origin,
    title: task.title,
    ...(task.detail !== null ? { detail: task.detail } : {}),
    ...(task.attachments.length > 0 ? { attachments: task.attachments.length } : {}),
    ...(task.sessionId === null ? { assigned: false } : {}),
  };
}

/**
 * `verity_tasks` for the MCP gateway (concept §6.1). The gateway binds the call
 * to the session that holds the bearer; the agent never names a session or an
 * owner. Writes land on the user who assigned work to this session, or on the
 * project's creator when nothing is assigned yet.
 */
export async function executeTasksTool(input: {
  eventStore: EventStore;
  publish: (sessionId: string, event: AgentEvent) => Promise<void>;
  sessionId: string;
  projectId: string | null;
  request: TasksRequest;
}): Promise<Record<string, unknown>> {
  const tasks = input.eventStore.tasks;
  const owner = await tasks.agentTaskOwner(input.sessionId, input.projectId);
  if (input.request.action === 'list') {
    const assigned = await tasks.listAssigned(input.sessionId);
    const backlogOwner = await tasks.assignedOwner(input.sessionId);
    if (input.request.scope !== 'project' || backlogOwner === undefined || input.projectId === null)
      return { tasks: assigned.map(agentTaskView) };
    const backlog = (
      await tasks.list({
        ownerUserId: backlogOwner,
        projectId: input.projectId,
        statuses: OPEN_TASK_STATUSES,
      })
    ).filter((task) => task.sessionId === null);
    return { tasks: [...assigned, ...backlog].map(agentTaskView) };
  }
  if (owner === undefined) throw new Error('tasks need a project session or an assigned task');
  const notify = async (
    ids: string[],
    change: 'added' | 'updated' | 'completed' | 'dropped',
  ): Promise<void> => {
    await input.publish(input.sessionId, {
      t: 'tasks_updated',
      origin: 'agent',
      change,
      taskIds: ids,
    });
  };
  if (input.request.action === 'add') {
    const existing = await tasks.listAssigned(input.sessionId);
    let sort = existing.reduce((max, task) => Math.max(max, task.sort), 0);
    const added: TaskRecord[] = [];
    for (const item of input.request.tasks) {
      sort += 1;
      added.push(
        await tasks.upsert({
          id: randomUUID(),
          ownerUserId: owner,
          projectId: input.projectId,
          sessionId: input.sessionId,
          sourceSessionId: input.sessionId,
          origin: 'agent',
          title: item.title,
          detail: item.detail ?? null,
          sort,
        }),
      );
    }
    await notify(
      added.map((task) => task.id),
      'added',
    );
    return { added: added.map((task) => ({ id: task.id, title: task.title })) };
  }
  // The agent may only touch tasks assigned to its own session.
  const request = input.request;
  const target = (await tasks.listAssigned(input.sessionId)).find((task) => task.id === request.id);
  if (target === undefined) throw new TaskNotFoundError(request.id);
  if (request.action === 'update') {
    const task = await tasks.patch(
      target.id,
      target.ownerUserId,
      {
        title: request.title,
        detail: request.detail,
        status: request.status,
      },
      target.revision,
    );
    await notify([task.id], 'updated');
    return { task: agentTaskView(task) };
  }
  const status = request.action === 'complete' ? 'done' : 'dropped';
  const task = await tasks.patch(
    target.id,
    target.ownerUserId,
    { status, result: request.result },
    target.revision,
  );
  await notify([task.id], status === 'done' ? 'completed' : 'dropped');
  const remaining = await tasks.listAssigned(input.sessionId);
  return {
    task: agentTaskView(task),
    remaining: remaining.map((item) => ({ id: item.id, status: item.status, title: item.title })),
  };
}
