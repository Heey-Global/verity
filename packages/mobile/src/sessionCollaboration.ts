import { z } from 'zod';

/** One session this session works with, as `GET /sessions/:id/collaboration` reports it. */
const collaborationEntrySchema = z.object({
  sessionId: z.string(),
  sessionName: z.string().nullable(),
  projectId: z.string(),
  projectName: z.string(),
  /** `asked`: this session asked; `askedBy`: the peer asked; `handedOver`: this session started it. */
  direction: z.enum(['asked', 'askedBy', 'handedOver']),
  state: z.enum(['waitingForYou', 'working', 'answer', 'done']),
  updatedAt: z.string().datetime(),
  /** `current` belongs in the header row; `earlier` only under Earlier in the sheet. */
  section: z.enum(['current', 'earlier']),
});
export type CollaborationEntry = z.infer<typeof collaborationEntrySchema>;
export type CollaborationDirection = CollaborationEntry['direction'];
export type CollaborationState = CollaborationEntry['state'];

const responseSchema = z.object({ entries: z.array(collaborationEntrySchema) });

/** Uses the client's authenticated transport; the route is read-only. */
export function createSessionCollaborationClient(
  request: (path: string, init: { method: 'GET'; signal?: AbortSignal }) => Promise<Response>,
) {
  return {
    async read(sessionId: string, signal?: AbortSignal): Promise<CollaborationEntry[]> {
      const response = await request(
        `/sessions/${encodeURIComponent(sessionId)}/collaboration`,
        signal ? { method: 'GET', signal } : { method: 'GET' },
      );
      return responseSchema.parse(await response.json()).entries;
    },
  };
}
