import { VerityApiError } from './api.js';
import type { Task } from './tasks.js';

const SHOWN_STATUSES = 'open,in_progress,done';
/** How far back a view shows done tasks; matches the server's default list. */
export const DONE_TASK_VIEW_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

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
  now: () => number = Date.now,
): Promise<Task[]> {
  // Without a window every done task the operator ever closed is read on each refresh.
  const shown = `status=${SHOWN_STATUSES}&doneSince=${encodeURIComponent(
    new Date(now() - DONE_TASK_VIEW_WINDOW_MS).toISOString(),
  )}`;
  try {
    const [mine = [], ...steps] = await Promise.all([
      api.listTasks(`?origin=user&${shown}`),
      ...sessionIds.map((id) =>
        api.listTasks(`?origin=agent&${shown}&sessionId=${encodeURIComponent(id)}`),
      ),
    ]);
    return [...mine, ...steps.flat()];
  } catch (error) {
    // A server without the origin or doneSince filter refuses the query; it can only send
    // everything.
    if (!(error instanceof VerityApiError) || error.status !== 400) throw error;
    return (await api.listTasks()).filter((task) => isViewedTask(task, sessionIds));
  }
}
