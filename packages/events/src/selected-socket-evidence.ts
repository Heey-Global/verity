import { z } from 'zod';
import {
  socketEvidenceRecordSchema,
  socketEvidenceMetadataSchema,
  socketEvidenceHashSchema,
  canonicalEvidenceJson,
} from './socket-evidence.js';
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const elapsed = z.number().finite().nonnegative();
const hash = z.string().regex(/^[a-f0-9]{16}$/u);
const peer = z
  .strictObject({
    bound: z.boolean(),
    active: z.boolean(),
    socketLifetimeId: z.string().uuid().nullable(),
    generation: hash.nullable(),
  })
  .superRefine((value, ctx) => {
    if (
      (value.active && !value.bound) ||
      value.bound !== (value.socketLifetimeId !== null && value.generation !== null) ||
      (!value.bound && (value.socketLifetimeId !== null || value.generation !== null))
    )
      ctx.addIssue({ code: 'custom', message: 'Invalid peer binding' });
  });
export const selectedEvidenceMetadataSchema = socketEvidenceMetadataSchema
  .extend({
    version: z.literal(3),
    state: z.enum(['preparing', 'recording', 'stopped', 'expired']),
    targetSession: hash,
    captureDurationMs: count.min(1).max(30000),
    preparationExpiresAt: z.string().datetime(),
    captureStartedAt: z.string().datetime().nullable(),
    captureExpiresAt: z.string().datetime().nullable(),
    burstStartedAt: z.string().datetime().nullable(),
    samplingPolicy: z.strictObject({
      periodicIntervalMs: z.literal(1000),
      burstIntervalMs: z.literal(100),
      burstDurationMs: z.literal(1000),
      burstTrigger: z.literal('first_periodic_pressure'),
      finalStreamLimit: z.literal(8),
    }),
    readiness: z.strictObject({
      revision: count,
      checkedAt: z.string().datetime(),
      monotonicMs: elapsed,
      ready: z.boolean(),
      installation: peer,
      app: peer,
    }),
    stopReason: z
      .enum([
        'requested',
        'duration',
        'capacity',
        'collector_error',
        'preparation_timeout',
        'pair_changed',
      ])
      .nullable(),
  })
  .superRefine((value, ctx) => {
    const invalid = () => ctx.addIssue({ code: 'custom', message: 'Invalid selected readiness' });
    const live = value.state === 'preparing' || value.state === 'recording';
    if (live !== (value.endedAt === null) || live !== (value.stopReason === null)) invalid();
    if (
      value.readiness.installation.bound &&
      value.readiness.app.bound &&
      value.readiness.installation.socketLifetimeId === value.readiness.app.socketLifetimeId
    )
      invalid();
    if ((value.captureStartedAt === null) !== (value.captureExpiresAt === null)) invalid();
    if (value.state === 'preparing' && (value.captureStartedAt !== null || value.readiness.ready))
      invalid();
    if (value.state === 'recording' && value.captureStartedAt === null) invalid();
    if (
      value.readiness.ready &&
      (value.state !== 'recording' ||
        !value.readiness.installation.active ||
        !value.readiness.app.active ||
        value.omittedBindings !== 0)
    )
      invalid();
  });
export const selectedEvidenceRecordSchema = socketEvidenceRecordSchema
  .extend({
    schemaVersion: z.literal(3),
    targetIntervalMs: z.union([z.literal(100), z.literal(1000), z.null()]),
    samplingMode: z.enum(['baseline', 'periodic', 'burst', 'final']),
  })
  .superRefine((record, ctx) => {
    const invalid = () =>
      ctx.addIssue({ code: 'custom', message: 'Invalid selected sampling record' });
    const interval =
      record.samplingMode === 'periodic' ? 1000 : record.samplingMode === 'burst' ? 100 : null;
    if (record.targetIntervalMs !== interval) invalid();
    if ((record.kind === 'final') !== (record.samplingMode === 'final')) invalid();
    if (
      record.kind === 'binding' &&
      (record.snapshot !== null || record.samplingMode !== 'baseline')
    )
      invalid();
    if ((record.snapshot?.streams.length ?? 0) > (record.kind === 'final' ? 8 : 0)) invalid();
  });
export const selectedEvidenceExportSchema = selectedEvidenceMetadataSchema
  .safeExtend({
    exportHash: socketEvidenceHashSchema,
    records: z.array(selectedEvidenceRecordSchema).max(2000),
  })
  .superRefine((value, ctx) => {
    const invalid = (message: string) => ctx.addIssue({ code: 'custom', message });
    if (
      ['preparing', 'recording'].includes(value.state) ||
      value.endedAt === null ||
      value.stopReason === null ||
      value.readiness.ready
    )
      invalid('Evidence is not finalized');
    if (
      value.recordCount !== value.records.length ||
      value.records.some(
        (record, i) =>
          record.runId !== value.runId ||
          record.session !== value.targetSession ||
          record.sequence !== i + 1,
      )
    )
      invalid('Incomplete or mismatched evidence');
  });
export type SelectedEvidenceMetadata = z.infer<typeof selectedEvidenceMetadataSchema>;
export type SelectedEvidenceExport = z.infer<typeof selectedEvidenceExportSchema>;
export function selectedEvidenceHashInput(value: SelectedEvidenceExport): string {
  const document: Partial<SelectedEvidenceExport> = { ...value };
  delete document.exportHash;
  return canonicalEvidenceJson(document);
}
