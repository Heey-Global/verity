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
      evidenceA: id === 'claim-price' ? 'A factual claim.' : 'What is the price?',
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

it('reconciles only classified question evidence and preserves accepted identities and older questions', async () => {
  const transcript =
    'What is the price? It costs ten euros. When is delivery? Why is the sky blue?';
  await ctx.store.liveMeetings.putMeeting({ ...meeting, transcript });
  for (const [id, evidenceA] of [
    ['question-price', 'What is the price?'],
    ['question-delivery', 'When is delivery?'],
    ['question-sky', 'Why is the sky blue?'],
    ['claim-price', 'It costs ten euros.'],
  ] as const)
    await ctx.store.liveMeetings.addInsight('session-1', {
      id,
      meetingId: meeting.id,
      kind: 'research',
      summary: evidenceA,
      evidenceA,
      evidenceB: null,
      sourcePath: null,
      createdAt: 1,
    });
  await ctx.store.liveMeetings.reconcileQuestions('session-1', meeting.id, 1, {
    text: 'What is the price? It costs ten euros. When is delivery?',
    acceptedIds: ['question-delivery'],
    resolvedIds: ['question-price'],
  });
  expect(
    (await ctx.store.liveMeetings.insights('session-1', meeting.id))?.map(({ id }) => id).sort(),
  ).toEqual(['claim-price', 'question-delivery', 'question-sky']);
});

it('removes a periodic question finding published before classification while preserving other claims and contradictions', async () => {
  const question = 'What does the plan cost.';
  const claim = 'Growth was forty percent last quarter.';
  await ctx.store.liveMeetings.putMeeting({ ...meeting, transcript: `${question} ${claim}` });
  for (const [id, kind, evidenceA] of [
    ['batch-question', 'research', question],
    ['question-plan', 'research', question],
    ['growth', 'research', claim],
    ['conflict', 'contradiction', question],
  ] as const) {
    await ctx.store.liveMeetings.addInsight('session-1', {
      id,
      meetingId: meeting.id,
      kind,
      summary: evidenceA,
      evidenceA,
      evidenceB: null,
      sourcePath: null,
      createdAt: 1,
    });
  }
  await ctx.store.liveMeetings.reconcileQuestions('session-1', meeting.id, 1, {
    text: question,
    acceptedIds: ['question-plan'],
    resolvedIds: [],
  });
  expect(
    (await ctx.store.liveMeetings.insights('session-1', meeting.id))?.map(({ id }) => id).sort(),
  ).toEqual(['conflict', 'growth', 'question-plan']);
});

it('rejects stale question publication without replacing valid evidence', async () => {
  await ctx.store.liveMeetings.putMeeting({
    ...meeting,
    revision: 2,
    transcript: 'What is the price? What is the corrected price?',
  });
  const insight = {
    id: 'question-price',
    meetingId: meeting.id,
    kind: 'research' as const,
    summary: 'Corrected price',
    evidenceA: 'What is the corrected price?',
    evidenceB: null,
    sourcePath: null,
    createdAt: 1,
  };
  await ctx.store.liveMeetings.addInsight('session-1', insight);
  expect(
    await ctx.store.liveMeetings.reconcileQuestions('session-1', meeting.id, 1, {
      text: 'What is the price?',
      acceptedIds: [insight.id],
      resolvedIds: [],
      insights: [{ ...insight, evidenceA: 'What is the price?' }],
    }),
  ).toBe(false);
  expect(await ctx.store.liveMeetings.insights('session-1', meeting.id)).toEqual([insight]);
});

it('preserves questions omitted by the output limit and retracts only explicit resolutions', async () => {
  const questions = Array.from({ length: 5 }, (_, index) => ({
    id: `question-${index}`,
    meetingId: meeting.id,
    kind: 'research' as const,
    summary: `What is item ${index}?`,
    evidenceA: `What is item ${index}?`,
    evidenceB: null,
    sourcePath: null,
    createdAt: index,
  }));
  const text = questions.map(({ evidenceA }) => evidenceA).join(' ');
  await ctx.store.liveMeetings.putMeeting({ ...meeting, transcript: text });
  for (const question of questions) await ctx.store.liveMeetings.addInsight('session-1', question);
  const classified = {
    text,
    acceptedIds: questions.slice(0, 4).map(({ id }) => id),
    resolvedIds: [] as string[],
    insights: questions.slice(0, 4),
  };
  await ctx.store.liveMeetings.reconcileQuestions('session-1', meeting.id, 1, classified);
  expect(await ctx.store.liveMeetings.insights('session-1', meeting.id)).toHaveLength(5);
  await ctx.store.liveMeetings.reconcileQuestions('session-1', meeting.id, 1, {
    ...classified,
    resolvedIds: [questions[4]!.id],
  });
  expect(
    (await ctx.store.liveMeetings.insights('session-1', meeting.id))?.map(({ id }) => id).sort(),
  ).toEqual(classified.acceptedIds);
});

