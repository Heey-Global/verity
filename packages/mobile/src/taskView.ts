import { VerityApiError } from './api.js';
import type { Task } from './tasks.js';

const SHOWN_STATUSES = 'open,in_progress,done';

/** Whether a task belongs in the views: the operator's own list, and the steps
 *  agents recorded in the sessions a view is open for. Dropped tasks never show. */
export function isViewedTask(task: Task, sessionIds: readonly string[]): boolean {
  if (task.status === 'dropped') return false;
  return task.origin === 'user' || (task.sessionId !== null && sessionIds.includes(task.sessionId));
}

/**
 * Reads only the tasks the open views show. Every agent session records its
 * working steps as tasks of the operator, so the unfiltered list grows with
 * every session ever run, while a view shows the steps of one session at most.
 */
export async function listTaskView(
  api: { listTasks(query?: string): Promise<Task[]> },
  sessionIds: readonly string[],
): Promise<Task[]> {
  try {
    const [mine = [], ...steps] = await Promise.all([
      api.listTasks(`?origin=user&status=${SHOWN_STATUSES}`),
      ...sessionIds.map((id) =>
        api.listTasks(`?origin=agent&status=${SHOWN_STATUSES}&sessionId=${encodeURIComponent(id)}`),
      ),
    ]);
    return [...mine, ...steps.flat()];
  } catch (error) {
    // A server without the origin filter refuses the query; it can only send everything.
    if (!(error instanceof VerityApiError) || error.status !== 400) throw error;
    return (await api.listTasks()).filter((task) => isViewedTask(task, sessionIds));
  }
}
