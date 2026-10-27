import { z } from 'zod';

/** Wire shapes of the administrator audit API (ADR 0028, `GET /audit/*`). */

const initiatorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user'), isRequester: z.boolean() }),
  z.object({ kind: z.literal('session'), sessionId: z.string(), name: z.string().nullable() }),
  z.object({ kind: z.literal('system'), trigger: z.string() }),
  z.object({ kind: z.literal('unknown') }),
]);
export type AuditInitiator = z.infer<typeof initiatorSchema>;

const operationSummarySchema = z.object({
  operationId: z.string(),
  kind: z.enum(['build', 'image_removed', 'project_deleted', 'write_gap']),
  status: z.enum(['succeeded', 'failed', 'running', 'unknown', 'recorded']),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  project: z.object({ id: z.string(), label: z.string().nullable() }).nullable(),
  initiator: initiatorSchema,
  imageId: z.string().nullable(),
  failedWrites: z.number().nullable(),
});
export type AuditOperationSummary = z.infer<typeof operationSummarySchema>;

const operationDetailSchema = operationSummarySchema.extend({
  server: z.object({ release: z.string(), generation: z.number().nullable() }),
  build: z
    .object({
      imageTag: z.string(),
      forceRebuild: z.boolean(),
      commit: z.string().nullable(),
      baseImageRef: z.string().nullable(),
      baseImageDigest: z.string().nullable(),
      features: z.array(z.string()),
      sizeBytes: z.number().nullable(),
      durationMs: z.number().nullable(),
    })
    .nullable(),
  imageRef: z.string().nullable(),
  gapWindow: z.object({ from: z.string(), to: z.string() }).nullable(),
  events: z.array(z.object({ kind: z.string(), recordedAt: z.string() })),
});
export type AuditOperationDetail = z.infer<typeof operationDetailSchema>;

/** A newer Server may add kinds, statuses or initiators this app does not know. Those
 *  entries are skipped instead of failing the whole page. */
const tolerantOperations = z.array(z.unknown()).transform((items) =>
  items.flatMap((item) => {
    const parsed = operationSummarySchema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  }),
);

export const auditOperationListSchema = z.object({
  operations: tolerantOperations,
  nextBefore: z.string().nullable(),
  oldestRecordedAt: z.string().nullable(),
});
export type AuditOperationList = z.infer<typeof auditOperationListSchema>;

export const auditOperationResponseSchema = z.object({ operation: operationDetailSchema });

export const auditHealthSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  pendingFailedWrites: z.number(),
});
export type AuditHealth = z.infer<typeof auditHealthSchema>;

export type AuditDomain = 'builds' | 'images' | 'resources' | 'integrity';

export interface AuditOperationQuery {
  domain?: AuditDomain;
  search?: string;
  before?: string;
  limit?: number;
}
