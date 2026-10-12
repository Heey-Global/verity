import { z } from 'zod';
import { recordingTransportSchema } from './recording-transport-schema.js';

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const elapsed = z.number().nonnegative().finite();
const hash = z.string().regex(/^[a-f0-9]{16}$/u);
const errorCode = z.enum([
  'unknown',
  'ECONNRESET',
  'EPIPE',
  'ETIMEDOUT',
  'WS_ERR_INVALID_UTF8',
  'WS_ERR_UNEXPECTED_RSV_1',
  'WS_ERR_UNEXPECTED_RSV_2_3',
  'WS_ERR_INVALID_OPCODE',
  'WS_ERR_INVALID_MASK',
  'WS_ERR_EXPECTED_MASK',
  'WS_ERR_UNEXPECTED_MASK',
  'WS_ERR_INVALID_CONTROL_PAYLOAD_LENGTH',
  'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH',
]);
const position = { eventOrder: count, elapsedMs: elapsed };
const first = z.object({
  ...position,
  encodedBytes: count,
  decodedBytes: count,
  seq: count.optional(),
  outcome: z.enum(['observed', 'accepted', 'error']).optional(),
});
const event = z.object({
  ...position,
  stage: z.enum(['send', 'callback', 'emitted_message', 'parser', 'accepted', 'ws_error', 'close']),
  outcome: z.enum(['observed', 'accepted', 'error']),
  direction: z.enum(['in', 'out']),
  type: z.enum(['stream.open', 'stream.data', 'stream.end', 'stream.reset', 'attached', 'unknown']),
  encodedBytes: count,
  decodedBytes: count,
  stream: hash.optional(),
  seq: count.optional(),
  errorCode: errorCode.optional(),
});
// Object schemas deliberately project fixed fields. Never copy a logger envelope,
// arbitrary error text, or newly added payload fields into a support export.
export const coreRecordingSummary = z.object({
  time: count.optional(),
  event: z.literal('remote.return_path'),
  schemaVersion: z.literal(1),
  transport: recordingTransportSchema.optional(),
  session: hash,
  generation: hash,
  party: z.literal('installation'),
  ...position,
  outcome: z.literal('observed'),
  stage: z.literal('summary'),
  summaryOrder: count,
  droppedEvents: count,
  emittedMessages: count,
  emittedBytes: count,
  lastError: z.object({ ...position, errorCode }).nullable(),
  lastCloseRequest: z.object(position).nullable().optional(),
  lastClose: z
    .object({ ...position, code: z.number().int().min(1000).max(1015).optional() })
    .nullable(),
  droppedStreamObservations: count,
  streams: z
    .array(
      z.object({
        stream: hash,
        enqueuedFrames: count,
        completedFrames: count,
        errorFrames: count,
        encodedBytes: count,
        decodedBytes: count,
        firstSend: first.optional(),
        firstCallback: first.optional(),
      }),
    )
    .max(64),
  events: z.array(event).max(128),
});
