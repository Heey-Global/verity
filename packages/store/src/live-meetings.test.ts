import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, truncateAll, type TestDb } from './testing.js';
import { sql } from 'kysely';
import type { LiveMeetingSyncRecord } from './live-meetings.js';

let ctx: TestDb;
const meeting: LiveMeetingSyncRecord = {
  id: 'meeting-1',
  sessionId: 'session-1',
  engine: 'fluid-nemotron',
  startedAt: 100,
  endedAt: null,
  state: 'active',
  transcript: 'First words',
  captureStatus: 'listening',
  ownerTokenHash: 'owner-hash',
  revision: 1,
};

beforeAll(async () => {
  ctx = await createTestDb();
});
afterAll(async () => {
  await ctx.close();
});
beforeEach(async () => {
  await truncateAll(ctx.db);
  await ctx.store.createSession({ sessionId: 'session-1', worktree: '/one', model: 'm' });
  await ctx.store.createSession({ sessionId: 'session-2', worktree: '/two', model: 'm' });
});

describe('live meeting sync', () => {
  it.skipIf(!process.env.VERITY_TEST_SHARED_POSTGRES_URL)(
    'does not advance the cursor past an uncommitted earlier update',
    async () => {
      await ctx.store.liveMeetings.putMeeting(meeting);
      const first = await ctx.store.liveMeetings.changes('session-1', 0);
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let locked!: () => void;
      const lockAcquired = new Promise<void>((resolve) => {
        locked = resolve;
      });
      const older = ctx.db.transaction().execute(async (trx) => {
        const clock = await trx
          .updateTable('live_meeting_sync_clock')
          .set({ sequence: sql`sequence + 1` })
          .where('id', '=', true)
          .returning('sequence')
          .executeTakeFirstOrThrow();
        await trx
          .updateTable('live_meetings')
          .set({
            transcript: 'Committed later',
            revision: 2,
            updated_seq: Number(clock.sequence),
          })
          .where('id', '=', meeting.id)
          .execute();
        locked();
        await held;
      });
      await lockAcquired;
      const newer = ctx.store.liveMeetings.putNote('session-1', {
        id: 'note-concurrent',
        meetingId: meeting.id,
        atSeconds: 3,
        text: 'Committed after',
        revision: 1,
      });
      try {
        await new Promise((resolve) => setTimeout(resolve, 50));
        const interim = await ctx.store.liveMeetings.changes('session-1', first.cursor);
        expect(interim.cursor).toBe(first.cursor);
        expect(interim.meetings).toEqual([]);
        expect(interim.notes).toEqual([]);
      } finally {
        release();
      }
      await older;
      await newer;
      const final = await ctx.store.liveMeetings.changes('session-1', first.cursor);
      expect(final.meetings).toEqual([expect.objectContaining({ transcript: 'Committed later' })]);
      expect(final.notes).toEqual([expect.objectContaining({ id: 'note-concurrent' })]);
    },
  );
  it('keeps transcript updates monotonic and scoped to the owning session', async () => {
    expect(await ctx.store.liveMeetings.putMeeting(meeting)).toBe(true);
    const first = await ctx.store.liveMeetings.changes('session-1', 0);
    expect(first.meetings).toEqual([
      expect.objectContaining({ transcript: 'First words', revision: 1 }),
    ]);
    expect(first.meetings[0]).not.toHaveProperty('ownerTokenHash');
    expect(await ctx.store.liveMeetings.putMeeting({ ...meeting, transcript: 'Stale' })).toBe(true);
    expect((await ctx.store.liveMeetings.changes('session-1', first.cursor)).meetings).toEqual([]);
    expect(
      await ctx.store.liveMeetings.putMeeting({
        ...meeting,
        revision: 2,
        transcript: 'More words',
      }),
    ).toBe(true);
    expect(
      (await ctx.store.liveMeetings.changes('session-1', first.cursor)).meetings[0]?.transcript,
    ).toBe('More words');
    expect(
      await ctx.store.liveMeetings.putMeeting({ ...meeting, sessionId: 'session-2', revision: 3 }),
    ).toBe(false);
    expect(
      await ctx.store.liveMeetings.putMeeting({
        ...meeting,
        ownerTokenHash: 'imposter',
        revision: 3,
      }),
    ).toBe(false);
    expect((await ctx.store.liveMeetings.changes('session-2', 0)).meetings).toEqual([]);
  });

  it('delivers a remote control command only to its recorder and confirms completion', async () => {
    await ctx.store.liveMeetings.putMeeting(meeting);
    expect(
      await ctx.store.liveMeetings.requestCommand('session-1', meeting.id, 'command-1', 'pause'),
    ).toBe('accepted');
    expect(
      await ctx.store.liveMeetings.requestCommand('session-1', meeting.id, 'command-2', 'pause'),
    ).toBe('pending');
    expect(await ctx.store.liveMeetings.ownerCommands('session-1', meeting.id, 'wrong')).toBeNull();
    expect(
      (
        await ctx.store.liveMeetings.ownerCommands('session-1', meeting.id, meeting.ownerTokenHash)
      )?.[0]?.action,
    ).toBe('pause');
    expect(
      await ctx.store.liveMeetings.acknowledgeCommand(
        'session-1',
        meeting.id,
        'command-1',
        'wrong',
        'completed',
        null,
      ),
    ).toBe(false);
    expect(
      await ctx.store.liveMeetings.acknowledgeCommand(
        'session-1',
        meeting.id,
        'command-1',
        meeting.ownerTokenHash,
        'completed',
        null,
      ),
    ).toBe(true);
    expect((await ctx.store.liveMeetings.commands('session-1', meeting.id))?.[0]?.state).toBe(
      'completed',
    );
    expect(
      await ctx.store.liveMeetings.requestCommand('session-1', meeting.id, 'command-2', 'stop'),
    ).toBe('accepted');
    await ctx.store.liveMeetings.putMeeting({
      ...meeting,
      revision: 2,
      state: 'ended',
      endedAt: 200,
    });
    expect((await ctx.store.liveMeetings.commands('session-1', meeting.id))?.[0]?.state).toBe(
      'completed',
    );
  });

  it('lets stop supersede a pending pause command', async () => {
    await ctx.store.liveMeetings.putMeeting(meeting);
    expect(
      await ctx.store.liveMeetings.requestCommand('session-1', meeting.id, 'pause-1', 'pause'),
    ).toBe('accepted');
    expect(
      await ctx.store.liveMeetings.requestCommand('session-1', meeting.id, 'stop-1', 'stop'),
    ).toBe('accepted');
    const commands = await ctx.store.liveMeetings.commands('session-1', meeting.id);
    expect(commands?.map(({ id, state }) => [id, state])).toEqual([
      ['stop-1', 'pending'],
      ['pause-1', 'failed'],
    ]);
  });

  it('keeps a command pending when a stale terminal revision is rejected', async () => {
    await ctx.store.liveMeetings.putMeeting(meeting);
    await ctx.store.liveMeetings.putMeeting({ ...meeting, revision: 3, transcript: 'Current' });
    expect(
      await ctx.store.liveMeetings.requestCommand('session-1', meeting.id, 'stop-stale', 'stop'),
    ).toBe('accepted');
    await ctx.store.liveMeetings.putMeeting({
      ...meeting,
      revision: 2,
      state: 'interrupted',
      endedAt: 200,
    });
    expect((await ctx.store.liveMeetings.commands('session-1', meeting.id))?.[0]?.state).toBe(
      'pending',
    );
    expect((await ctx.store.liveMeetings.changes('session-1', 0)).meetings[0]?.state).toBe(
      'active',
    );
  });

  it.skipIf(!process.env.VERITY_TEST_SHARED_POSTGRES_URL)(
    'does not insert a command after a concurrent finalization',
    async () => {
      await ctx.store.liveMeetings.putMeeting(meeting);
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let locked!: () => void;
      const lockAcquired = new Promise<void>((resolve) => {
        locked = resolve;
      });
      const ending = ctx.db.transaction().execute(async (trx) => {
        await trx
          .updateTable('live_meeting_sync_clock')
          .set({ sequence: sql`sequence + 1` })
          .where('id', '=', true)
          .execute();
        await trx
          .updateTable('live_meetings')
          .set({ state: 'ended' })
          .where('id', '=', meeting.id)
          .execute();
        locked();
        await held;
      });
      await lockAcquired;
      const command = ctx.store.liveMeetings.requestCommand(
        'session-1',
        meeting.id,
        'late-stop',
        'stop',
      );
      try {
        await new Promise((resolve) => setTimeout(resolve, 50));
      } finally {
        release();
      }
      await ending;
      expect(await command).toBe('missing');
      expect(await ctx.store.liveMeetings.commands('session-1', meeting.id)).toEqual([]);
    },
  );

  it('syncs notes once the meeting exists and rejects cross-session note IDs', async () => {
    expect(
      await ctx.store.liveMeetings.putNote('session-1', {
        id: 'note-1',
        meetingId: meeting.id,
        atSeconds: 1,
        text: 'Note',
        revision: 1,
      }),
    ).toBe(false);
    await ctx.store.liveMeetings.putMeeting(meeting);
    const note = { id: 'note-1', meetingId: meeting.id, atSeconds: 1, text: 'Note', revision: 1 };
    expect(await ctx.store.liveMeetings.putNote('session-1', note)).toBe(true);
    const first = await ctx.store.liveMeetings.changes('session-1', 0);
    expect(first.notes).toEqual([note]);
    expect(await ctx.store.liveMeetings.putNote('session-1', { ...note, text: 'Old' })).toBe(true);
    expect((await ctx.store.liveMeetings.changes('session-1', first.cursor)).notes).toEqual([]);
    expect(await ctx.store.liveMeetings.putNote('session-2', { ...note, revision: 2 })).toBe(false);
  });
});

