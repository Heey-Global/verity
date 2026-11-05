import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MOCKUPS_APPROVED_DISPLAY, MOCKUPS_APPROVED_PROMPT } from '@verity/events';
import { EventStore } from '@verity/store';
import { createTestDb, truncateAll, type TestDb } from '@verity/store/testing';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createSessionMockups,
  mockupImage,
  nextMockupRound,
  registerMockupRoutes,
  type SessionMockupActions,
} from './mockups.js';
import type { PlanningDeps } from './planning.js';

/** A minimal PNG header: signature, IHDR length and type, then width and height. */
function png(width: number, height: number, salt = 0): Buffer {
  const bytes = Buffer.alloc(33 + salt);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write('IHDR', 12, 'ascii');
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

/** SOI, an APP0 segment to skip, then a baseline frame header (SOF0). */
function jpeg(width: number, height: number): Buffer {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]);
  const sof = Buffer.alloc(11);
  sof.writeUInt16BE(0xffc0, 0);
  sof.writeUInt16BE(9, 2);
  sof[4] = 8;
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof]);
}

describe('mockupImage', () => {
  it('reads the size of PNG and JPEG images', () => {
    expect(mockupImage(png(786, 1704))).toEqual({
      mediaType: 'image/png',
      width: 786,
      height: 1704,
    });
    // The APP0 segment comes first: a reader that took the first segment as the
    // frame would report its bytes as the size and stretch the screen.
    expect(mockupImage(jpeg(1440, 900))).toEqual({
      mediaType: 'image/jpeg',
      width: 1440,
      height: 900,
    });
  });

  it.each([png(0, 100), png(100, 0), jpeg(0, 100), jpeg(100, 0)])(
    'rejects zero image dimensions',
    (bytes) => {
      expect(() => mockupImage(bytes)).toThrow(/positive/);
    },
  );

  it('refuses anything else', () => {
    expect(() => mockupImage(Buffer.from('<svg/>'))).toThrow(/PNG or JPEG/);
  });
});

describe('nextMockupRound', () => {
  const screen = (name: string, attachment: string) => ({
    name,
    attachment,
    mediaType: 'image/png' as const,
    width: 1,
    height: 1,
  });

  it('keeps an approval only for an unchanged image', () => {
    const round = nextMockupRound(
      {
        state: 'revising',
        revision: 3,
        screens: [
          { ...screen('Home', 'a'), verdict: 'approved' },
          { ...screen('Spec', 'b'), verdict: 'comment', comment: 'Move it up.' },
          { ...screen('Viewer', 'c'), verdict: 'approved' },
        ],
      },
      [screen('Home', 'a'), screen('Spec', 'b2'), screen('Viewer', 'c2')],
    );
    expect(round.revision).toBe(4);
    expect(round.state).toBe('pending');
    // A revised image is a new screen to look at, even where the old one was approved.
    expect(round.screens.map((s) => [s.name, s.verdict, s.comment])).toEqual([
      ['Home', 'approved', undefined],
      ['Spec', 'open', undefined],
      ['Viewer', 'open', undefined],
    ]);
  });
});

let ctx: TestDb;
let store: EventStore;
let worktree: string;
let app: FastifyInstance;
let mockups: SessionMockupActions;
let dispatchTurn: ReturnType<typeof vi.fn<PlanningDeps['dispatchTurn']>>;

beforeAll(async () => {
  ctx = await createTestDb();
});
afterAll(async () => {
  await ctx.close();
});
beforeEach(async () => {
  await truncateAll(ctx.db);
  store = new EventStore(ctx.db);
  worktree = mkdtempSync(join(tmpdir(), 'verity-mockups-'));
  writeFileSync(join(worktree, 'home.png'), png(393, 852));
  writeFileSync(join(worktree, 'spec.png'), png(393, 852, 1));
  await store.createSession({ sessionId: 's1', worktree, model: 'm' });
  dispatchTurn = vi.fn<PlanningDeps['dispatchTurn']>(
    async (sessionId, prompt, _opts, dispatchOpts) => ({
      queued: true,
      accepted: await store.enqueueMockupContinuation(
        {
          id: crypto.randomUUID(),
          sessionId,
          prompt,
          opts: {},
        },
        dispatchOpts.mockupContinuation!,
        dispatchOpts.mockupPreviousScreens,
      ),
    }),
  );
  mockups = createSessionMockups({ eventStore: store, dispatchTurn });
  app = Fastify();
  registerMockupRoutes(app, { mockups });
});
afterEach(async () => {
  await app.close();
  rmSync(worktree, { recursive: true, force: true });
});

