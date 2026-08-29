import { agentEventSchema, type AgentEvent } from '@verity/events';
import { z } from 'zod';

/**
 * The frames the Verity server pushes over `WS /sessions/:id/stream` (server
 * `server.ts`): a sequenced canonical `event`, a `caught_up` watermark once the
 * backlog is drained, or a terminal `error`. The mobile reducer consumes these
 * to rebuild a session's transcript; `seq` drives the reconnect cursor
 * (`?sinceSeq=N`) and dedup, exactly as the server emits it.
 */
export const streamFrameSchema = z.discriminatedUnion('k', [
  z.object({
    k: z.literal('event'),
    seq: z.number().int().nonnegative(),
    // The event's real persist time as epoch milliseconds (the store row's
    // `created_at`, #32) — the client's source for `createdAt` instead of the
    // `seq` proxy. OPTIONAL on the wire for back-compat during an asymmetric
    // rollout (an older server/client that doesn't carry `ts`): when absent the
    // reducer falls back to `seq`.
    ts: z.number().int().nonnegative().optional(),
    event: agentEventSchema,
  }),
  z.object({
    k: z.literal('caught_up'),
    seq: z.number().int().nonnegative(),
  }),
  z.object({
    k: z.literal('error'),
    message: z.string(),
  }),
]);

export type StreamFrame = z.infer<typeof streamFrameSchema>;

/** A sequenced canonical event frame — the live transcript payload. */
export type StreamEventFrame = Extract<StreamFrame, { k: 'event' }>;

/** Validate an already-parsed frame object against the contract. */
export function parseStreamFrame(input: unknown): z.ZodSafeParseResult<StreamFrame> {
  return streamFrameSchema.safeParse(input);
}

export type DecodeResult = { ok: true; frame: StreamFrame } | { ok: false; error: string };

/**
 * Decode a raw WS message string (the server sends `JSON.stringify(frame)`) into
 * a validated {@link StreamFrame}. Never throws — malformed JSON or a frame that
 * violates the contract returns `{ ok: false }` so a single bad message can't
 * tear down the socket reducer.
 */
export function decodeStreamMessage(raw: string): DecodeResult {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'invalid JSON' };
  }
  const parsed = streamFrameSchema.safeParse(json);
  if (!parsed.success) return { ok: false, error: parsed.error.message };
  return { ok: true, frame: parsed.data };
}

export type { AgentEvent };
