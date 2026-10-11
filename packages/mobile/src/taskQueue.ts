import { z } from 'zod';
import {
  taskSchema,
  taskCaptureSchema,
  taskPatchSchema,
  type Task,
  type TaskCapture,
  type TaskPatch,
} from './tasks.js';

const operationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('create'), id: z.string(), body: taskCaptureSchema }),
  z.object({ kind: z.literal('patch'), id: z.string(), body: taskPatchSchema }),
  z.object({ kind: z.literal('delete'), id: z.string() }),
]);
const stateSchema = z.object({
  tasks: z.array(taskSchema),
  pending: z.array(operationSchema),
  conflicts: z.array(z.string()),
  errors: z.record(z.string(), z.string()).optional(),
});
export type TaskQueueState = z.infer<typeof stateSchema>;
interface Dependencies {
  load: () => Promise<string | null>;
  persist: (data: string) => Promise<void>;
  api: {
    listTasks(): Promise<Task[]>;
    saveTask(id: string, body: TaskCapture): Promise<Task>;
    updateTask(id: string, body: TaskPatch): Promise<Task>;
    deleteTask(id: string): Promise<void>;
  };
  active: () => boolean;
  changed: (state: TaskQueueState) => void;
}

/** One server/credential pair. Local saves never wait behind a network request. */
export class TaskQueue {
  private state: TaskQueueState = { tasks: [], pending: [], conflicts: [] };
  private chain: Promise<unknown> = Promise.resolve();
  private syncing: Promise<void> | null = null;
  private retryAt = 0;
  private failures = 0;
  constructor(private readonly deps: Dependencies) {}
  private serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.chain.then(run);
    this.chain = next.catch(() => undefined);
    return next;
  }
  private async commit(next: TaskQueueState): Promise<void> {
    await this.deps.persist(JSON.stringify(next));
    this.state = next;
    if (this.deps.active()) this.deps.changed(next);
  }
  restore(): Promise<void> {
    return this.serial(async () => {
      const data = await this.deps.load();
      if (data) this.state = stateSchema.parse(JSON.parse(data));
      if (this.deps.active()) this.deps.changed(this.state);
    });
  }
  create(task: Task, body: TaskCapture): Promise<void> {
    return this.serial(async () => {
      if (!this.deps.active()) throw new Error('Sign in again before saving');
      // A capture handed over again with its original id (a watch recording
      // redelivered after a crash) is already here; a second row would sync twice.
      if (this.state.tasks.some((existing) => existing.id === task.id)) return;
      await this.commit({
        ...this.state,
        tasks: [...this.state.tasks, task],
        pending: [...this.state.pending, { kind: 'create', id: task.id, body }],
      });
    });
  }
  patch(id: string, body: TaskPatch): Promise<void> {
    return this.serial(async () => {
      if (!this.deps.active()) throw new Error('Sign in again before editing');
      const current = this.state.tasks.find((task) => task.id === id);
      if (!current) throw new Error('Task no longer exists');
      const rejectedCapture = this.state.pending.find(
        (op) => op.id === id && op.kind === 'create' && this.state.conflicts.includes(id),
      );
      if (rejectedCapture?.kind === 'create') {
        const edits = this.state.pending.reduce<Record<string, unknown>>(
          (merged, op) =>
            op.id === id && op.kind === 'patch' ? { ...merged, ...op.body } : merged,
          {},
        );
        const patch = { ...edits, ...body, expectedRevision: 0 };
        const capture = taskCaptureSchema.parse({ ...rejectedCapture.body, ...patch });
        await this.commit({
          ...this.state,
          tasks: this.state.tasks.map((task) =>
            task.id === id ? taskSchema.parse({ ...task, ...body, revision: 0 }) : task,
          ),
          pending: [
            ...this.state.pending.filter((op) => op.id !== id),
            { ...rejectedCapture, body: capture },
            { kind: 'patch', id, body: taskPatchSchema.parse(patch) },
          ],
          conflicts: this.state.conflicts.filter((item) => item !== id),
        });
        return;
      }
      // A sync may have advanced the revision while the row was being edited.
      // Preserve the row's original revision; stale writes must conflict.
      await this.commit({
        ...this.state,
        tasks: this.state.tasks.map((task) =>
          task.id === id
            ? taskSchema.parse({
                ...task,
                ...Object.fromEntries(
                  Object.entries(body).filter(([, value]) => value !== undefined),
                ),
                revision: task.revision,
                updatedAt: new Date().toISOString(),
              })
            : task,
        ),
        pending: [...this.state.pending, { kind: 'patch', id, body }],
      });
    });
  }
  delete(id: string): Promise<void> {
    return this.serial(async () => {
      if (!this.deps.active()) throw new Error('Sign in again before deleting');
      await this.commit({
        ...this.state,
        tasks: this.state.tasks.filter((task) => task.id !== id),
        pending: [
          ...this.state.pending.filter(
            (op) => op.id !== id || (op.kind === 'create' && !this.state.conflicts.includes(id)),
          ),
          { kind: 'delete', id },
        ],
        conflicts: this.state.conflicts.filter((item) => item !== id),
      });
    });
  }
  /** The user chooses whether the remote copy or their retained edit wins. */
  async resolve(id: string, keepLocal: boolean): Promise<void> {
    if (!this.deps.active()) return;
    const remote = (await this.deps.api.listTasks()).find((task) => task.id === id);
    if (!this.deps.active()) return;
    await this.serial(async () => {
      if (!this.deps.active()) return;
      const edits = this.state.pending.filter((op) => op.id === id && op.kind === 'patch');
      const pending = this.state.pending.filter((op) => op.id !== id);
      if (keepLocal && remote) {
        const body = taskPatchSchema.parse(
          Object.assign(
            { expectedRevision: remote.revision },
            ...edits.map((op) => (op.kind === 'patch' ? op.body : {})),
            { expectedRevision: remote.revision },
          ),
        );
        pending.push({ kind: 'patch', id, body });
      }
      if (keepLocal && !remote)
        throw new Error('This task was deleted. Copy your text into a new task.');
      await this.commit({
        tasks: keepLocal
          ? this.state.tasks
          : [...this.state.tasks.filter((task) => task.id !== id), ...(remote ? [remote] : [])],
        pending,
        conflicts: this.state.conflicts.filter((item) => item !== id),
      });
    });
  }
  sync(force = false): Promise<void> {
    if (!force && Date.now() < this.retryAt) return Promise.resolve();
    if (this.syncing) return this.syncing;
    const run = this.flush().then(
      () => {
        this.failures = 0;
        this.retryAt = 0;
      },
      (error: unknown) => {
        this.retryAt = Date.now() + Math.min(300000, 15000 * 2 ** this.failures++);
        throw error;
      },
    );
    this.syncing = run;
    void run
      .finally(() => {
        if (this.syncing === run) this.syncing = null;
      })
      .catch(() => undefined);
    return run;
  }
  private async flush(): Promise<void> {
    await this.chain;
    while (this.deps.active()) {
      const op = this.state.pending.find((item) => !this.state.conflicts.includes(item.id));
      if (!op) break;
      let saved: Task | undefined;
      try {
        if (op.kind === 'create') saved = await this.deps.api.saveTask(op.id, op.body);
        else if (op.kind === 'patch') saved = await this.deps.api.updateTask(op.id, op.body);
        else await this.deps.api.deleteTask(op.id);
      } catch (error) {
        if (!this.deps.active()) return;
        if (!this.state.pending.includes(op)) continue;
        const status =
          error && typeof error === 'object' && 'status' in error ? error.status : undefined;
        if (status === 404 && op.kind === 'delete') {
          await this.serial(() =>
            this.commit({
              ...this.state,
              pending: this.state.pending.filter((item) => item !== op),
            }),
          );
          continue;
        }
        if (
          status === 409 ||
          status === 400 ||
          status === 403 ||
          status === 404 ||
          status === 413 ||
          status === 422
        ) {
          await this.serial(() =>
            this.commit({
              ...this.state,
              conflicts: [...new Set([...this.state.conflicts, op.id])],
              errors: {
                ...this.state.errors,
                [op.id]: error instanceof Error ? error.message : 'Task was rejected by the server',
              },
            }),
          );
          continue;
        }
        throw error;
      }
      if (!this.deps.active()) return;
      await this.serial(async () => {
        const pending = this.state.pending
          .filter((item) => item !== op)
          .map((item) => ({ ...item }));
        if (saved) {
          const next = pending.find((item) => item.id === op.id);
          if (
            next?.kind === 'patch' &&
            next.body.expectedRevision === (op.kind === 'patch' ? op.body.expectedRevision : 0)
          )
            next.body = { ...next.body, expectedRevision: saved.revision };
        }
        const hasLater = pending.some((item) => item.id === op.id);
        await this.commit({
          ...this.state,
          pending,
          tasks: saved
            ? this.state.tasks.map((task) =>
                task.id === saved.id
                  ? hasLater
                    ? { ...task, attachments: saved.attachments, revision: saved.revision }
                    : saved
                  : task,
              )
            : this.state.tasks,
        });
      });
    }
    if (!this.deps.active()) return;
    const remote = await this.deps.api.listTasks();
    if (!this.deps.active()) return;
    await this.serial(async () => {
      const pendingIds = new Set(this.state.pending.map((op) => op.id));
      await this.commit({
        ...this.state,
        tasks: [
          ...remote.filter((task) => !pendingIds.has(task.id)),
          ...this.state.tasks.filter((task) => pendingIds.has(task.id)),
        ],
      });
    });
  }
}
