import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventStore } from '@verity/store';
import { Conductor, type Backend, type RunTurnOptions } from '@verity/session';
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

  it('keeps a mark only for an unchanged image', () => {
    const round = nextMockupRound(
      {
        state: 'pending',
        revision: 3,
        screens: [
          { ...screen('Home', 'a'), verdict: 'approved' },
          { ...screen('Spec', 'b'), verdict: 'discarded' },
          { ...screen('Viewer', 'c'), verdict: 'approved' },
          { ...screen('Help', 'd'), verdict: 'discarded' },
        ],
      },
      [screen('Home', 'a'), screen('Spec', 'b2'), screen('Viewer', 'c2'), screen('Help', 'd')],
    );
    expect(round.revision).toBe(4);
    expect(round.state).toBe('pending');
    // A revised image is a new screen to look at, even where the old one was
    // approved; a discarded image presented again unchanged must not read as new.
    expect(round.screens.map((s) => [s.name, s.verdict])).toEqual([
      ['Home', 'approved'],
      ['Spec', 'open'],
      ['Viewer', 'open'],
      ['Help', 'discarded'],
    ]);
  });

  it('keeps the review open even when every screen is unchanged and approved', () => {
    // Approval marks never end the review; only the user in the chat does.
    const round = nextMockupRound(
      { state: 'pending', revision: 1, screens: [{ ...screen('Home', 'a'), verdict: 'approved' }] },
      [screen('Home', 'a')],
    );
    expect(round.state).toBe('pending');
  });
});

let ctx: TestDb;
let store: EventStore;
let worktree: string;
let app: FastifyInstance;
let mockups: SessionMockupActions;

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
  mockups = createSessionMockups({ eventStore: store });
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
const queuedTurns = () => ctx.db.selectFrom('queued_turns').selectAll().execute();

describe('presenting mockups', () => {
  it('rejects a presentation overtaken by a planning restart', async () => {
    const put = store.putAttachment.bind(store);
    vi.spyOn(store, 'putAttachment').mockImplementationOnce(async (...args) => {
      await store.startSessionPlanning('s1');
      return put(...args);
    });
    await expect(present()).rejects.toThrow(/planning changed/);
    expect((await store.getSession('s1'))?.mockupReview).toBeUndefined();
  });

  it('snapshots each image so the round survives a rewritten file', async () => {
    const round = await present();
    expect(round).toMatchObject({ state: 'pending', revision: 1 });
    writeFileSync(join(worktree, 'home.png'), png(10, 10));
    const stored = await store.getAttachment(round.screens[0]!.attachment);
    expect(stored?.mediaType).toBe('image/png');
    expect(mockupImage(stored!.bytes)).toMatchObject({ width: 393, height: 852 });
    expect((await store.getSession('s1'))?.mockupReview).toEqual(round);
  });

  it('replaces the round under review with a revision', async () => {
    await present();
    writeFileSync(join(worktree, 'spec.png'), png(393, 852, 2));
    const next = await mockups.present('s1', { screens: [{ name: 'Spec', path: 'spec.png' }] });
    // A screen left out of the revision is gone from the review, not kept beside it.
    expect(next.revision).toBe(2);
    expect(next.screens.map((screen) => screen.name)).toEqual(['Spec']);
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
  it('only marks screens, even when every screen is approved', async () => {
    await present();
    for (const screen of ['Home', 'Spec']) {
      const response = await post({ action: 'mark', revision: 1, screen, verdict: 'approved' });
      expect(response.statusCode).toBe(200);
      expect(response.json().mockupReview.state).toBe('pending');
    }
    // The user starts the build in the chat; a mark that queued a turn would
    // start it behind their back.
    expect(await queuedTurns()).toEqual([]);
    expect((await store.getSession('s1'))?.mockupReview?.state).toBe('pending');
  });

  it('discards a screen and takes the mark back', async () => {
    await present();
    const discarded = await post({
      action: 'mark',
      revision: 1,
      screen: 'Spec',
      verdict: 'discarded',
    });
    expect(discarded.json().mockupReview.screens[1]).toMatchObject({ verdict: 'discarded' });
    await post({ action: 'mark', revision: 1, screen: 'Spec', verdict: 'approved' });
    await post({ action: 'mark', revision: 1, screen: 'Spec', verdict: 'open' });
    expect((await store.getSession('s1'))?.mockupReview?.screens[1]?.verdict).toBe('open');
  });

  it('keeps every mark when devices decide at once', async () => {
    const names = Array.from({ length: 8 }, (_, index) => `Screen ${String(index)}`);
    for (const index of names.keys())
      writeFileSync(join(worktree, `${String(index)}.png`), png(10, 10, index));
    await mockups.present('s1', {
      screens: names.map((name, index) => ({ name, path: `${String(index)}.png` })),
    });
    await Promise.all(
      names.map((screen, index) =>
        post({
          action: 'mark',
          revision: 1,
          screen,
          verdict: index % 2 === 0 ? 'approved' : 'discarded',
        }),
      ),
    );
    // pglite serializes transactions on its single connection, so the row lock
    // itself is only exercised when the suite runs against a shared PostgreSQL.
    expect((await store.getSession('s1'))?.mockupReview?.screens.map((s) => s.verdict)).toEqual(
      names.map((_, index) => (index % 2 === 0 ? 'approved' : 'discarded')),
    );
  });

  it.each([
    [{ action: 'mark', revision: 0, screen: 'Home', verdict: 'approved' }, 409, 'stale'],
    [{ action: 'mark', revision: 1, screen: 'Nope', verdict: 'approved' }, 409, 'unknownScreen'],
    // Earlier app versions send comments and a send action; neither may touch the round.
    [
      { action: 'mark', revision: 1, screen: 'Home', verdict: 'comment', comment: 'Bigger' },
      400,
      'invalid',
    ],
    [{ action: 'send', revision: 1 }, 400, 'invalid'],
    // Legacy approvals authorize implementation; never accept them as mere marks.
    [{ action: 'decide', revision: 1, screen: 'Home', verdict: 'approved' }, 400, 'invalid'],
  ])('refuses %j', async (payload, status, code) => {
    const round = await present();
    const response = await post(payload);
    expect(response.statusCode).toBe(status);
    expect(response.json().code).toBe(code);
    expect((await store.getSession('s1'))?.mockupReview).toEqual(round);
    expect(await queuedTurns()).toEqual([]);
  });

  it('refuses marks once the review has ended', async () => {
    await present();
    expect((await mockups.complete('s1')).ok).toBe(true);
    const response = await post({ action: 'mark', revision: 1, screen: 'Home', verdict: 'open' });
    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe('notPending');
  });

  it('revokes the previous review when planning restarts', async () => {
    await present();
    expect(await store.startSessionPlanning('s1')).toBe(true);
    const response = await post({
      action: 'mark',
      revision: 1,
      screen: 'Home',
      verdict: 'approved',
    });
    expect(response.statusCode).toBe(409);
    expect((await store.getSession('s1'))?.mockupReview).toBeUndefined();
  });

  it('answers 404 for an unknown session', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/sessions/missing/mockups',
      payload: { action: 'mark', revision: 1, screen: 'Home', verdict: 'approved' },
    });
    expect(response.statusCode).toBe(404);
  });
});

