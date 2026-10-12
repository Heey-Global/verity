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

// Keep the support export boundary metadata-only even when the server changes.
export const recordingCoreRecordSchema = (() => {
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
    stage: z.enum([
      'send',
      'callback',
      'emitted_message',
      'parser',
      'accepted',
      'ws_error',
      'close',
    ]),
    outcome: z.enum(['observed', 'accepted', 'error']),
    direction: z.enum(['in', 'out']),
    type: z.enum([
      'stream.open',
      'stream.data',
      'stream.end',
      'stream.reset',
      'attached',
      'unknown',
    ]),
    encodedBytes: count,
    decodedBytes: count,
    stream: hash.optional(),
    seq: count.optional(),
    errorCode: errorCode.optional(),
  });
  // Object schemas deliberately project fixed fields. Never copy a logger envelope,
  // arbitrary error text, or newly added payload fields into a support export.
  const coreRecordingSummary = z.object({
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

  return coreRecordingSummary;
})();

export const recordingUplinkRecordSchema = (() => {
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

  return uplinkRecordingEvent;
})();
