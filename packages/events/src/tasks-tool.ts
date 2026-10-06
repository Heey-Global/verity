import { z } from 'zod';

/** Verity gateway tool through which an agent reads and writes its assigned tasks
 *  (docs/TASKS_AND_QUICK_CAPTURE_CONCEPT.md §6). */
export const TASKS_TOOL = 'verity_tasks';

export const TASK_TITLE_MAX = 2_000;
export const TASK_DETAIL_MAX = 20_000;
export const TASK_RESULT_MAX = 2_000;
/** Most tasks one `add` call may create; an audit rarely yields more. */
export const TASKS_ADD_MAX = 30;

const taskId = z.string().trim().min(1).max(128);
const title = z.string().trim().min(1).max(TASK_TITLE_MAX);
const detail = z.string().trim().min(1).max(TASK_DETAIL_MAX);
const result = z.string().trim().min(1).max(TASK_RESULT_MAX);

export const tasksRequestSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('list'),
      /** `session` (default): tasks assigned to this session. `project`: also the
       *  owner's unassigned tasks in this session's project. */
      scope: z.enum(['session', 'project']).optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal('add'),
      tasks: z
        .array(z.object({ title, detail: detail.optional() }).strict())
        .min(1)
        .max(TASKS_ADD_MAX),
    })
    .strict(),
  z
    .object({
      action: z.literal('update'),
      id: taskId,
      title: title.optional(),
      detail: detail.optional(),
      status: z.enum(['open', 'in_progress']).optional(),
    })
    .strict(),
  z.object({ action: z.literal('complete'), id: taskId, result }).strict(),
  z.object({ action: z.literal('drop'), id: taskId, result }).strict(),
]);
export type TasksRequest = z.infer<typeof tasksRequestSchema>;

export const TASKS_TOOL_DESCRIPTION = `Read and update the durable task list assigned to this session. Tasks survive context compaction, backend switches and restarts, and the user sees them in the app. "list" returns this session's open tasks (scope "project" adds the user's unassigned tasks in this project). "add" records several follow-up steps at once, each self-contained with the context needed to do it in a fresh session. "update" changes title, detail or marks a task in_progress. "complete" needs a one-line result after the work is verified; "drop" needs the reason. The server binds every call to the calling session; no session id can be supplied, and tasks cannot be deleted from here.`;

/** Sent with every context, fresh or resumed: when the durable list applies. */
export const TASKS_SYSTEM_PROMPT = `# Tasks (Verity)

Verity keeps a durable task list per user, shown in the app and edited through \`${TASKS_TOOL}\`; your native checklist stays the plan for the current turn. Record tasks when three or more follow-up steps will not be finished in this turn (audit findings, review results, "later") or when the user asks for a list, each written so a fresh session could do it alone, with file, risk and proposed fix in \`detail\`. Mark a task in_progress when you start it, complete it only after verification with a one-line result, and drop it with a reason instead of leaving it open. Tasks assigned to this session appear under "Assigned tasks" in your context: keep their status current, and end a turn by naming what is still open, offering the next task as a Quick Action.`;

/** The compact reminder a resumed context carries on every message: the full
 *  rules above arrived with its fresh context, so only the tool and the status
 *  duty are restated. */
export const TASKS_RESUME_SYSTEM_PROMPT = `# Tasks (Verity)

Durable tasks live in \`${TASKS_TOOL}\`, separate from your per-turn checklist. Record follow-up work that outlives this turn there, keep the status of tasks listed under "Assigned tasks" current, and end a turn by naming what is still open.`;

/** The fields the per-turn prompt needs from a task; the store record is wider. */
export interface AssignedTaskSummary {
  id: string;
  title: string;
  status: 'open' | 'in_progress';
  attachments: number;
}

/** Most tasks the injected section lists before it truncates. */
export const ASSIGNED_TASKS_PROMPT_MAX = 30;
/** Longest title the injected section shows per task. */
const ASSIGNED_TASK_TITLE_MAX = 160;

/** The "Assigned tasks" section appended to a session's turn prompt. Rebuilt from
 *  the store on every turn, so compaction or a backend switch cannot lose it.
 *  Empty string when the session has nothing assigned. */
export function renderAssignedTasksPrompt(tasks: readonly AssignedTaskSummary[]): string {
  if (tasks.length === 0) return '';
  const shown = tasks.slice(0, ASSIGNED_TASKS_PROMPT_MAX);
  const lines = shown.map((task) => {
    const title = oneLine(task.title, ASSIGNED_TASK_TITLE_MAX);
    const state = task.status === 'in_progress' ? ' (in progress)' : '';
    const files =
      task.attachments > 0
        ? ` · ${String(task.attachments)} attachment${task.attachments === 1 ? '' : 's'}`
        : '';
    return `- #${task.id}${state} ${title}${files}`;
  });
  const more = tasks.length - shown.length;
  if (more > 0) lines.push(`- … ${String(more)} more; call ${TASKS_TOOL} list for all`);
  return `# Assigned tasks (${TASKS_TOOL})

Open tasks the user assigned to this session. Update their status with ${TASKS_TOOL} as you work.
${lines.join('\n')}`;
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
