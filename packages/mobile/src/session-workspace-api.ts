import { z } from 'zod';

import type { TransportRequestInit } from './api.js';

// Calls that change where a session works: moving it to another project, and
// restoring its code workspace. `VerityClient` carries them as its own methods
// (docs/adr/0029-module-boundaries-and-file-size.md).

const sessionMovedSchema = z.object({
  projectId: z.string(),
  worktree: z.string(),
  branch: z.string(),
  contextMode: z.literal('history-handoff'),
  transferred: z.array(z.string()),
  alreadyPresent: z.array(z.string()),
  skipped: z.array(z.string()),
  retainedWorktree: z.string(),
  retainedBranch: z.string(),
});
export type SessionMoved = z.infer<typeof sessionMovedSchema>;

const codeWorkspaceRestoredSchema = z.object({
  /** False when the session already had its code workspace. */
  restored: z.boolean(),
  worktree: z.string().optional(),
  branch: z.string().optional(),
  source: z.enum(['adopted', 'journal', 'branch', 'origin', 'fresh']).optional(),
});
export type CodeWorkspaceRestored = z.infer<typeof codeWorkspaceRestoredSchema>;

type Request = (path: string, init: TransportRequestInit) => Promise<Response>;

/** The session workspace calls, bound to the client's `request`. */
export function sessionWorkspaceClient(request: Request) {
  return {
    /** Move a session to another project; commits stay unless `onCommits` is `leave`. */
    moveSession: async (
      id: string,
      body: { project: string; operationId: string; onCommits?: 'block' | 'leave' },
    ): Promise<SessionMoved> => {
      const response = await request(`/sessions/${encodeURIComponent(id)}/project`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return sessionMovedSchema.parse(await response.json());
    },

    /** Bring back a session's missing code checkout, or convert a legacy Documents
     *  session to a code session. 409 when it cannot be restored or a turn is running. */
    restoreSessionCodeWorkspace: async (id: string): Promise<CodeWorkspaceRestored> => {
      const response = await request(`/sessions/${encodeURIComponent(id)}/code-workspace/restore`, {
        method: 'POST',
      });
      return codeWorkspaceRestoredSchema.parse(await response.json());
    },
  };
}
