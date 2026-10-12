import { Buffer } from 'node:buffer';
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';

const transportCount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable();
// An absent object is an older producer; null fields are unavailable observations.
const recordingTransportSchema = z.object({
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
const summary = z.object({
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
export const MAX_INPUT_BYTES = 16 * 1024 * 1024;

/** Project Core Pino JSONL or Docker json-file envelopes without copying raw logs. */
export function projectCoreRecording(input) {
  if (Buffer.byteLength(input) > MAX_INPUT_BYTES) throw new Error('input_too_large');
  const records = [];
  let invalidLines = 0;
  let rejectedRecords = 0;
  let ignoredLines = 0;
  for (const line of input.split('\n')) {
    if (!line.trim()) continue;
    let value;
    try {
      value = JSON.parse(line);
      if (typeof value?.log === 'string') value = JSON.parse(value.log);
    } catch {
      invalidLines++;
      continue;
    }
    if (value?.event !== 'remote.return_path') {
      ignoredLines++;
      continue;
    }
    const parsed = summary.safeParse(value);
    if (!parsed.success) {
      rejectedRecords++;
      continue;
    }
    records.push(parsed.data);
  }
  return {
    records,
    coverage: {
      source: 'core',
      records: records.length,
      invalidLines,
      rejectedRecords,
      ignoredLines,
      // Projection cannot establish collector pagination, rotation or clock bounds.
      complete: false,
      rotationKnown: false,
      clockOffsetKnown: false,
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [input, output, ...extra] = process.argv.slice(2);
    if (!input || !output || extra.length) throw new Error('usage');
    if (statSync(input).size > MAX_INPUT_BYTES) throw new Error('input_too_large');
    const result = projectCoreRecording(readFileSync(input, 'utf8'));
    writeFileSync(
      output,
      result.records.map((record) => JSON.stringify(record)).join('\n') + '\n',
      { mode: 0o600, flag: 'wx' },
    );
    console.log(JSON.stringify(result.coverage));
    if (!result.records.length || result.coverage.invalidLines || result.coverage.rejectedRecords)
      process.exitCode = 2;
  } catch {
    console.error(
      'Core projection failed. Usage: node project-core-recording.mjs INPUT_JSONL NEW_OUTPUT_JSONL',
    );
    process.exitCode = 1;
  }
}
