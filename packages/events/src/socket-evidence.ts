import { z } from 'zod';

const transportCount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable();
// An absent object is an older producer; null fields are unavailable observations.
const transport = z.strictObject({
  schemaVersion: z.literal(1),
  wsState: z.number().int().min(0).max(3).nullable(),
  bufferedBytes: transportCount,
  socketEncrypted: z.boolean().nullable(),
  socketBytesRead: transportCount,
  socketBytesWritten: transportCount,
  socketReadableLength: transportCount,
  socketWritableLength: transportCount,
  socketPaused: z.boolean().nullable(),
  socketNeedDrain: z.boolean().nullable(),
  socketDestroyed: z.boolean().nullable(),
  receiverState: z.number().int().min(0).max(6).nullable(),
  receiverBufferedBytes: transportCount,
  receiverPayloadLength: transportCount,
  receiverTotalPayloadLength: transportCount,
  receiverMessageLength: transportCount,
  receiverFragmented: z.number().int().min(0).max(2).nullable(),
  receiverFin: z.boolean().nullable(),
  receiverNeedDrain: z.boolean().nullable(),
  closeFrameSent: z.boolean().nullable(),
  closeFrameReceived: z.boolean().nullable(),
});

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const elapsed = z.number().finite().nonnegative();
const hash = z.string().regex(/^[a-f0-9]{16}$/u);
const totals = z.strictObject({
  acceptedFrames: count,
  acceptedBytes: count,
  sendFrames: count,
  sendBytes: count,
  completedFrames: count,
  completedBytes: count,
  errors: count,
});
const snapshot = z.strictObject({
  transport,
  counters: z.strictObject({
    emittedMessages: count,
    emittedBytes: count,
    parserErrors: count,
    trackerErrors: count,
    wsErrors: count,
  }),
  dataTotals: totals,
  streams: z.array(totals.extend({ stream: hash })).max(64),
  streamHashCollisions: count,
  droppedStreams: count,
  loggerErrors: count,
  lastCloseCode: z.number().int().min(1000).max(4999).nullable(),
  truncatedStreams: count,
});
export const socketEvidenceRecordSchema = z.strictObject({
  schemaVersion: z.literal(2),
  event: z.literal('remote.socket_evidence'),
  kind: z.enum(['binding', 'sample', 'final']),
  runId: z.string().uuid(),
  processBootId: z.string().uuid(),
  socketLifetimeId: z.string().uuid(),
  session: hash,
  generation: hash,
  party: z.enum(['app', 'installation']),
  baseline: z.enum(['post_auth', 'late']),
  sequence: count.min(1).max(2000),
  utc: z.string().datetime(),
  monotonicMs: elapsed,
  targetIntervalMs: z.literal(100),
  actualIntervalMs: elapsed,
  lagMs: elapsed,
  snapshot: snapshot.nullable(),
});
export const socketEvidenceMetadataSchema = z.strictObject({
  version: z.literal(2),
  runId: z.string().uuid(),
  state: z.enum(['recording', 'stopped', 'expired']),
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime().nullable(),
  expiresAt: z.string().datetime(),
  retainedUntil: z.string().datetime(),
  collectorReady: z.literal(true),
  recordCount: count.max(2000),
  droppedRecords: count,
  stopReason: z.enum(['requested', 'duration', 'capacity', 'collector_error']).nullable(),
  diagnosticErrors: count,
  omittedBindings: count,
});
export const socketEvidenceHashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
export const socketEvidenceExportSchema = socketEvidenceMetadataSchema
  .extend({
    exportHash: socketEvidenceHashSchema,
    records: z.array(socketEvidenceRecordSchema).max(2000),
  })
  .superRefine((value, context) => {
    if (value.state === 'recording' || value.endedAt === null || value.stopReason === null)
      context.addIssue({ code: 'custom', message: 'Evidence is not finalized' });
    if (
      value.records.length !== value.recordCount ||
      value.records.some(
        (record, index) => record.runId !== value.runId || record.sequence !== index + 1,
      )
    )
      context.addIssue({ code: 'custom', message: 'Incomplete or mismatched evidence' });
  });
export type SocketEvidenceExport = z.infer<typeof socketEvidenceExportSchema>;

/** Exact hash input: sorted object keys, unchanged array order, finite JSON primitives. */
export function canonicalEvidenceJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalEvidenceJson).join(',') + ']';
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const object = value as Record<string, unknown>;
    return (
      '{' +
      Object.keys(object)
        .sort()
        .map((key) => JSON.stringify(key) + ':' + canonicalEvidenceJson(object[key]))
        .join(',') +
      '}'
    );
  }
  throw new Error('Non-JSON evidence');
}
export function socketEvidenceHashInput(value: SocketEvidenceExport): string {
  const document: Partial<SocketEvidenceExport> = { ...value };
  delete document.exportHash;
  return canonicalEvidenceJson(document);
}
