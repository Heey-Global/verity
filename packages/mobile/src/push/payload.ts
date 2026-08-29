import { z } from 'zod';

/** The `kind` values the server stamps on a push `data` payload. `permission`
 * carries a `toolUseId` and drives the actionable allow/deny category; `question`
 * drives the AGENT_QUESTION text-reply, fired when a turn ends on a prose question
 * (server Block 0); `completed`/`crashed` are informational SESSION_STATUS taps.
 * Mirrors `packages/server/src/push-fire-points.ts`. */
export const PUSH_KINDS = [
  'permission',
  'question',
  'completed',
  'crashed',
  'pull_request_ready',
] as const;
export type PushKind = (typeof PUSH_KINDS)[number];

/** The `data` object the server puts on every push (never agent text — the
 * app resolves the human-readable content locally). `toolUseId` is present only
 * for `permission`, where it is the path param the permission-resolve endpoint
 * matches on. Parsed defensively: a malformed payload yields `null` rather than
 * routing a reply to the wrong session. */
export const pushPayloadSchema = z
  .object({
    sessionId: z.string().min(1),
    kind: z.enum(PUSH_KINDS),
    toolUseId: z.string().min(1).optional(),
    pullRequestNumber: z.number().int().positive().optional(),
    deviceId: z.string().min(1).optional(),
  })
  .superRefine((payload, context) => {
    if (payload.kind === 'permission' && typeof payload.toolUseId !== 'string') {
      context.addIssue({
        code: 'custom',
        message: 'a permission push payload must carry a toolUseId',
      });
    }
    if (
      payload.kind === 'pull_request_ready' &&
      (typeof payload.pullRequestNumber !== 'number' || typeof payload.deviceId !== 'string')
    ) {
      context.addIssue({
        code: 'custom',
        message: 'a pull-request-ready payload must carry a pullRequestNumber and deviceId',
      });
    }
  });

export type PushPayload = z.infer<typeof pushPayloadSchema>;

/**
 * The one push that belongs to no session: the Server announcing a release
 * (`SERVER_UPDATE_PUSH_CATEGORY`, sent by `server-update-notifier.ts`).
 *
 * Deliberately not a member of {@link PUSH_KINDS}. Every kind in that list is
 * session-scoped, and {@link pushPayloadSchema} requires a `sessionId` precisely so
 * that a reply can never be routed to the wrong session — relaxing that to admit a
 * payload which has no session would weaken the guard for all of them. This is a
 * separate, deliberately tiny recognizer instead: it authorizes nothing and decides
 * only which screen a tap opens.
 */
export const SERVER_UPDATE_PUSH_KIND = 'server-update';

export const serverUpdatePushSchema = z.object({
  kind: z.literal(SERVER_UPDATE_PUSH_KIND),
  version: z.string().min(1).optional(),
  /** Stamped on every push by `PushSender.send` — the pairing that received it. */
  deviceId: z.string().min(1).optional(),
});

export type ServerUpdatePush = z.infer<typeof serverUpdatePushSchema>;

/**
 * Parse the Server's update announcement, or `null` for anything else.
 *
 * Returns the payload rather than a boolean so the caller can check `deviceId`
 * against the pairing it is currently talking to: after re-pairing to another
 * Verity server, a notification still sitting in the tray belongs to the old one,
 * and following it would open settings showing an unrelated deployment's update.
 */
export function parseServerUpdatePush(data: unknown): ServerUpdatePush | null {
  const result = serverUpdatePushSchema.safeParse(data);
  return result.success ? result.data : null;
}

/** Validate a raw push `data` object. Returns `null` (never throws) when the
 * payload is missing/malformed so the caller can drop it silently. */
export function parsePushPayload(data: unknown): PushPayload | null {
  const result = pushPayloadSchema.safeParse(data);
  return result.success ? result.data : null;
}
