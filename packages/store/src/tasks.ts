import { sql, type Kysely, type Selectable } from 'kysely';

import { createPassthroughCipher, type SecretCipher } from './crypto.js';
import type { Database, TaskAttachment, TaskOrigin, TaskStatus, TasksTable } from './schema.js';

export type { TaskAttachment, TaskOrigin, TaskStatus } from './schema.js';

export const TASK_STATUSES: readonly TaskStatus[] = ['open', 'in_progress', 'done', 'dropped'];
/** Statuses that count as "still to do": what the badge counts and the conductor injects. */
export const OPEN_TASK_STATUSES: readonly TaskStatus[] = ['open', 'in_progress'];

export interface TaskRecord {
  id: string;
  ownerUserId: string;
  /** `null` is the General bucket. */
  projectId: string | null;
  /** The session the task is assigned to; what that session's agent sees. */
  sessionId: string | null;
  /** Where the task was captured, for display only. */
  sourceSessionId: string | null;
  origin: TaskOrigin;
  title: string;
  detail: string | null;
  attachments: TaskAttachment[];
  status: TaskStatus;
  result: string | null;
  sort: number;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
}

export interface TaskInput {
  /** Client-minted id, so a retried save cannot create a duplicate. */
  id: string;
  ownerUserId: string;
  projectId?: string | null | undefined;
  sessionId?: string | null | undefined;
  sourceSessionId?: string | null | undefined;
  origin: TaskOrigin;
  title: string;
  detail?: string | null | undefined;
  attachments?: TaskAttachment[] | undefined;
  status?: TaskStatus | undefined;
  sort?: number | undefined;
}

export interface TaskPatch {
  projectId?: string | null | undefined;
  sessionId?: string | null | undefined;
  title?: string | undefined;
  detail?: string | null | undefined;
  attachments?: TaskAttachment[] | undefined;
  status?: TaskStatus | undefined;
  result?: string | null | undefined;
  sort?: number | undefined;
}

export interface TaskListFilter {
  ownerUserId: string;
  /** `undefined` = any project; `null` = General only. */
  projectId?: string | null | undefined;
  sessionId?: string | undefined;
  statuses?: readonly TaskStatus[] | undefined;
}

export class TaskNotFoundError extends Error {
  constructor(id: string) {
    super(`task ${id} not found`);
    this.name = 'TaskNotFoundError';
  }
}

/** `expectedRevision` did not match: someone else wrote the task in between. */
export class TaskRevisionConflictError extends Error {
  constructor(
    readonly id: string,
    readonly currentRevision: number,
  ) {
    super(`task ${id} is at revision ${currentRevision}`);
    this.name = 'TaskRevisionConflictError';
  }
}

export class TaskInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaskInputError';
  }
}

export const TASK_TITLE_MAX = 2_000;
export const TASK_DETAIL_MAX = 20_000;
export const TASK_RESULT_MAX = 2_000;
export const TASK_ATTACHMENTS_MAX = 20;

function normalizeTitle(title: string): string {
  const trimmed = title.trim();
  if (trimmed.length === 0) throw new TaskInputError('task title must not be empty');
  if (trimmed.length > TASK_TITLE_MAX)
    throw new TaskInputError(`task title exceeds ${TASK_TITLE_MAX} characters`);
  return trimmed;
}

function normalizeOptionalText(
  value: string | null | undefined,
  max: number,
  label: string,
): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > max) throw new TaskInputError(`task ${label} exceeds ${max} characters`);
  return trimmed;
}

function normalizeAttachments(attachments: TaskAttachment[] | undefined): TaskAttachment[] {
  if (attachments === undefined) return [];
  if (attachments.length > TASK_ATTACHMENTS_MAX)
    throw new TaskInputError(`a task can carry at most ${TASK_ATTACHMENTS_MAX} attachments`);
  return attachments.map((a) => ({ hash: a.hash, filename: a.filename, mimeType: a.mimeType }));
}

function isTerminal(status: TaskStatus): boolean {
  return status === 'done' || status === 'dropped';
}

/**
 * Owner-scoped persistence for tasks. Every read and write takes the owner so
 * that a task id alone never grants access; the one exception is
 * {@link listAssigned}, which the conductor uses to build a session's prompt and
 * which is scoped by session instead.
 */
