import { z } from 'zod';

const transportCount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable();
// An absent object is an older producer; null fields are unavailable observations.
export const recordingTransportSchema = z.object({
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
