import { z } from 'zod';
import { agentEventSchema } from './events.js';

export const HISTORY_MAX_BYTES = 256 * 1024;
export const HISTORY_MAX_EVENTS = 150;
export const boundedHistoryPageSchema = z.object({
  contract: z.literal('bounded-history-v1'),
  kind: z.literal('page'),
  events: z
    .array(
      z.object({
        seq: z.number().int().positive(),
        ts: z.number().int().nonnegative().optional(),
        event: agentEventSchema,
      }),
    )
    .max(HISTORY_MAX_EVENTS),
  snapshotSeq: z.number().int().nonnegative(),
  beforeSeq: z.number().int().positive().nullable(),
  hasMore: z.boolean(),
});
export type BoundedHistoryPage = z.infer<typeof boundedHistoryPageSchema>;
export const boundedHistoryResultSchema = z.discriminatedUnion('kind', [
  boundedHistoryPageSchema,
  z.object({
    contract: z.literal('bounded-history-v1'),
    kind: z.literal('oversized-event'),
    seq: z.number().int().positive(),
    requiredBytes: z.number().int().positive(),
    maxBytes: z.literal(HISTORY_MAX_BYTES),
    snapshotSeq: z.number().int().nonnegative(),
  }),
]);
export type BoundedHistoryResult = z.infer<typeof boundedHistoryResultSchema>;
