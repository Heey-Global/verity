// Design module: the agent presents rendered mockups and the user approves or
// comments on each screen before the rest of an accepted plan is built. The agent
// stops after presenting (its prompt says so); the server owns what happens next:
// approving every screen starts the continuation turn, sending comments starts a
// revision turn. Images are copied into the attachment store when presented, so a
// round in the chat keeps showing what was reviewed after the files change.
import {
  MOCKUPS_APPROVED_DISPLAY,
  MOCKUPS_APPROVED_PROMPT,
  mockupFeedbackDisplay,
  mockupFeedbackPrompt,
} from '@verity/events';
import type { EventStore, MockupScreenRecord, SessionMockups } from '@verity/store';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PlanningDeps } from './planning.js';
import { readWorktreeFile } from './worktree-file.js';

export const MAX_MOCKUP_SCREENS = 12;
const MAX_MOCKUP_BYTES = 15 * 1024 * 1024;
export const MAX_MOCKUP_COMMENT = 4_000;

export const presentMockupsRequestSchema = z
  .object({
    screens: z
      .array(
        z
          .object({
            name: z.string().trim().min(1).max(80),
            path: z.string().trim().min(1).max(1_000),
          })
          .strict(),
      )
      .min(1)
      .max(MAX_MOCKUP_SCREENS)
      .refine(
        (screens) => new Set(screens.map((screen) => screen.name)).size === screens.length,
        'screen names must be unique',
      ),
  })
  .strict();

export type PresentMockupsRequest = z.infer<typeof presentMockupsRequestSchema>;

/** Pixel size from the image header: PNG's IHDR, or the first JPEG frame header. */
export function mockupImage(
  bytes: Buffer,
): Pick<MockupScreenRecord, 'mediaType' | 'width' | 'height'> {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return {
      mediaType: 'image/png',
      width: bytes.readUInt32BE(16),
      height: bytes.readUInt32BE(20),
    };
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 <= bytes.length && bytes[offset] === 0xff) {
      const marker = bytes[offset + 1]!;
      const length = bytes.readUInt16BE(offset + 2);
      // SOF0–SOF15 carry the frame size; C4 (DHT), C8 (JPG) and CC (DAC) do not.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)
        return {
          mediaType: 'image/jpeg',
          height: bytes.readUInt16BE(offset + 5),
          width: bytes.readUInt16BE(offset + 7),
        };
      if (length < 2) break;
      offset += 2 + length;
    }
  }
  throw new Error('a mockup must be a PNG or JPEG image');
}
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** The next round: new images open for review, except a screen that is unchanged
 *  from an approved one, which keeps its approval. */
export function nextMockupRound(
  current: SessionMockups,
  screens: readonly Omit<MockupScreenRecord, 'verdict' | 'comment'>[],
): SessionMockups {
  const next = screens.map((screen): MockupScreenRecord => {
    const before = current.screens.find((old) => old.name === screen.name);
    const kept = before?.verdict === 'approved' && before.attachment === screen.attachment;
    return { ...screen, verdict: kept ? 'approved' : 'open' };
  });
  return {
    state: next.every((screen) => screen.verdict === 'approved') ? 'approved' : 'pending',
    revision: current.revision + 1,
    screens: next,
  };
}

export type MockupDecision =
  { verdict: 'approved' | 'open' } | { verdict: 'comment'; comment: string };

export type MockupActionResult =
  | { ok: true; review: SessionMockups }
  | { ok: false; code: 'notFound' | 'stale' | 'notPending' | 'noComments' | 'unknownScreen' };

export interface MockupDeps {
  eventStore: Pick<EventStore, 'getSession' | 'updateSessionMockups' | 'putAttachment'>;
  dispatchTurn: PlanningDeps['dispatchTurn'];
}

