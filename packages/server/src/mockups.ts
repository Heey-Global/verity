// Design module: the agent presents rendered mockups and the user marks each screen
// as approved or discarded, then discusses them in the chat. Marks only record the
// user's opinion and never start a turn: the user tells the agent in the chat to
// implement, and the agent ends the review before it goes on. Images are copied
// into the attachment store when presented, so a round in the chat keeps showing
// what was reviewed after the files change.
import type { EventStore, MockupScreenRecord, MockupVerdict, SessionMockups } from '@verity/store';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { readWorktreeFile } from './worktree-file.js';

const MAX_MOCKUP_SCREENS = 12;
const MAX_MOCKUP_BYTES = 15 * 1024 * 1024;

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
    return validMockupSize({
      mediaType: 'image/png',
      width: bytes.readUInt32BE(16),
      height: bytes.readUInt32BE(20),
    });
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 <= bytes.length && bytes[offset] === 0xff) {
      const marker = bytes[offset + 1]!;
      const length = bytes.readUInt16BE(offset + 2);
      // SOF0–SOF15 carry the frame size; C4 (DHT), C8 (JPG) and CC (DAC) do not.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)
        return validMockupSize({
          mediaType: 'image/jpeg',
          height: bytes.readUInt16BE(offset + 5),
          width: bytes.readUInt16BE(offset + 7),
        });
      if (length < 2) break;
      offset += 2 + length;
    }
  }
  throw new Error('a mockup must be a PNG or JPEG image');
}
function validMockupSize(image: Pick<MockupScreenRecord, 'mediaType' | 'width' | 'height'>) {
  if (image.width <= 0 || image.height <= 0) throw new Error('mockup dimensions must be positive');
  return image;
}
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** The next round: new images open for review, except a screen that is unchanged
 *  from the round before, which keeps its mark. A discarded screen presented
 *  unchanged therefore stays discarded and never turns into an approval. */
export function nextMockupRound(
  current: SessionMockups,
  screens: readonly Omit<MockupScreenRecord, 'verdict'>[],
): SessionMockups {
  const next = screens.map((screen): MockupScreenRecord => {
    const before = current.screens.find((old) => old.name === screen.name);
    const kept = before !== undefined && before.attachment === screen.attachment;
    return { ...screen, verdict: kept ? before.verdict : 'open' };
  });
  return { state: 'pending', revision: current.revision + 1, screens: next };
}

export type MockupDecision = { verdict: MockupVerdict };

export type MockupActionResult =
  | { ok: true; review: SessionMockups }
  | { ok: false; code: 'notFound' | 'stale' | 'notPending' | 'unknownScreen' };

export interface MockupDeps {
  eventStore: Pick<EventStore, 'getSession' | 'updateSessionMockups' | 'putAttachment'>;
}

export function createSessionMockups(deps: MockupDeps) {
  const store = deps.eventStore;

  return {
    /** Snapshot the images and open a new round. Answers the stored round. */
    async present(sessionId: string, request: PresentMockupsRequest): Promise<SessionMockups> {
      const session = await store.getSession(sessionId);
      if (!session) throw new Error('session not found');
      const screens: Omit<MockupScreenRecord, 'verdict'>[] = [];
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
      const stored = await store.updateSessionMockups(
        sessionId,
        (current) => nextMockupRound(current, screens),
        session.planningRevision,
      );
      if (!stored) throw new Error('session missing or planning changed while preparing mockups');
      return stored;
    },

    /** Record one screen's mark. A mark never starts work, not even the last approval. */
    async decide(
      sessionId: string,
      revision: number,
      name: string,
      decision: MockupDecision,
    ): Promise<MockupActionResult> {
      let failure: MockupActionResult | undefined;
      const stored = await store.updateSessionMockups(sessionId, (current) => {
        if (current.revision !== revision) failure = { ok: false, code: 'stale' };
        else if (current.state !== 'pending') failure = { ok: false, code: 'notPending' };
        else if (!current.screens.some((screen) => screen.name === name))
          failure = { ok: false, code: 'unknownScreen' };
        if (failure) return undefined;
        return {
          ...current,
          screens: current.screens.map((screen) =>
            screen.name === name ? { ...screen, verdict: decision.verdict } : screen,
          ),
        };
      });
      if (!stored) return failure ?? { ok: false, code: 'notFound' };
      return { ok: true, review: stored };
    },

    /** End the review the user closed in the chat; its marks stay as they were. */
    async complete(sessionId: string): Promise<MockupActionResult> {
      let failure: MockupActionResult | undefined;
      const stored = await store.updateSessionMockups(sessionId, (current) => {
        if (current.state !== 'pending' && current.state !== 'revising') {
          failure = { ok: false, code: 'notPending' };
          return undefined;
        }
        return { ...current, state: 'approved' };
      });
      if (!stored) return failure ?? { ok: false, code: 'notFound' };
      return { ok: true, review: stored };
    },
  };
}

export type SessionMockupActions = ReturnType<typeof createSessionMockups>;

const sessionParams = z.object({ id: z.string().min(1) });
const decideBody = z
  .object({
    action: z.literal('mark'),
    revision: z.number().int().nonnegative(),
    screen: z.string().min(1).max(80),
    verdict: z.enum(['approved', 'discarded', 'open']),
  })
  .strict();

const ERRORS: Record<Exclude<MockupActionResult, { ok: true }>['code'], [number, string]> = {
  notFound: [404, 'session not found'],
  stale: [409, 'The mockups were updated. Please review the current ones.'],
  notPending: [409, 'These mockups are not waiting for review.'],
  unknownScreen: [409, 'This screen is not part of the current mockups.'],
};

/** `POST /sessions/:id/mockups` — the reviewer marks one screen. Comments and
 *  sending them belonged to earlier versions; the chat carries them now. */
export function registerMockupRoutes(
  app: FastifyInstance,
  deps: { mockups: SessionMockupActions },
): void {
  app.post('/sessions/:id/mockups', async (request, reply) => {
    const { id } = sessionParams.parse(request.params);
    const body = decideBody.safeParse(request.body);
    if (!body.success) {
      reply.code(400);
      return { error: 'Mark the screen as approved, discarded or open.', code: 'invalid' };
    }
    const result = await deps.mockups.decide(id, body.data.revision, body.data.screen, {
      verdict: body.data.verdict,
    });
    if (!result.ok) {
      const [status, error] = ERRORS[result.code];
      reply.code(status);
      return { error, code: result.code };
    }
    return { mockupReview: result.review };
  });
}