export class TaskStore {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly cipher: SecretCipher = createPassthroughCipher(),
  ) {}

  async list(filter: TaskListFilter): Promise<TaskRecord[]> {
    let query = this.db
      .selectFrom('tasks')
      .selectAll()
      .where('owner_user_id', '=', filter.ownerUserId);
    if (filter.projectId === null) query = query.where('project_id', 'is', null);
    else if (filter.projectId !== undefined)
      query = query.where('project_id', '=', filter.projectId);
    if (filter.sessionId !== undefined) query = query.where('session_id', '=', filter.sessionId);
    if (filter.statuses !== undefined && filter.statuses.length > 0)
      query = query.where('status', 'in', [...filter.statuses]);
    const rows = await query.orderBy('sort', 'asc').orderBy('created_at', 'asc').execute();
    return rows.map((row) => this.record(row));
  }

  /** Open and in-progress tasks assigned to a session, in list order. Not owner
   *  scoped: the owner assigned them to this session on purpose. */
  async listAssigned(sessionId: string): Promise<TaskRecord[]> {
    const rows = await this.db
      .selectFrom('tasks')
      .selectAll()
      .where('session_id', '=', sessionId)
      .where('status', 'in', [...OPEN_TASK_STATUSES])
      .orderBy('sort', 'asc')
      .orderBy('created_at', 'asc')
      .execute();
    return rows.map((row) => this.record(row));
  }

  /** The owner of the tasks assigned to a session, when there is exactly one.
   *  Lets an agent call attribute new tasks to the user who handed it work. */
  async assignedOwner(sessionId: string): Promise<string | undefined> {
    const rows = await this.db
      .selectFrom('tasks')
      .select('owner_user_id')
      .distinct()
      .where('session_id', '=', sessionId)
      .execute();
    return rows.length === 1 ? rows[0]?.owner_user_id : undefined;
  }

  async get(id: string, ownerUserId: string): Promise<TaskRecord | undefined> {
    const row = await this.db
      .selectFrom('tasks')
      .selectAll()
      .where('id', '=', id)
      .where('owner_user_id', '=', ownerUserId)
      .executeTakeFirst();
    return row ? this.record(row) : undefined;
  }

  /** Who new agent-written tasks in a session belong to: the owner of the tasks
   *  already assigned to it, otherwise the project's creator. Turns carry no user
   *  identity yet (ADR 0023), so this is the closest durable attribution. */
  async agentTaskOwner(sessionId: string, projectId: string | null): Promise<string | undefined> {
    const assigned = await this.assignedOwner(sessionId);
    if (assigned !== undefined) return assigned;
    if (projectId === null) return undefined;
    const project = await this.db
      .selectFrom('projects')
      .select('created_by_user_id')
      .where('id', '=', projectId)
      .executeTakeFirst();
    return project?.created_by_user_id;
  }

  /**
   * Create a task, or replace it when the same owner already saved this id. A
   * retry after a lost response therefore converges on one row. Replacing keeps
   * the row's revision counter moving so other devices notice the change.
   */
  async upsert(input: TaskInput): Promise<TaskRecord> {
    const title = this.cipher.encrypt(normalizeTitle(input.title));
    const detail = normalizeOptionalText(input.detail, TASK_DETAIL_MAX, 'detail');
    const attachments = JSON.stringify(normalizeAttachments(input.attachments));
    const status = input.status ?? 'open';
    const now = new Date().toISOString();
    const row = await this.db
      .insertInto('tasks')
      .values({
        id: input.id,
        owner_user_id: input.ownerUserId,
        project_id: input.projectId ?? null,
        session_id: input.sessionId ?? null,
        source_session_id: input.sourceSessionId ?? null,
        origin: input.origin,
        title,
        detail: detail === null ? null : this.cipher.encrypt(detail),
        attachments,
        status,
        sort: input.sort ?? 0,
        completed_at: isTerminal(status) ? now : null,
      })
      .onConflict((conflict) =>
        conflict
          .column('id')
          .doUpdateSet({
            project_id: input.projectId ?? null,
            session_id: input.sessionId ?? null,
            title,
            detail: detail === null ? null : this.cipher.encrypt(detail),
            attachments,
            status,
            sort: input.sort ?? 0,
            revision: sql<number>`tasks.revision + 1`,
            updated_at: now,
            completed_at: isTerminal(status)
              ? sql`coalesce(tasks.completed_at, ${now}::timestamptz)`
              : null,
          })
          .where('tasks.owner_user_id', '=', input.ownerUserId),
      )
      .returningAll()
      .executeTakeFirst();
    if (row === undefined) throw new TaskNotFoundError(input.id);
    return this.record(row);
  }

  /**
   * Partial update. With `expectedRevision` the write only lands on the revision
   * the caller last saw; a mismatch throws {@link TaskRevisionConflictError} so
   * an offline queue can re-read instead of silently overwriting an agent's
   * status change.
   */
  async patch(
    id: string,
    ownerUserId: string,
    patch: TaskPatch,
    expectedRevision?: number,
  ): Promise<TaskRecord> {
    const existing = await this.db
      .selectFrom('tasks')
      .select(['status', 'revision'])
      .where('id', '=', id)
      .where('owner_user_id', '=', ownerUserId)
      .executeTakeFirst();
    if (existing === undefined) throw new TaskNotFoundError(id);
    if (expectedRevision !== undefined && existing.revision !== expectedRevision)
      throw new TaskRevisionConflictError(id, existing.revision);
    const values: Partial<Record<keyof TasksTable, unknown>> = {};
    if (patch.projectId !== undefined) values.project_id = patch.projectId;
    if (patch.sessionId !== undefined) values.session_id = patch.sessionId;
    if (patch.title !== undefined) values.title = this.cipher.encrypt(normalizeTitle(patch.title));
    if (patch.detail !== undefined) {
      const detail = normalizeOptionalText(patch.detail, TASK_DETAIL_MAX, 'detail');
      values.detail = detail === null ? null : this.cipher.encrypt(detail);
    }
    if (patch.attachments !== undefined)
      values.attachments = JSON.stringify(normalizeAttachments(patch.attachments));
    if (patch.result !== undefined) {
      const result = normalizeOptionalText(patch.result, TASK_RESULT_MAX, 'result');
      values.result = result === null ? null : this.cipher.encrypt(result);
    }
    if (patch.sort !== undefined) values.sort = patch.sort;
    if (patch.status !== undefined) {
      values.status = patch.status;
      Object.assign(values, completedAtFor(existing.status, patch.status));
    }
    const row = await this.db
      .updateTable('tasks')
      .set({
        ...(values as Partial<TasksTable>),
        revision: existing.revision + 1,
        updated_at: new Date().toISOString(),
      } as never)
      .where('id', '=', id)
      .where('owner_user_id', '=', ownerUserId)
      .where('revision', '=', existing.revision)
      .returningAll()
      .executeTakeFirst();
    // Lost the race between the read and the write: report the newer revision.
    if (row === undefined) {
      const current = await this.db
        .selectFrom('tasks')
        .select('revision')
        .where('id', '=', id)
        .executeTakeFirst();
      if (current === undefined) throw new TaskNotFoundError(id);
      throw new TaskRevisionConflictError(id, current.revision);
    }
    return this.record(row);
  }

  async delete(id: string, ownerUserId: string): Promise<boolean> {
    const result = await this.db
      .deleteFrom('tasks')
      .where('id', '=', id)
      .where('owner_user_id', '=', ownerUserId)
      .executeTakeFirst();
    return (result.numDeletedRows ?? 0n) > 0n;
  }

  private record(row: Selectable<TasksTable>): TaskRecord {
    return {
      id: row.id,
      ownerUserId: row.owner_user_id,
      projectId: row.project_id,
      sessionId: row.session_id,
      sourceSessionId: row.source_session_id,
      origin: row.origin,
      title: this.cipher.decrypt(row.title),
      detail: row.detail === null ? null : this.cipher.decrypt(row.detail),
      attachments: row.attachments,
      status: row.status,
      result: row.result === null ? null : this.cipher.decrypt(row.result),
      sort: row.sort,
      revision: row.revision,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      completedAt: row.completed_at,
    };
  }
}

/** `completed_at` follows the status: set when a task becomes done or dropped,
 *  cleared when it is reopened, untouched otherwise. */
function completedAtFor(previous: TaskStatus, next: TaskStatus): { completed_at?: string | null } {
  if (isTerminal(next) && !isTerminal(previous)) return { completed_at: new Date().toISOString() };
  if (!isTerminal(next) && isTerminal(previous)) return { completed_at: null };
  return {};
}
