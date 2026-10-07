import { z } from 'zod';
import { attachmentUploadSchema } from '@verity/events';

export const taskSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().nullable(),
  sessionId: z.string().nullable(),
  sourceSessionId: z.string().nullable(),
  origin: z.enum(['user', 'agent']),
  title: z.string(),
  detail: z.string().nullable(),
  attachments: z.array(z.object({ hash: z.string(), filename: z.string(), mimeType: z.string() })),
  status: z.enum(['open', 'in_progress', 'done', 'dropped']),
  result: z.string().nullable(),
  sort: z.number(),
  revision: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
  completedAt: z.string().nullable(),
});
export type Task = z.infer<typeof taskSchema>;
export const taskCaptureSchema = z.object({
  title: z.string(),
  projectId: z.string().nullable(),
  detail: z.string().nullable().optional(),
  sourceSessionId: z.string().nullable().optional(),
  uploads: z.array(attachmentUploadSchema).optional(),
});
export const taskPatchSchema = taskSchema
  .pick({
    title: true,
    detail: true,
    projectId: true,
    sessionId: true,
    status: true,
    result: true,
    sort: true,
    origin: true,
  })
  .partial()
  .extend({ expectedRevision: z.number().int().nonnegative() });
export type TaskCapture = z.infer<typeof taskCaptureSchema>;
export type TaskPatch = z.infer<typeof taskPatchSchema>;
export interface TaskContext {
  projectId: string | null;
  sessionId: string | null;
}
export function taskContext(
  pathname: string,
  params: { id?: string; selected?: string },
  sessions: readonly { sessionId: string; projectId?: string | null }[],
): TaskContext {
  const sessionId = pathname.startsWith('/session/')
    ? params.id
    : pathname === '/'
      ? params.selected
      : undefined;
  if (sessionId)
    return {
      sessionId,
      projectId: sessions.find((s) => s.sessionId === sessionId)?.projectId ?? null,
    };
  return {
    sessionId: null,
    projectId: pathname.startsWith('/project/') ? (params.id ?? null) : null,
  };
}
/** "just now", "5 min ago", "2 h ago", "yesterday", "3 days ago": the age a task
 *  row shows. Coarse on purpose; the exact time is not what the list is for. */
export function taskAge(createdAt: string, now = Date.now()): string {
  const elapsed = Math.max(0, now - Date.parse(createdAt));
  const minutes = Math.floor(elapsed / 60_000);
  if (Number.isNaN(minutes) || minutes < 1) return 'just now';
  if (minutes < 60) return `${String(minutes)} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${String(hours)} h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 30) return `${String(days)} days ago`;
  const months = Math.floor(days / 30);
  return months === 1 ? '1 month ago' : `${String(months)} months ago`;
}

export interface BubbleRest {
  side: 'left' | 'right';
  y: number;
}

/**
 * Where a flung capture bubble comes to rest. A sideways fling picks the edge it
 * was thrown towards; a slow release docks at the nearer edge. Vertical momentum
 * carries the bubble on past the finger before it settles, clamped to the band
 * the screen allows. Velocities are in points per millisecond, as the gesture
 * responder reports them.
 */
export function bubbleRestingPlace(input: {
  x: number;
  y: number;
  vx: number;
  vy: number;
  width: number;
  top: number;
  bottom: number;
}): BubbleRest {
  const FLING = 0.3;
  // How far a vertical throw travels: momentum scaled by a decay horizon.
  const CARRY_MS = 220;
  const side =
    Math.abs(input.vx) > FLING
      ? input.vx < 0
        ? 'left'
        : 'right'
      : input.x < input.width / 2
        ? 'left'
        : 'right';
  const carried = input.y + input.vy * CARRY_MS;
  return { side, y: Math.max(input.top, Math.min(input.bottom, carried)) };
}

export const TASK_SILENCE_MS = 1500;
export const TASK_SAVE_DELAY_MS = 3000;
