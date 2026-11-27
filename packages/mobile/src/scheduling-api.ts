import { z } from 'zod';

export const schedulingRequestViewSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  /** The project the request was prepared in; older servers omit it. */
  projectId: z.string().nullable().optional(),
  state: z.enum(['draft', 'provisioning', 'open', 'booked', 'expired', 'revoked', 'failed']),
  title: z.string(),
  durationMinutes: z.number(),
  addGoogleMeet: z.boolean(),
  timeZone: z.string(),
  guest: z.object({ email: z.string(), name: z.string().nullable() }),
  colleagues: z.array(z.object({ email: z.string(), name: z.string().optional() })),
  closesAt: z.string(),
  windows: z.array(z.object({ start: z.string(), end: z.string(), state: z.string() })),
  emailSentAt: z.string().nullable(),
  booked: z.object({ start: z.string(), end: z.string() }).nullable(),
  failure: z.string().nullable(),
  pendingCleanups: z.number(),
  link: z.string().nullable(),
  createdAt: z.string(),
});
export const schedulingRequestsSchema = z.object({
  requests: z.array(schedulingRequestViewSchema),
});
/** A scheduling request as the app shows it: its state, windows and the guest's link. */
export type SchedulingRequestView = z.infer<typeof schedulingRequestViewSchema>;
