import { z } from 'zod';
import {
  socketEvidenceMetadataSchema,
  socketEvidenceHashSchema,
  socketEvidenceRecordSchema,
} from '@verity/events';

import { recordingTransportSchema } from './recording-transport-schema.js';

export const DIAGNOSTICS_CAPABILITY = 'remote-diagnostics-v1';
export const DIAGNOSTICS_V2_CAPABILITY = 'remote-diagnostics-v2';
export const DIAGNOSTICS_TIMEOUT_MS = 10_000;
const DIAGNOSTICS_FRAME_BYTES = 32_768;
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const hash = z.string().regex(/^[a-f0-9]{16}$/u);
const reason = z.enum([
  'binary',
  'message_limit',
  'inactive',
  'invalid_frame',
  'protocol_error',
  'body_limit',
  'concurrency_limit',
  'send_failed',
  'internal',
  'other',
]);
const wsCode = z.enum([
  'WS_ERR_INVALID_OPCODE',
  'WS_ERR_INVALID_UTF8',
  'WS_ERR_UNEXPECTED_RSV_1',
  'WS_ERR_UNEXPECTED_RSV_2_3',
  'WS_ERR_EXPECTED_MASK',
  'WS_ERR_UNEXPECTED_MASK',
  'WS_ERR_INVALID_CONTROL_PAYLOAD_LENGTH',
  'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH',
  'WS_ERR_UNSUPPORTED_DATA_PAYLOAD_LENGTH',
  'ECONNRESET',
  'EPIPE',
  'ETIMEDOUT',
  'other',
]);
const position = { eventOrder: count, elapsedMs: z.number().finite().nonnegative() };
const stage = z.enum([
  'emitted_message',
  'parser',
  'tracker',
  'accepted',
  'send',
  'callback',
  'ws_error',
  'summary',
  'close',
]);
// Project known metadata only. Free-form errors, payloads and future fields must
// never enter the downloadable recording through a control-channel response.
const uplinkRecordingEvent = z.object({
  at: z.string().datetime().optional(),
  event: z.literal('remote.return_path'),
  schemaVersion: z.literal(1),
  transport: recordingTransportSchema.optional(),
  session: hash,
  generation: hash,
  party: z.enum(['app', 'installation']),
  direction: z.enum(['in', 'out']),
  stage,
  outcome: z.enum(['observed', 'accepted', 'error']),
  ...position,
  type: z.enum(['stream.open', 'stream.data', 'stream.end', 'stream.reset']).optional(),
  reason: reason.optional(),
  wsCode: wsCode.optional(),
  stream: hash.optional(),
  seq: count.optional(),
  encodedBytes: count.optional(),
  decodedBytes: count.optional(),
  closeCode: z.number().int().min(1000).max(4999).optional(),
  droppedEvents: count.optional(),
  droppedStreams: count.optional(),
  loggerErrors: count.optional(),
  counters: z
    .object({
      emittedMessages: count,
      emittedBytes: count,
      parserErrors: count,
      trackerErrors: count,
      wsErrors: count,
    })
    .optional(),
  lastError: z
    .object({
      stage,
      ...position,
      reason: reason.optional(),
      wsCode: wsCode.optional(),
      stream: hash.optional(),
      seq: count.optional(),
    })
    .optional(),
  lastClose: z.object({ code: z.number().int().min(1000).max(4999), ...position }).optional(),
  totals: z
    .array(
      z.object({
        stream: hash,
        acceptedFrames: count,
        acceptedBytes: count,
        sendFrames: count,
        sendBytes: count,
        completedFrames: count,
        completedBytes: count,
        errors: count,
      }),
    )
    .max(64)
    .optional(),
});
const status = {
  requestId: z.string().uuid(),
  runId: z.string().uuid(),
  state: z.enum(['recording', 'stopped', 'expired']),
  expiresAt: z.string().datetime(),
  retainedUntil: z.string().datetime(),
  collectorReady: z.literal(true),
  recordCount: count.max(2048),
  droppedRecords: count,
};
const response = z.discriminatedUnion('type', [
  z.object({ type: z.literal('diagnostics.started'), ...status }),
  z.object({ type: z.literal('diagnostics.status'), ...status }),
  z.object({ type: z.literal('diagnostics.stopped'), ...status }),
  z.object({
    type: z.literal('diagnostics.exported'),
    ...status,
    cursor: count,
    nextCursor: count.nullable(),
    records: z.array(uplinkRecordingEvent).max(1024),
  }),
  z.object({
    type: z.literal('diagnostics.error'),
    requestId: z.string().uuid(),
    runId: z.string().uuid(),
    code: z.enum([
      'not_available',
      'not_entitled',
      'not_found',
      'conflict',
      'limit_reached',
      'invalid_cursor',
    ]),
  }),
]);
const v2Response = z.discriminatedUnion('type', [
  socketEvidenceMetadataSchema.extend({
    type: z.enum(['diagnostics.started', 'diagnostics.status', 'diagnostics.stopped']),
    requestId: z.string().uuid(),
    exportHash: socketEvidenceHashSchema.nullable(),
  }),
  socketEvidenceMetadataSchema.extend({
    type: z.literal('diagnostics.exported'),
    requestId: z.string().uuid(),
    exportHash: socketEvidenceHashSchema,
    cursor: count,
    nextCursor: count.nullable(),
    records: z.array(socketEvidenceRecordSchema).max(2000),
  }),
]);
type LegacyResponse = Exclude<z.infer<typeof response>, { type: 'diagnostics.error' }>;
export function parseRecordingResponse(value: unknown, runId: string, version?: 1): LegacyResponse;
export function parseRecordingResponse(
  value: unknown,
  runId: string,
  version: 2,
): z.infer<typeof v2Response>;
export function parseRecordingResponse(
  value: unknown,
  runId: string,
  version: 1 | 2,
): LegacyResponse | z.infer<typeof v2Response>;
export function parseRecordingResponse(value: unknown, runId: string, version: 1 | 2 = 1) {
  if (Buffer.byteLength(JSON.stringify(value)) > DIAGNOSTICS_FRAME_BYTES)
    throw new Error('invalid_diagnostics_response');
  if (version === 1 && typeof value === 'object' && value !== null && 'version' in value)
    throw new Error('invalid_diagnostics_response');
  const error = response.safeParse(value);
  if (error.success && error.data.type === 'diagnostics.error')
    throw new Error(`diagnostics_${error.data.code}`);
  const parsed = version === 2 ? v2Response.safeParse(value) : response.safeParse(value);
  if (!parsed.success || parsed.data.runId !== runId)
    throw new Error('invalid_diagnostics_response');
  if (parsed.data.type === 'diagnostics.error') throw new Error(`diagnostics_${parsed.data.code}`);
  if (version === 2 && 'exportHash' in parsed.data) {
    const recording = parsed.data.state === 'recording';
    if (
      recording !== (parsed.data.exportHash === null) ||
      recording !== (parsed.data.endedAt === null) ||
      recording !== (parsed.data.stopReason === null)
    )
      throw new Error('invalid_diagnostics_response');
  }
  return parsed.data;
}
