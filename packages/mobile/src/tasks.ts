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
export const TASK_SILENCE_MS = 1500;
export const TASK_SAVE_DELAY_MS = 3000;
