import { z } from 'zod';

import type { TransportRequestInit } from './api.js';

// Change submissions (ADR 0023): a member without Code submits a session's
// changes, and members with Code check and add them. The server derives where a
// submission stands; the app only shows it.

const personSchema = z.object({ id: z.string().min(1), name: z.string().optional() });
export type ChangeSubmissionPerson = z.infer<typeof personSchema>;

export const changeSubmissionSchema = z.object({
  status: z.enum(['waiting', 'checking', 'adding', 'added']),
  submittedBy: personSchema,
  /** The first member with Code who wrote in the session after the submission. */
  checker: personSchema.optional(),
  submittedAt: z.number(),
  /** Session list only: whether checking the changes waits on the requester.
   *  ABSENT = no accounts, where the one operator holds every right. */
  addressedToViewer: z.boolean().optional(),
});
export type ChangeSubmission = z.infer<typeof changeSubmissionSchema>;

/** On a session summary: a value this build cannot read is treated as absent. */
export const sessionChangeSubmissionSchema = changeSubmissionSchema.optional().catch(undefined);

const stateSchema = z.object({
  submission: changeSubmissionSchema.nullable(),
  viewerCanCode: z.boolean(),
  /** Whether the session changed anything the project lacks; absent when unknown. */
  hasChanges: z.boolean().optional(),
});
export type ChangeSubmissionState = z.infer<typeof stateSchema>;

export function changeSubmissionsClient(
  request: (path: string, init: TransportRequestInit) => Promise<Response>,
) {
  const path = (sessionId: string) =>
    `/sessions/${encodeURIComponent(sessionId)}/change-submission`;
  return {
    /** Where the session's submitted changes stand, and whether the viewer may add them. */
    async read(sessionId: string, signal?: AbortSignal): Promise<ChangeSubmissionState> {
      const response = await request(
        path(sessionId),
        signal ? { method: 'GET', signal } : { method: 'GET' },
      );
      return stateSchema.parse(await response.json());
    },
    /** Hand the session's changes to the members with Code. */
    async submit(sessionId: string): Promise<ChangeSubmission | null> {
      const response = await request(path(sessionId), { method: 'POST' });
      return z
        .object({ submission: changeSubmissionSchema.nullable() })
        .parse(await response.json()).submission;
    },
    /** Ask the session agent to commit its work, then add it to the local project. */
    async saveToProject(sessionId: string): Promise<{ accepted: true }> {
      const response = await request(`/sessions/${encodeURIComponent(sessionId)}/save-to-project`, {
        method: 'POST',
      });
      return z.object({ accepted: z.literal(true) }).parse(await response.json());
    },
    /** Take submitted changes back, or, with Code, turn them down. */
    async withdraw(sessionId: string): Promise<void> {
      await request(path(sessionId), { method: 'DELETE' });
    },
  };
}

/**
 * What the project is called in submission text. No project field names what a
 * project builds yet, so every project reads as "the project"; a field such as a
 * website kind only has to be added here.
 */
export function projectNoun(_project?: { kind?: string } | null): string {
  return 'the project';
}