const present = () =>
  mockups.present('s1', {
    screens: [
      { name: 'Home', path: 'home.png' },
      { name: 'Spec', path: 'spec.png' },
    ],
  });
const post = (payload: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: '/sessions/s1/mockups', payload });

describe('presenting mockups', () => {
  it('snapshots each image so the round survives a rewritten file', async () => {
    const round = await present();
    expect(round).toMatchObject({ state: 'pending', revision: 1 });
    writeFileSync(join(worktree, 'home.png'), png(10, 10));
    const stored = await store.getAttachment(round.screens[0]!.attachment);
    expect(stored?.mediaType).toBe('image/png');
    expect(mockupImage(stored!.bytes)).toMatchObject({ width: 393, height: 852 });
    expect((await store.getSession('s1'))?.mockupReview).toEqual(round);
  });

  it.each([
    ['an absolute path', '/etc/passwd', /must be relative/],
    ['a path out of the worktree', '../outside.png', /inside the session worktree/],
  ])('refuses %s', async (_label, path, error) => {
    await expect(mockups.present('s1', { screens: [{ name: 'Home', path }] })).rejects.toThrow(
      error,
    );
    expect((await store.getSession('s1'))?.mockupReview).toBeUndefined();
  });

  it('refuses a symlink that leaves the worktree', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'verity-mockups-outside-'));
    writeFileSync(join(outside, 'secret.png'), png(1, 1));
    symlinkSync(join(outside, 'secret.png'), join(worktree, 'link.png'));
    try {
      await expect(
        mockups.present('s1', { screens: [{ name: 'Home', path: 'link.png' }] }),
      ).rejects.toThrow();
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('POST /sessions/:id/mockups', () => {
  it('continues the build only once every screen is approved', async () => {
    await present();
    const first = await post({
      action: 'decide',
      revision: 1,
      screen: 'Home',
      verdict: 'approved',
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().mockupReview.state).toBe('pending');
    expect(dispatchTurn).not.toHaveBeenCalled();

    const last = await post({ action: 'decide', revision: 1, screen: 'Spec', verdict: 'approved' });
    expect(last.json().mockupReview.state).toBe('approved');
    expect(dispatchTurn).toHaveBeenCalledTimes(1);
    expect(dispatchTurn.mock.calls[0]![1]).toBe(MOCKUPS_APPROVED_PROMPT);
    expect(dispatchTurn.mock.calls[0]![3]).toMatchObject({
      displayPrompt: MOCKUPS_APPROVED_DISPLAY,
      queueBehindActiveTurn: true,
    });
  });

  it('keeps every verdict when devices decide at once', async () => {
    const names = Array.from({ length: 8 }, (_, index) => `Screen ${String(index)}`);
    for (const index of names.keys())
      writeFileSync(join(worktree, `${String(index)}.png`), png(10, 10, index));
    await mockups.present('s1', {
      screens: names.map((name, index) => ({ name, path: `${String(index)}.png` })),
    });
    await Promise.all(
      names.map((screen) => post({ action: 'decide', revision: 1, screen, verdict: 'approved' })),
    );
    // A lost verdict leaves the build waiting on a screen the user already
    // approved; a doubled one starts the build twice. pglite serializes
    // transactions on its single connection, so the row lock itself is only
    // exercised when the suite runs against a shared PostgreSQL.
    expect((await store.getSession('s1'))?.mockupReview?.state).toBe('approved');
    expect(dispatchTurn).toHaveBeenCalledTimes(1);
  });

  it('sends comments to the agent and waits for the next round', async () => {
    await present();
    await post({ action: 'decide', revision: 1, screen: 'Home', verdict: 'approved' });
    const comment = await post({
      action: 'decide',
      revision: 1,
      screen: 'Spec',
      verdict: 'comment',
      comment: 'Put the decision above the criteria.',
    });
    expect(comment.json().mockupReview.screens[1]).toMatchObject({
      verdict: 'comment',
      comment: 'Put the decision above the criteria.',
    });
    const sent = await post({ action: 'send', revision: 1 });
    expect(sent.json().mockupReview.state).toBe('revising');
    expect(dispatchTurn.mock.calls[0]![1]).toContain(
      '- Spec: Put the decision above the criteria.',
    );
    expect(dispatchTurn.mock.calls[0]![3]).toMatchObject({ displayPrompt: '1 mockup comment' });

    // The revised round keeps the unchanged, approved Home screen approved.
    writeFileSync(join(worktree, 'spec.png'), png(393, 852, 2));
    const next = await present();
    expect(next.screens.map((s) => s.verdict)).toEqual(['approved', 'open']);
  });

  it.each([
    [{ action: 'decide', revision: 0, screen: 'Home', verdict: 'approved' }, 'stale'],
    [{ action: 'decide', revision: 1, screen: 'Nope', verdict: 'approved' }, 'unknownScreen'],
    [{ action: 'send', revision: 1 }, 'noComments'],
  ])('refuses %j', async (payload, code) => {
    await present();
    const response = await post(payload);
    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe(code);
    expect(dispatchTurn).not.toHaveBeenCalled();
  });

  it('refuses a comment without text', async () => {
    await present();
    const response = await post({
      action: 'decide',
      revision: 1,
      screen: 'Home',
      verdict: 'comment',
      comment: '  ',
    });
    // The server's error handler answers the validation error with 400; the
    // point here is that a blank comment never reaches the round.
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect((await store.getSession('s1'))?.mockupReview?.screens[0]?.verdict).toBe('open');
  });

  it('keeps continuation work durable after recreating the store', async () => {
    await present();
    await post({ action: 'decide', revision: 1, screen: 'Home', verdict: 'approved' });
    await post({ action: 'decide', revision: 1, screen: 'Spec', verdict: 'approved' });
    const restarted = new EventStore(ctx.db);
    expect((await restarted.getSession('s1'))?.mockupReview?.state).toBe('approved');
    const queued = await ctx.db.selectFrom('queued_turns').selectAll().execute();
    expect(queued).toHaveLength(1);
    expect(queued[0]?.prompt).toBe(MOCKUPS_APPROVED_PROMPT);
  });

  it('revokes the previous review when planning restarts', async () => {
    await present();
    expect(await store.startSessionPlanning('s1')).toBe(true);
    const response = await post({
      action: 'decide',
      revision: 1,
      screen: 'Home',
      verdict: 'approved',
    });
    expect(response.statusCode).toBe(409);
    expect(dispatchTurn).not.toHaveBeenCalled();
    expect((await store.getSession('s1'))?.mockupReview).toBeUndefined();
  });

  it('puts the round back when the continuation turn is refused', async () => {
    dispatchTurn.mockResolvedValue({ queued: false, accepted: false });
    await present();
    await post({ action: 'decide', revision: 1, screen: 'Home', verdict: 'approved' });
    const last = await post({ action: 'decide', revision: 1, screen: 'Spec', verdict: 'approved' });
    // Otherwise the review reads as approved while no turn will ever continue it.
    expect(last.statusCode).toBe(409);
    expect(last.json().code).toBe('stale');
    expect((await store.getSession('s1'))?.mockupReview?.screens[1]?.verdict).toBe('open');
    expect((await store.getSession('s1'))?.mockupReview?.state).toBe('pending');
  });

  it('answers 404 for an unknown session', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/sessions/missing/mockups',
      payload: { action: 'send', revision: 1 },
    });
    expect(response.statusCode).toBe(404);
  });
});
