import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/** Base64 length of the largest legal attachment payload a turn may carry:
 *  `MAX_TURN_ATTACHMENT_BYTES` in `server.ts` (50 MB, enforced across the whole
 *  attachment array by `turnBody`'s refine, via
 *  `isAttachmentBase64TotalSizeAllowed`) expanded by base64's 4/3. The two are
 *  kept in step by a test that asks the predicate for its own boundary rather
 *  than restating the constant. */
const MAX_TURN_ATTACHMENT_BASE64_LEN = 66_666_668;

/**
 * What this route, and only this route, may buffer.
 *
 * It has to stay ABOVE the cap `turnBody` enforces. A limit at or below it
 * rejects a legal turn while Fastify is still reading the socket, so the client
 * sees a bare 413 instead of the field error the schema would have produced —
 * and it has already uploaded the attachments by then.
 *
 * It is declared here rather than raised globally in `buildServer` because a
 * body this size is the exception: two routes need it, and every other route in
 * the server takes metadata-shaped JSON that fits in the modest default
 * `buildServer` now passes to Fastify. A global allowance would let any route at
 * all be made to buffer 67 MB, which costs roughly three times that in peak
 * memory once the body, the base64 string JSON parses out of it, and the
 * decoded Buffer exist at the same time.
 */
export const TURN_BODY_LIMIT_BYTES = MAX_TURN_ATTACHMENT_BASE64_LEN + 1_000_000;

export interface SessionTurnRouteDeps {
  dispatch: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
}

/** Registers submission of a new or steering turn to an existing session. */
export function registerSessionTurnRoute(app: FastifyInstance, deps: SessionTurnRouteDeps): void {
  app.post('/sessions/:id/turns', { bodyLimit: TURN_BODY_LIMIT_BYTES }, (request, reply) =>
    deps.dispatch(request, reply),
  );
}