describe('completing the review', () => {
  it('ends the review with its marks and starts no work itself', async () => {
    await present();
    await mockups.decide('s1', 1, 'Spec', { verdict: 'discarded' });
    const result = await mockups.complete('s1');
    expect(result).toMatchObject({ ok: true, review: { state: 'approved' } });
    const review = (await store.getSession('s1'))?.mockupReview;
    expect(review?.state).toBe('approved');
    expect(review?.screens.map((screen) => screen.verdict)).toEqual(['open', 'discarded']);
    expect(await queuedTurns()).toEqual([]);
  });

  it('answers that nothing is waiting without a review', async () => {
    expect(await mockups.complete('s1')).toEqual({ ok: false, code: 'notPending' });
    await present();
    await mockups.complete('s1');
    expect(await mockups.complete('s1')).toEqual({ ok: false, code: 'notPending' });
  });

  it('reopens a review an earlier version left revising for marks and completion', async () => {
    await present();
    await ctx.db.updateTable('sessions').set({ mockup_review: 'revising' }).execute();
    expect((await store.getSession('s1'))?.mockupReview?.state).toBe('pending');
    expect((await mockups.decide('s1', 1, 'Home', { verdict: 'approved' })).ok).toBe(true);
    expect((await mockups.complete('s1')).ok).toBe(true);
  });
});

describe('mockup review through the real conductor', () => {
  const conductors: Conductor[] = [];
  afterEach(async () => {
    for (const conductor of conductors.splice(0)) {
      await vi.waitFor(() => expect(conductor.isBusy('s1')).toBe(false));
      await conductor.drainOnShutdown();
    }
  });

  function liveConductor() {
    const runs: RunTurnOptions[] = [];
    const backend: Backend = {
      run: async (opts) => {
        runs.push(opts);
        await opts.store.appendEvent(opts.storeSessionId ?? 's1', {
          t: 'result',
          usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
          stopReason: 'end_turn',
        });
        return { sessionId: 's1', exitCode: 0, stderr: '', aborted: false };
      },
    };
    const conductor = new Conductor({ store, backend, worktreeExists: async () => true });
    conductors.push(conductor);
    return { runs, conductor };
  }

  it('hands the current marks to the agent with the user message', async () => {
    const { runs, conductor } = liveConductor();
    await present();
    await mockups.decide('s1', 1, 'Home', { verdict: 'approved' });
    await mockups.decide('s1', 1, 'Spec', { verdict: 'discarded' });
    // Marks alone start nothing; the next turn is the user's chat message.
    expect(runs).toHaveLength(0);
    await conductor.dispatchTurn('s1', 'Spec bitte mit größerem Titel.');
    await vi.waitFor(() => expect(runs).toHaveLength(1));
    expect(runs[0]?.appendSystemPrompt).toContain('- Home: approved');
    expect(runs[0]?.appendSystemPrompt).toContain('- Spec: discarded');

    await mockups.complete('s1');
    await vi.waitFor(() => expect(conductor.isBusy('s1')).toBe(false));
    await conductor.dispatchTurn('s1', 'Weiter.');
    await vi.waitFor(() => expect(runs).toHaveLength(2));
    // An ended review must not keep telling the agent to wait.
    expect(runs[1]?.appendSystemPrompt ?? '').not.toContain('## Mockup review');
  });
});