export function createSessionMockups(deps: MockupDeps) {
  const store = deps.eventStore;

  /** Run a server turn after a decision was stored; if the turn is refused, put the
   *  round back so the reviewer can try again instead of waiting on nothing. */
  async function dispatchAfter(
    sessionId: string,
    before: SessionMockups,
    after: SessionMockups,
    prompt: string,
    displayPrompt: string,
    initiatedBy: { userId: string } | undefined,
  ): Promise<boolean> {
    let accepted = false;
    try {
      const result = await deps.dispatchTurn(
        sessionId,
        prompt,
        {},
        {
          displayPrompt,
          queueBehindActiveTurn: true,
          ...(initiatedBy !== undefined ? { initiatedBy } : {}),
        },
      );
      accepted = result.accepted !== false;
    } finally {
      if (!accepted)
        await store.updateSessionMockups(sessionId, (current) =>
          current.revision === after.revision && current.state === after.state ? before : undefined,
        );
    }
    return accepted;
  }

  return {
    /** Snapshot the images and open a new round. Answers the stored round. */
    async present(sessionId: string, request: PresentMockupsRequest): Promise<SessionMockups> {
      const session = await store.getSession(sessionId);
      if (!session) throw new Error('session not found');
      const screens: Omit<MockupScreenRecord, 'verdict' | 'comment'>[] = [];
      for (const screen of request.screens) {
        const bytes = await readWorktreeFile(session.worktree, screen.path, {
          label: `mockup "${screen.name}" path`,
          maxBytes: MAX_MOCKUP_BYTES,
          tooLarge: `mockup "${screen.name}" exceeds 15 MB`,
        });
        const image = mockupImage(bytes);
        const attachment = await store.putAttachment(image.mediaType, bytes.toString('base64'));
        screens.push({ name: screen.name, attachment, ...image });
      }
      const stored = await store.updateSessionMockups(sessionId, (current) =>
        nextMockupRound(current, screens),
      );
      if (!stored) throw new Error('session not found');
      return stored;
    },

    /** Record one screen's verdict. Approving the last open screen ends the review
     *  and starts the continuation turn. */
    async decide(
      sessionId: string,
      revision: number,
      name: string,
      decision: MockupDecision,
      initiatedBy?: { userId: string },
    ): Promise<MockupActionResult> {
      let failure: MockupActionResult | undefined;
      let before: SessionMockups | undefined;
      const stored = await store.updateSessionMockups(sessionId, (current) => {
        before = current;
        if (current.revision !== revision) failure = { ok: false, code: 'stale' };
        else if (current.state !== 'pending') failure = { ok: false, code: 'notPending' };
        else if (!current.screens.some((screen) => screen.name === name))
          failure = { ok: false, code: 'unknownScreen' };
        if (failure) return undefined;
        const screens = current.screens.map((screen): MockupScreenRecord => {
          if (screen.name !== name) return screen;
          const rest = { ...screen };
          delete rest.comment;
          return decision.verdict === 'comment'
            ? { ...rest, verdict: 'comment', comment: decision.comment }
            : { ...rest, verdict: decision.verdict };
        });
        return {
          ...current,
          state: screens.every((screen) => screen.verdict === 'approved') ? 'approved' : 'pending',
          screens,
        };
      });
      if (!stored) return failure ?? { ok: false, code: 'notFound' };
      if (stored.state === 'approved') {
        const started = await dispatchAfter(
          sessionId,
          before!,
          stored,
          MOCKUPS_APPROVED_PROMPT,
          MOCKUPS_APPROVED_DISPLAY,
          initiatedBy,
        );
        if (!started) return { ok: true, review: before! };
      }
      return { ok: true, review: stored };
    },

    /** Hand the round's comments to the agent, which revises and presents again. */
    async sendComments(
      sessionId: string,
      revision: number,
      initiatedBy?: { userId: string },
    ): Promise<MockupActionResult> {
      let failure: MockupActionResult | undefined;
      let before: SessionMockups | undefined;
      const stored = await store.updateSessionMockups(sessionId, (current) => {
        before = current;
        if (current.revision !== revision) failure = { ok: false, code: 'stale' };
        else if (current.state !== 'pending') failure = { ok: false, code: 'notPending' };
        else if (!current.screens.some((screen) => screen.verdict === 'comment'))
          failure = { ok: false, code: 'noComments' };
        return failure ? undefined : { ...current, state: 'revising' };
      });
      if (!stored) return failure ?? { ok: false, code: 'notFound' };
      const comments = stored.screens.filter((screen) => screen.verdict === 'comment').length;
      const started = await dispatchAfter(
        sessionId,
        before!,
        stored,
        mockupFeedbackPrompt(stored.screens),
        mockupFeedbackDisplay(comments),
        initiatedBy,
      );
      return { ok: true, review: started ? stored : before! };
    },
  };
}

export type SessionMockupActions = ReturnType<typeof createSessionMockups>;

const sessionParams = z.object({ id: z.string().min(1) });
const decideBody = z
  .object({
    action: z.literal('decide'),
    revision: z.number().int().nonnegative(),
    screen: z.string().min(1).max(80),
    verdict: z.enum(['approved', 'open']),
  })
  .strict();
const commentBody = z
  .object({
    action: z.literal('decide'),
    revision: z.number().int().nonnegative(),
    screen: z.string().min(1).max(80),
    verdict: z.literal('comment'),
    comment: z.string().trim().min(1).max(MAX_MOCKUP_COMMENT),
  })
  .strict();
const sendBody = z
  .object({ action: z.literal('send'), revision: z.number().int().nonnegative() })
  .strict();

const ERRORS: Record<Exclude<MockupActionResult, { ok: true }>['code'], [number, string]> = {
  notFound: [404, 'session not found'],
  stale: [409, 'The mockups were updated. Please review the current ones.'],
  notPending: [409, 'These mockups are not waiting for review.'],
  noComments: [409, 'Comment on at least one screen before sending.'],
  unknownScreen: [409, 'This screen is not part of the current mockups.'],
};

/** `POST /sessions/:id/mockups` — the reviewer decides a screen or sends comments. */
export function registerMockupRoutes(
  app: FastifyInstance,
  deps: { mockups: SessionMockupActions },
): void {
  app.post('/sessions/:id/mockups', async (request, reply) => {
    const { id } = sessionParams.parse(request.params);
    const body = parseMockupBody(request.body);
    const initiatedBy = request.localUserId ? { userId: request.localUserId } : undefined;
    const result =
      body.action === 'send'
        ? await deps.mockups.sendComments(id, body.revision, initiatedBy)
        : await deps.mockups.decide(
            id,
            body.revision,
            body.screen,
            body.verdict === 'comment'
              ? { verdict: 'comment', comment: body.comment }
              : { verdict: body.verdict },
            initiatedBy,
          );
    if (!result.ok) {
      const [status, error] = ERRORS[result.code];
      reply.code(status);
      return { error, code: result.code };
    }
    return { mockupReview: result.review };
  });
}

type MockupBody =
  z.infer<typeof decideBody> | z.infer<typeof commentBody> | z.infer<typeof sendBody>;

/** Both decide shapes share their `action`, so the verdict picks the schema. */
function parseMockupBody(body: unknown): MockupBody {
  const fields = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  if (fields.action === 'send') return sendBody.parse(body);
  return (fields.verdict === 'comment' ? commentBody : decideBody).parse(body);
}