it('retracts corrected question evidence without removing claims or another session’s insights', async () => {
  await ctx.store.liveMeetings.putMeeting({
    ...meeting,
    transcript: 'What is the price? A factual claim.',
  });
  for (const id of ['question-price', 'claim-price'])
    await ctx.store.liveMeetings.addInsight('session-1', {
      id,
      meetingId: meeting.id,
      kind: 'research',
      summary: 'Check the price',
      evidenceA: 'What is the price?',
      evidenceB: null,
      sourcePath: null,
      createdAt: 1,
    });
  await ctx.store.liveMeetings.putMeeting({
    ...meeting,
    revision: 2,
    transcript: 'The price is settled. A factual claim.',
  });
  await ctx.store.liveMeetings.reconcileQuestions('session-2', meeting.id, 2);
  expect(await ctx.store.liveMeetings.insights('session-1', meeting.id)).toHaveLength(2);
  await ctx.store.liveMeetings.reconcileQuestions('session-1', meeting.id, 1);
  expect(await ctx.store.liveMeetings.insights('session-1', meeting.id)).toHaveLength(2);
  await ctx.store.liveMeetings.reconcileQuestions('session-1', meeting.id, 2);
  expect(await ctx.store.liveMeetings.insights('session-1', meeting.id)).toEqual([
    expect.objectContaining({ id: 'claim-price' }),
  ]);
});
