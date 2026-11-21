import { z } from 'zod';

import type { TransportRequestInit } from './api.js';

// A coding project's QA role (docs/ci-supervision.md): its state, its issues and
// the user's answers when QA stops. `VerityClient` carries these calls as
// `projectQA` (docs/adr/0029-module-boundaries-and-file-size.md).

export const qaModeSchema = z.enum(['off', 'monitor', 'automatic', 'paused']);
/** `automatic` is "repair within mandate". */
export type QAMode = z.infer<typeof qaModeSchema>;
export const qaIssueReasonSchema = z.enum([
  'rounds-exhausted',
  'beyond-mandate',
  'emergency-brake',
]);
export type QAIssueReason = z.infer<typeof qaIssueReasonSchema>;
export type QAIssueDecision = 'another_round' | 'take_over' | 'defer';

/** What a project's QA row shows; carried on the project record. */
export const projectQASummarySchema = z.object({
  mode: qaModeSchema,
  health: z.string(),
  checkedAt: z.string().nullable(),
  open: z.number().int().nonnegative(),
  repairing: z.number().int().nonnegative(),
  needsYou: z.number().int().nonnegative(),
  failingPullRequests: z.number().int().nonnegative(),
  failingWorkflows: z.number().int().nonnegative(),
  stopped: z
    .array(
      z.object({
        id: z.string(),
        key: z.string(),
        reason: qaIssueReasonSchema.nullable(),
        detail: z.string().nullable(),
        updatedAt: z.string(),
      }),
    )
    .default([]),
});
export type ProjectQASummary = z.infer<typeof projectQASummarySchema>;

export const qaIssueSchema = z.object({
  id: z.string(),
  key: z.string(),
  state: z.enum(['open', 'needs_you', 'deferred', 'taken_over', 'resolved']),
  reason: qaIssueReasonSchema.nullable(),
  detail: z.string().nullable(),
  revision: z.string().nullable(),
  failing: z.string().nullable(),
  incidents: z.number(),
  roundsUsed: z.number(),
  roundsAllowed: z.number(),
  repairing: z.boolean(),
  sessionId: z.string().nullable(),
  sessionName: z.string().nullable(),
  originSessionId: z.string().nullable(),
  detectedAt: z.string(),
  updatedAt: z.string(),
});
export type QAIssue = z.infer<typeof qaIssueSchema>;

export const projectQAStateSchema = z.object({
  enabled: z.boolean(),
  coding: z.boolean(),
  mode: qaModeSchema.nullable(),
  sessionId: z.string().nullable(),
  brakeAt: z.string().nullable(),
  checkedAt: z.string().nullable(),
  sources: z.object({
    pullRequests: z.object({ readable: z.boolean(), failing: z.number() }),
    ci: z.object({ readable: z.boolean(), failing: z.number() }),
  }),
  issues: z.array(qaIssueSchema),
  repairSessions: z.array(z.object({ session_id: z.string(), issue_id: z.string().nullable() })),
});
export type ProjectQAState = z.infer<typeof projectQAStateSchema>;

export const qaSettingsSchema = z.object({
  enabled: z.boolean(),
  health: z.string(),
  brakeAt: z.string().nullable().optional(),
});
export type QASettings = z.infer<typeof qaSettingsSchema>;

type Request = (path: string, init: TransportRequestInit) => Promise<Response>;
const json = (body: unknown): TransportRequestInit => ({
  method: 'PUT',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});
const project = (id: string) => `/projects/${encodeURIComponent(id)}`;

/** The QA calls, bound to the client's `request`. */
export function projectQAClient(request: Request) {
  return {
    state: async (projectId: string): Promise<ProjectQAState> => {
      const res = await request(`${project(projectId)}/qa`, { method: 'GET' });
      return projectQAStateSchema.parse(await res.json());
    },
    /** The user's answer to an issue where QA stopped. */
    decide: async (
      projectId: string,
      issueId: string,
      decision: QAIssueDecision,
    ): Promise<ProjectQAState> => {
      const res = await request(
        `${project(projectId)}/qa/issues/${encodeURIComponent(issueId)}/decision`,
        { ...json({ decision }), method: 'POST' },
      );
      return z.object({ state: projectQAStateSchema }).parse(await res.json()).state;
    },
    /** Switches this project's QA off or changes its mode (project management). */
    setMode: async (projectId: string, mode: QAMode): Promise<void> => {
      await request(`${project(projectId)}/repairs`, json({ mode }));
    },
    /** The system switch; reads when `enabled` is omitted. Administrators only. */
    settings: async (enabled?: boolean): Promise<QASettings> => {
      const res = await request(
        '/settings/qa',
        enabled === undefined ? { method: 'GET' } : json({ enabled }),
      );
      return qaSettingsSchema.parse(await res.json());
    },
    releaseBrake: async (): Promise<void> => {
      await request('/settings/qa/brake/release', { method: 'POST' });
    },
  };
}