it('resolves a known question and its batch duplicate beyond the current answer excerpt', async () => {
  const question = {
    id: 'question-price',
    meetingId: meeting.id,
    kind: 'research' as const,
    summary: 'What is the price?',
    evidenceA: 'What is the price?',
    evidenceB: null,
    sourcePath: null,
    createdAt: 1,
  };
  const text = 'The price is ten euros.';
  await ctx.store.liveMeetings.putMeeting({
    ...meeting,
    transcript: question.evidenceA + ' ' + 'Other discussion. '.repeat(200) + text,
  });
  await ctx.store.liveMeetings.addInsight('session-1', question);
  await ctx.store.liveMeetings.addInsight('session-1', { ...question, id: 'batch-price' });
  await ctx.store.liveMeetings.reconcileQuestions('session-1', meeting.id, 1, {
    text,
    acceptedIds: [],
    resolvedIds: [question.id],
    insights: [],
  });
  expect(await ctx.store.liveMeetings.insights('session-1', meeting.id)).toEqual([]);
});

it('loads question identities independently of newer claims and enforces session ownership', async () => {
  await ctx.store.liveMeetings.putMeeting(meeting);
  const question = {
    id: 'question-price',
    meetingId: meeting.id,
    kind: 'research' as const,
    summary: 'What is the price?',
    evidenceA: 'What is the price?',
    evidenceB: null,
    sourcePath: null,
    createdAt: 1,
  };
  await ctx.store.liveMeetings.addInsight('session-1', question);
  for (let index = 0; index < 31; index++)
    await ctx.store.liveMeetings.addInsight('session-1', {
      ...question,
      id: `claim-${index}`,
      evidenceA: `Claim number ${index}.`,
      summary: 'A claim',
      createdAt: index + 2,
    });
  expect(
    (await ctx.store.liveMeetings.insights('session-1', meeting.id))?.some(
      ({ id }) => id === question.id,
    ),
  ).toBe(false);
  expect(await ctx.store.liveMeetings.questions('session-1', meeting.id)).toEqual([question]);
  expect(await ctx.store.liveMeetings.questions('session-2', meeting.id)).toBeNull();
});

it('keeps older unresolved identities eligible beyond forty open questions', async () => {
  const questions = Array.from({ length: 42 }, (_, index) => ({
    id: `question-${index}`,
    meetingId: meeting.id,
    kind: 'research' as const,
    summary: `What is item ${index}?`,
    evidenceA: `What is item ${index}?`,
    evidenceB: null,
    sourcePath: null,
    createdAt: index,
  }));
  const transcript = questions.map(({ evidenceA }) => evidenceA).join(' ');
  await ctx.store.liveMeetings.putMeeting({ ...meeting, transcript });
  for (const question of questions) await ctx.store.liveMeetings.addInsight('session-1', question);
  const known = (await ctx.store.liveMeetings.questions('session-1', meeting.id))!;
  expect(known.map(({ id }) => id)).toContain(questions[0]!.id);
  expect(known).toHaveLength(questions.length);
  await ctx.store.liveMeetings.reconcileQuestions('session-1', meeting.id, 1, {
    text: 'Item zero costs ten euros.',
    acceptedIds: [],
    resolvedIds: [known.find(({ id }) => id === questions[0]!.id)!.id],
    insights: [],
  });
  expect(
    (await ctx.store.liveMeetings.questions('session-1', meeting.id))?.map(({ id }) => id),
  ).not.toContain(questions[0]!.id);
});

it('rejects stale batch publication after a question is resolved at a newer revision', async () => {
  const question = {
    id: 'question-price',
    meetingId: meeting.id,
    kind: 'research' as const,
    summary: 'What is the price?',
    evidenceA: 'What is the price?',
    evidenceB: null,
    sourcePath: null,
    createdAt: 1,
  };
  await ctx.store.liveMeetings.putMeeting({ ...meeting, transcript: question.evidenceA });
  await ctx.store.liveMeetings.addInsight('session-1', question);
  await ctx.store.liveMeetings.putMeeting({
    ...meeting,
    revision: 2,
    transcript: question.evidenceA + ' Ten euros.',
  });
  await ctx.store.liveMeetings.reconcileQuestions('session-1', meeting.id, 2, {
    text: 'Ten euros.',
    acceptedIds: [],
    resolvedIds: [question.id],
    insights: [],
  });
  expect(
    await ctx.store.liveMeetings.addInsight(
      'session-1',
      { ...question, id: 'batch-price' },
      false,
      1,
    ),
  ).toBe(false);
  expect(await ctx.store.liveMeetings.insights('session-1', meeting.id)).toEqual([]);
});

it('suppresses batch evidence published after resolution at the same revision', async () => {
  const question = {
    id: 'question-price',
    meetingId: meeting.id,
    kind: 'research' as const,
    summary: 'What is the price?',
    evidenceA: 'What is the price.',
    evidenceB: null,
    sourcePath: null,
    createdAt: 1,
  };
  await ctx.store.liveMeetings.putMeeting({
    ...meeting,
    transcript: question.evidenceA + ' Ten euros.',
  });
  await ctx.store.liveMeetings.addInsight('session-1', question);
  await ctx.store.liveMeetings.reconcileQuestions('session-1', meeting.id, 1, {
    text: 'Ten euros.',
    acceptedIds: [],
    resolvedIds: [question.id],
    insights: [],
  });
  expect(await ctx.store.liveMeetings.questions('session-1', meeting.id)).toEqual([]);
  expect(
    await ctx.store.liveMeetings.addInsight(
      'session-1',
      { ...question, id: 'batch-price' },
      false,
      1,
    ),
  ).toBe(false);
  expect(await ctx.store.liveMeetings.insights('session-1', meeting.id)).toEqual([]);
});
