import Fastify, { type FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import { createTestDb, truncateAll, type TestDb } from '@verity/store/testing';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { registerLiveMeetingRoutes, verifiedSpeakerName } from './live-meeting-routes.js';

let ctx: TestDb;
let app: FastifyInstance;
const ownerToken = 'a'.repeat(64);
const url = '/sessions/session-1/live-meetings/meeting-1';
const meeting = {
  engine: 'fluid-nemotron',
  startedAt: 100,
  endedAt: null,
  state: 'active',
  transcript: 'Live words',
  captureStatus: 'listening',
  ownerToken,
  revision: 1,
};

beforeAll(async () => {
  ctx = await createTestDb();
  app = Fastify();
  registerLiveMeetingRoutes(app, ctx.store);
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await ctx.close();
});
beforeEach(async () => {
  await truncateAll(ctx.db);
  await ctx.store.createSession({ sessionId: 'session-1', worktree: '/one', model: 'm' });
});

it('publishes transcript and notes without exposing the recorder token', async () => {
  expect((await app.inject({ method: 'PUT', url, payload: meeting })).statusCode).toBe(200);
  expect(
    (
      await app.inject({
        method: 'PUT',
        url: `${url}/notes/note-1`,
        payload: {
          atSeconds: 2,
          text: 'Decision',
          revision: 1,
        },
      })
    ).statusCode,
  ).toBe(200);
  const response = await app.inject({ method: 'GET', url: '/sessions/session-1/live-meetings' });
  expect(response.statusCode).toBe(200);
  const body = response.json();
  expect(body.meetings).toEqual([expect.objectContaining({ transcript: 'Live words' })]);
  expect(body.notes).toEqual([expect.objectContaining({ text: 'Decision' })]);
  expect(response.body).not.toContain(ownerToken);
  expect(body.meetings[0]).not.toHaveProperty('ownerTokenHash');
});

it('syncs bounded speaker turns and the expected group size', async () => {
  const speakerTurns = [
    { speaker: 0, start: 0.5, end: 1.25 },
    { speaker: 1, start: 1.25, end: 2.5 },
  ];
  const timedWords = [
    {
      text: 'A recognized Apple segment can exceed one hundred characters. '.repeat(3),
      start: 0.5,
      end: 1.0,
    },
  ];
  const speakerNames = { '0': 'Anna' };
  const speakerCorrections = [{ start: 0.5, end: 1, speaker: 1 }];
  const speakerMerges = { '1': 0 };
  expect(
    (
      await app.inject({
        method: 'PUT',
        url,
        payload: {
          ...meeting,
          expectedParticipants: 6,
          speakerTurns,
          timedWords,
          speakerNames,
          speakerCorrections,
          speakerMerges,
        },
      })
    ).statusCode,
  ).toBe(200);
  const response = await app.inject({ method: 'GET', url: '/sessions/session-1/live-meetings' });
  expect(response.json().meetings[0]).toMatchObject({
    expectedParticipants: 6,
    speakerTurns,
    timedWords,
    speakerNames,
    speakerCorrections,
    speakerMerges,
  });
  expect(
    (
      await app.inject({
        method: 'PUT',
        url: `${url}-bad`,
        payload: {
          ...meeting,
          expectedParticipants: 6,
          speakerTurns: [{ speaker: 1, start: 3, end: 2 }],
        },
      })
    ).statusCode,
  ).toBe(400);
});

it('publishes only transcript-grounded analysis to the meeting session', async () => {
  const analyzed = Fastify();
  const query = vi.fn().mockResolvedValue(
    JSON.stringify({
      insights: [
        {
          kind: 'contradiction',
          summary: 'Two delivery dates were mentioned.',
          evidenceA: 'Delivery is on Tuesday.',
          evidenceB: 'Delivery is on Friday.',
        },
        {
          kind: 'research',
          summary: 'Check the claimed growth figure.',
          evidenceA: 'Growth was 40 percent last quarter.',
        },
        {
          kind: 'research',
          summary: 'Unquoted claim must not appear.',
          evidenceA: 'This sentence was never spoken.',
        },
      ],
    }),
  );
  registerLiveMeetingRoutes(analyzed, ctx.store, { query, delayMs: 1 });
  await analyzed.ready();
  try {
    const transcript =
      'Delivery is on Tuesday. Growth was 40 percent last quarter. Delivery is on Friday. ' +
      'We should check the figures before making a decision.';
    expect(
      (await analyzed.inject({ method: 'PUT', url, payload: { ...meeting, transcript } }))
        .statusCode,
    ).toBe(200);
    await vi.waitFor(async () => {
      const result = await analyzed.inject({ method: 'GET', url: `${url}/insights` });
      expect(result.statusCode).toBe(200);
      expect(result.json().insights).toHaveLength(2);
    });
    const response = await analyzed.inject({ method: 'GET', url: `${url}/insights` });
    expect(response.json().insights).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'contradiction', evidenceB: 'Delivery is on Friday.' }),
        expect.objectContaining({ kind: 'research', evidenceB: null }),
      ]),
    );
    const { insights } = response.json<{ insights: Array<{ kind: string; id: string }> }>();
    expect(insights.find((item) => item.kind === 'research')?.id).toBe(
      createHash('sha256')
        .update('meeting-1\0research\0Growth was 40 percent last quarter.\0')
        .digest('hex'),
    );
    expect(query).toHaveBeenCalledOnce();
    expect(
      (
        await analyzed.inject({
          method: 'GET',
          url: '/sessions/session-1/live-meetings/other/insights',
        })
      ).statusCode,
    ).toBe(404);
  } finally {
    await analyzed.close();
  }
});

it('publishes a project contradiction only with an exact quote from its cited source', async () => {
  const analyzed = Fastify();
  const knowledge = vi
    .fn()
    .mockResolvedValue([{ path: 'insights/plan.md', text: 'The delivery date is Tuesday.' }]);
  const query = vi.fn().mockResolvedValue(
    JSON.stringify({
      insights: [
        {
          kind: 'contradiction',
          summary: 'The dates may conflict.',
          evidenceA: 'Delivery is on Friday.',
          evidenceB: 'The delivery date is Tuesday.',
          sourcePath: 'insights/plan.md',
        },
        {
          kind: 'contradiction',
          summary: 'False source quote.',
          evidenceA: 'Delivery is on Friday.',
          evidenceB: 'The delivery date is Monday.',
          sourcePath: 'insights/plan.md',
        },
        {
          kind: 'contradiction',
          summary: 'Wrong source path.',
          evidenceA: 'Delivery is on Friday.',
          evidenceB: 'The delivery date is Tuesday.',
          sourcePath: 'insights/other.md',
        },
      ],
    }),
  );
  registerLiveMeetingRoutes(analyzed, ctx.store, { query, knowledge, delayMs: 1 });
  await analyzed.ready();
  try {
    const transcript =
      'We discussed the schedule in detail and agreed on the next steps. Delivery is on Friday. Please record this date for the project.';
    await analyzed.inject({ method: 'PUT', url, payload: { ...meeting, transcript } });
    await vi.waitFor(async () => {
      const response = await analyzed.inject({ method: 'GET', url: `${url}/insights` });
      expect(response.json().insights).toHaveLength(1);
    });
    const response = await analyzed.inject({ method: 'GET', url: `${url}/insights` });
    expect(response.json().insights[0]).toMatchObject({
      sourcePath: 'insights/plan.md',
      evidenceB: 'The delivery date is Tuesday.',
    });
    expect(knowledge).toHaveBeenCalledWith('session-1', transcript);
    expect(query.mock.calls[0]?.[1]).toContain('insights/plan.md');
  } finally {
    await analyzed.close();
  }
});

it('does not analyze a stale recorder upload', async () => {
  const analyzed = Fastify();
  const query = vi.fn().mockResolvedValue('{"insights":[]}');
  registerLiveMeetingRoutes(analyzed, ctx.store, { query, delayMs: 1 });
  await analyzed.ready();
  try {
    const transcript =
      'This is a long enough transcript to trigger analysis after the recorder sends it. ' +
      'The next sentence makes the minimum length unambiguous.';
    await app.inject({ method: 'PUT', url, payload: { ...meeting, revision: 2, transcript } });
    await analyzed.inject({ method: 'PUT', url, payload: { ...meeting, revision: 1, transcript } });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(query).not.toHaveBeenCalled();
  } finally {
    await analyzed.close();
  }
});

it('retries a failed analysis for the same final transcript', async () => {
  const analyzed = Fastify();
  const query = vi
    .fn()
    .mockRejectedValueOnce(new Error('temporary provider failure'))
    .mockResolvedValueOnce('{"insights":[]}');
  registerLiveMeetingRoutes(analyzed, ctx.store, { query, delayMs: 1, minIntervalMs: 1 });
  await analyzed.ready();
  try {
    const transcript =
      'The final transcript is long enough for analysis. ' +
      'The recording has stopped, so there will be no further upload to trigger a retry.';
    await analyzed.inject({
      method: 'PUT',
      url,
      payload: { ...meeting, transcript, state: 'ended', endedAt: 200 },
    });
    await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(2));
    await analyzed.inject({
      method: 'PUT',
      url,
      payload: { ...meeting, transcript, state: 'ended', endedAt: 200 },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(query).toHaveBeenCalledTimes(2);
  } finally {
    await analyzed.close();
  }
});

it('analyzes a changed final transcript even after a short closing remark', async () => {
  const analyzed = Fastify();
  const query = vi.fn().mockResolvedValue('{"insights":[]}');
  registerLiveMeetingRoutes(analyzed, ctx.store, { query, delayMs: 1, minIntervalMs: 1 });
  await analyzed.ready();
  try {
    const transcript =
      'The team reviewed the release plan and agreed to verify the figures before the next update. ' +
      'Everyone confirmed the current timetable.';
    await analyzed.inject({ method: 'PUT', url, payload: { ...meeting, transcript } });
    await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(1));
    await analyzed.inject({
      method: 'PUT',
      url,
      payload: {
        ...meeting,
        revision: 2,
        state: 'ended',
        endedAt: 200,
        transcript: `${transcript} Is Friday still correct?`,
      },
    });
    await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(2));
  } finally {
    await analyzed.close();
  }
});

it('does not launch a second analysis for a tiny update queued during the first', async () => {
  const analyzed = Fastify();
  let release!: (value: string) => void;
  const query = vi.fn().mockImplementationOnce(
    () =>
      new Promise<string>((resolve) => {
        release = resolve;
      }),
  );
  registerLiveMeetingRoutes(analyzed, ctx.store, { query, delayMs: 1, minIntervalMs: 1 });
  await analyzed.ready();
  try {
    const transcript =
      'The team reviewed the release plan and agreed to verify the figures before the next update. ' +
      'Everyone confirmed the current timetable.';
    await analyzed.inject({ method: 'PUT', url, payload: { ...meeting, transcript } });
    await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(1));
    await analyzed.inject({
      method: 'PUT',
      url,
      payload: { ...meeting, revision: 2, transcript: `${transcript} Okay.` },
    });
    release('{"insights":[]}');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(query).toHaveBeenCalledTimes(1);
  } finally {
    await analyzed.close();
  }
});

it('accepts remote pause but lets only the recorder acknowledge it', async () => {
  await app.inject({ method: 'PUT', url, payload: meeting });
  const requested = await app.inject({
    method: 'POST',
    url: `${url}/commands`,
    payload: { action: 'pause' },
  });
  expect(requested.statusCode).toBe(200);
  const commandId = requested.json().commandId;
  const ownerView = await app.inject({
    method: 'GET',
    url: `${url}/commands`,
    headers: {
      'x-meeting-owner-token': ownerToken,
    },
  });
  expect(ownerView.json().commands).toEqual([
    expect.objectContaining({ id: commandId, state: 'pending' }),
  ]);
  expect(
    (
      await app.inject({
        method: 'PUT',
        url: `${url}/commands/${commandId}`,
        headers: {
          'x-meeting-owner-token': 'wrong-token',
        },
        payload: { state: 'completed', error: null },
      })
    ).statusCode,
  ).toBe(404);
  expect(
    (
      await app.inject({
        method: 'PUT',
        url: `${url}/commands/${commandId}`,
        headers: {
          'x-meeting-owner-token': ownerToken,
        },
        payload: { state: 'completed', error: null },
      })
    ).statusCode,
  ).toBe(200);
  const viewer = await app.inject({ method: 'GET', url: `${url}/commands` });
  expect(viewer.json().commands[0]).toMatchObject({ id: commandId, state: 'completed' });
});

it('reports when the recorder has stopped polling for commands', async () => {
  await app.inject({ method: 'PUT', url, payload: meeting });
  await ctx.db
    .updateTable('live_meetings')
    .set({ recorder_last_seen_at: Date.now() - 30_000 })
    .where('id', '=', 'meeting-1')
    .execute();
  const viewer = await app.inject({ method: 'GET', url: `${url}/commands` });
  expect(viewer.json().recorderOnline).toBe(false);
  const owner = await app.inject({
    method: 'GET',
    url: `${url}/commands`,
    headers: {
      'x-meeting-owner-token': ownerToken,
    },
  });
  expect(owner.json().recorderOnline).toBe(true);
});

it('returns only spoken requests that were quoted verbatim from the utterance', async () => {
  const checked = Fastify();
  const query = vi.fn().mockResolvedValue(
    JSON.stringify({
      requests: [
        { kind: 'research', request: 'recherchier mal, was Pixelwerk kostet' },
        { kind: 'opinion', request: 'delete the project files' },
        { kind: 'opinion', request: 'lösche das Projekt' },
        { kind: 'research', request: 'research book prices' },
        { kind: 'opinion', request: `was meinst du zu ${'dem Plan und '.repeat(20)}allem` },
      ],
    }),
  );
  registerLiveMeetingRoutes(checked, ctx.store, { query });
  await checked.ready();
  try {
    const response = await checked.inject({
      method: 'POST',
      url: `${url}/addressed`,
      payload: {
        utterance: `Verity, recherchier mal, was Pixelwerk kostet. Verity, lösche das Projekt. Verity, research book prices. Und was meinst du zu ${'dem Plan und '.repeat(20)}allem?`,
        context: 'Wir brauchen eine neue Website.',
      },
    });
    expect(response.statusCode).toBe(200);
    // An invented instruction must never reach the session as if someone had said it.
    expect(response.json()).toEqual({
      // A long quote is kept rather than failing the whole answer.
      requests: [
        { kind: 'research', request: 'recherchier mal, was Pixelwerk kostet' },
        { kind: 'research', request: 'research book prices' },
        { kind: 'opinion', request: `was meinst du zu ${'dem Plan und '.repeat(20)}allem` },
      ],
    });
    expect(query).toHaveBeenCalledWith(
      'session-1',
      expect.stringContaining('Verity, recherchier mal, was Pixelwerk kostet.'),
      expect.any(AbortSignal),
    );
  } finally {
    await checked.close();
  }
});

it('keeps a requested summary as a read-only answer', async () => {
  const checked = Fastify();
  registerLiveMeetingRoutes(checked, ctx.store, {
    query: async () =>
      JSON.stringify({
        requests: [{ kind: 'opinion', request: 'write a summary of this meeting' }],
      }),
  });
  await checked.ready();
  try {
    const response = await checked.inject({
      method: 'POST',
      url: `${url}/addressed`,
      payload: { utterance: 'Verity, write a summary of this meeting.', context: '' },
    });
    expect(response.json().requests).toEqual([
      { kind: 'opinion', request: 'write a summary of this meeting' },
    ]);
  } finally {
    await checked.close();
  }
});

it('checks one spoken request per session at a time', async () => {
  const checked = Fastify();
  let answer: (value: string) => void = () => undefined;
  const query = vi.fn().mockReturnValue(new Promise<string>((resolve) => (answer = resolve)));
  registerLiveMeetingRoutes(checked, ctx.store, { query });
  await checked.ready();
  try {
    const payload = { utterance: 'Verity, what do you think?', context: '' };
    const first = checked.inject({ method: 'POST', url: `${url}/addressed`, payload });
    await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(1));
    // A different meeting id in the same session must not open a second parallel model call.
    const second = await checked.inject({
      method: 'POST',
      url: '/sessions/session-1/live-meetings/other-meeting/addressed',
      payload,
    });
    expect(second.statusCode).toBe(429);
    answer(JSON.stringify({ requests: [] }));
    expect((await first).json()).toEqual({ requests: [] });
  } finally {
    await checked.close();
  }
});

it('suggests a speaker name only when it was introduced verbatim', async () => {
  const checked = Fastify();
  const query = vi
    .fn()
    .mockResolvedValueOnce(
      // A code fence around the JSON must not fail the check.
      '```json\n' +
        JSON.stringify({ name: 'Holger Teske', quote: 'Hi, ich bin Holger.' }) +
        '\n```',
    )
    .mockResolvedValueOnce(
      JSON.stringify({ name: 'Anna', quote: 'ich bin heute die Moderatorin' }),
    );
  registerLiveMeetingRoutes(checked, ctx.store, { query });
  await checked.ready();
  try {
    const payload = {
      text: 'Hi, ich bin Holger. Ich freue mich, dass ihr da seid.',
      hints: ['Holger Teske', 'Anna Berg'],
    };
    const named = await checked.inject({ method: 'POST', url: `${url}/speaker-name`, payload });
    // The invited spelling may complete a first name that was actually spoken.
    expect(named.json()).toEqual({ name: 'Holger Teske', quote: 'Hi, ich bin Holger.' });
    expect(query).toHaveBeenCalledWith(
      'session-1',
      expect.stringContaining('"Anna Berg"'),
      expect.any(AbortSignal),
    );
    // A quote nobody said, or a name absent from its quote, must never label a voice.
    const invented = await checked.inject({
      method: 'POST',
      url: `${url}/speaker-name`,
      payload: { text: 'Ja, ich bin heute die Moderatorin.', hints: [] },
    });
    expect(invented.json()).toEqual({ name: null });
  } finally {
    await checked.close();
  }
});

// Each rejected case is a way a wrong name could be shown as someone's identity.
it.each([
  ['a quote that was not said', { name: 'Anna', quote: 'ich bin Anna' }, null],
  ['a name missing from its quote', { name: 'Anna', quote: 'ich bin Holger' }, null],
  [
    'an uninvited full name only partly spoken',
    { name: 'Holger Meier', quote: 'ich bin Holger' },
    null,
  ],
  ['a role word', { name: 'Lehrer 2', quote: 'ich bin Holger' }, null],
  ['a spoken name', { name: 'Holger', quote: 'ich bin Holger' }, 'Holger'],
  [
    'an invited spelling of a spoken first name',
    { name: 'Anna Berg', quote: "I'm Anna" },
    'Anna Berg',
  ],
])('verifies %s', (_case, result, expected) => {
  expect(
    verifiedSpeakerName("Hallo, ich bin Holger. Later: I'm Anna, hi.", ['Anna Berg'], result),
  ).toBe(expected);
});

it('files finished uploads before acknowledging them and includes late notes', async () => {
  const onFinished = vi.fn(async () => undefined);
  const filing = Fastify();
  registerLiveMeetingRoutes(filing, ctx.store, { onFinished });
  await filing.ready();
  try {
    await filing.inject({ method: 'PUT', url, payload: meeting });
    await filing.inject({
      method: 'PUT',
      url: `${url}/notes/note-1`,
      payload: { atSeconds: 1, text: 'During', revision: 1 },
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    // A running meeting is not filed, however many notes it collects.
    expect(onFinished).not.toHaveBeenCalled();

    await filing.inject({
      method: 'PUT',
      url,
      payload: { ...meeting, state: 'ended', endedAt: 200, revision: 2 },
    });
    // The device sends the final note after the ended meeting: the note updates the filed document.
    await filing.inject({
      method: 'PUT',
      url: `${url}/notes/note-2`,
      payload: { atSeconds: 3, text: 'Last word', revision: 1 },
    });
    await vi.waitFor(() => expect(onFinished).toHaveBeenCalledTimes(2));
    expect(onFinished).toHaveBeenCalledWith('session-1', 'meeting-1');

    // A rename after the end files the meeting again so the document follows it.
    await filing.inject({
      method: 'PUT',
      url,
      payload: {
        ...meeting,
        state: 'ended',
        endedAt: 200,
        speakerNames: { '0': 'Anna' },
        revision: 3,
      },
    });
    await vi.waitFor(() => expect(onFinished).toHaveBeenCalledTimes(3));
    // A stale upload that the store rejects does not file anything.
    await filing.inject({
      method: 'PUT',
      url,
      payload: { ...meeting, state: 'ended', endedAt: 200, revision: 2 },
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(onFinished).toHaveBeenCalledTimes(3);
  } finally {
    await filing.close();
  }
});

it('files late notes after a restart and retries filing failures', async () => {
  await app.inject({ method: 'PUT', url, payload: { ...meeting, state: 'ended', endedAt: 200 } });
  const onFinished = vi
    .fn()
    .mockRejectedValueOnce(new Error('temporary failure'))
    .mockResolvedValue(undefined);
  const restarted = Fastify();
  registerLiveMeetingRoutes(restarted, ctx.store, { onFinished });
  try {
    await restarted.inject({
      method: 'PUT',
      url: `${url}/notes/first-late`,
      payload: { atSeconds: 4, text: 'Late note', revision: 1 },
    });
    await vi.waitFor(() => expect(onFinished).toHaveBeenCalledTimes(2));
    expect(onFinished).toHaveBeenLastCalledWith('session-1', 'meeting-1');
    await restarted.inject({
      method: 'PUT',
      url: `${url}/notes/late`,
      payload: { atSeconds: 5, text: 'After restart', revision: 1 },
    });
    await vi.waitFor(() => expect(onFinished).toHaveBeenCalledTimes(3));
  } finally {
    await restarted.close();
  }
});

it('files server-owned online meetings through the same finished-meeting hook', async () => {
  const online = Fastify();
  const onFinished = vi.fn().mockResolvedValue(undefined);
  const controller = registerLiveMeetingRoutes(online, ctx.store, { onFinished });
  try {
    const record = {
      ...meeting,
      id: 'meeting-1',
      sessionId: 'session-1',
      engine: 'attendee',
      state: 'active' as const,
      ownerTokenHash: createHash('sha256').update(ownerToken).digest('hex'),
    };
    await controller.ingest(record);
    expect(onFinished).not.toHaveBeenCalled();
    await controller.ingest({ ...record, state: 'ended', endedAt: 200, revision: 2 });
    expect(onFinished).toHaveBeenCalledWith('session-1', 'meeting-1');
  } finally {
    await online.close();
  }
});

it('persists immediate question checks and reuses their identity after recognition corrections', async () => {
  const checked = Fastify();
  const query = vi.fn().mockResolvedValueOnce(
    JSON.stringify({
      questions: [{ question: 'Was kostet der Plan?', quote: 'Was kostet der Plan?' }],
    }),
  );
  registerLiveMeetingRoutes(checked, ctx.store, { query, delayMs: 60_000 });
  try {
    await checked.inject({
      method: 'PUT',
      url,
      payload: { ...meeting, transcript: 'Was kostet der Plan?' },
    });
    await vi.waitFor(
      async () =>
        expect((await ctx.store.liveMeetings.insights('session-1', 'meeting-1'))?.length).toBe(1),
      { timeout: 5000 },
    );
    const first = (await ctx.store.liveMeetings.insights('session-1', 'meeting-1'))![0]!;
    query.mockResolvedValueOnce(
      JSON.stringify({
        questions: [
          {
            question: 'Was kostet der Pro-Plan?',
            quote: 'Was kostet der Pro-Plan?',
            existingId: first.id,
          },
        ],
      }),
    );
    await checked.inject({
      method: 'PUT',
      url,
      payload: { ...meeting, revision: 2, transcript: 'Was kostet der Pro-Plan?' },
    });
    await vi.waitFor(
      async () =>
        expect(
          (await ctx.store.liveMeetings.insights('session-1', 'meeting-1'))?.[0]?.summary,
        ).toBe('Was kostet der Pro-Plan?'),
      { timeout: 5000 },
    );
    const all = (await ctx.store.liveMeetings.insights('session-1', 'meeting-1'))!;
    expect(all).toHaveLength(1);
    expect(all[0]?.id).toBe(first.id);
    expect(query).toHaveBeenCalledTimes(2);
    await checked.inject({
      method: 'PUT',
      url,
      payload: { ...meeting, revision: 3, transcript: 'Der Preis steht bereits fest.' },
    });
    await vi.waitFor(
      async () =>
        expect(await ctx.store.liveMeetings.insights('session-1', 'meeting-1')).toHaveLength(0),
      { timeout: 5000 },
    );
    expect(query).toHaveBeenCalledTimes(2);
  } finally {
    await checked.close();
  }
});

it('keeps explicit questions out of periodic claim cards even when model output includes them', async () => {
  const checked = Fastify();
  const question = 'What is the release budget?';
  const query = vi.fn().mockResolvedValue(
    JSON.stringify({
      insights: [
        { kind: 'research', summary: question, evidenceA: question },
        {
          kind: 'research',
          summary: 'Check the budget claim.',
          evidenceA: 'The budget is one million euros.',
        },
      ],
    }),
  );
  registerLiveMeetingRoutes(checked, ctx.store, { query, delayMs: 1 });
  await checked.ready();
  try {
    await checked.inject({
      method: 'PUT',
      url,
      payload: {
        ...meeting,
        transcript: `${question} The budget is one million euros. We need to verify the figures before approval.`,
      },
    });
    await vi.waitFor(async () => {
      const insights = await ctx.store.liveMeetings.insights('session-1', 'meeting-1');
      expect(insights).toHaveLength(1);
      expect(insights?.[0]?.evidenceA).toBe('The budget is one million euros.');
    });
  } finally {
    await checked.close();
  }
});

it('retracts a published question when an answer follows an intervening sentence', async () => {
  const checked = Fastify();
  const query = vi.fn().mockImplementation(async (_session: string, prompt: string) =>
    JSON.stringify({
      questions: prompt.includes('Er kostet zehn Euro.')
        ? []
        : [{ question: 'Was kostet der Plan?', quote: 'Was kostet der Plan?' }],
    }),
  );
  registerLiveMeetingRoutes(checked, ctx.store, { query, delayMs: 60_000 });
  try {
    await checked.inject({
      method: 'PUT',
      url,
      payload: { ...meeting, transcript: 'Was kostet der Plan? Moment, ich prüfe das.' },
    });
    await vi.waitFor(
      async () =>
        expect(await ctx.store.liveMeetings.insights('session-1', 'meeting-1')).toHaveLength(1),
      { timeout: 5000 },
    );
    await checked.inject({
      method: 'PUT',
      url,
      payload: {
        ...meeting,
        revision: 2,
        transcript: 'Was kostet der Plan? Moment, ich prüfe das. Er kostet zehn Euro.',
      },
    });
    await vi.waitFor(
      async () =>
        expect(await ctx.store.liveMeetings.insights('session-1', 'meeting-1')).toHaveLength(0),
      { timeout: 5000 },
    );
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[1]?.[1]).toContain('Er kostet zehn Euro.');
  } finally {
    await checked.close();
  }
});

it('preserves declarative claims beginning with question words', async () => {
  const checked = Fastify();
  const statements = [
    'What we need is ten million euros.',
    'Was wir brauchen, sind zehn Millionen Euro.',
  ];
  const query = vi.fn().mockResolvedValue(
    JSON.stringify({
      insights: statements.map((evidenceA) => ({
        kind: 'research',
        summary: 'Check the stated budget.',
        evidenceA,
      })),
    }),
  );
  registerLiveMeetingRoutes(checked, ctx.store, { query, delayMs: 1 });
  try {
    await checked.inject({
      method: 'PUT',
      url,
      payload: {
        ...meeting,
        transcript:
          statements.join(' ') + ' We should verify both amounts before making a decision.',
      },
    });
    await vi.waitFor(async () =>
      expect(
        (await ctx.store.liveMeetings.insights('session-1', 'meeting-1'))
          ?.map(({ evidenceA }) => evidenceA)
          .sort(),
      ).toEqual([...statements].sort()),
    );
  } finally {
    await checked.close();
  }
});

it('does not duplicate an already classified question lacking question punctuation', async () => {
  const checked = Fastify();
  const question = 'What does the plan cost.';
  const query = vi.fn().mockResolvedValue(
    JSON.stringify({
      insights: [{ kind: 'research', summary: 'Check the plan price.', evidenceA: question }],
    }),
  );
  const onFinished = vi.fn().mockResolvedValue(undefined);
  registerLiveMeetingRoutes(checked, ctx.store, { query, delayMs: 1, onFinished });
  try {
    await ctx.store.liveMeetings.putMeeting({
      id: 'meeting-1',
      sessionId: 'session-1',
      ...meeting,
      ownerTokenHash: createHash('sha256').update(ownerToken).digest('hex'),
      state: 'active',
      transcript:
        question + ' We need these figures before approving the plan and making a decision.',
    });
    await ctx.store.liveMeetings.addInsight('session-1', {
      id: 'question-plan',
      meetingId: 'meeting-1',
      kind: 'research',
      summary: 'What does the plan cost?',
      evidenceA: question,
      evidenceB: null,
      sourcePath: null,
      createdAt: 1,
    });
    await checked.inject({
      method: 'PUT',
      url,
      payload: {
        ...meeting,
        revision: 2,
        state: 'ended',
        endedAt: 1000,
        transcript:
          question + ' We need these figures before approving the plan and making a decision.',
      },
    });
    await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(onFinished).toHaveBeenCalledTimes(2));
    expect(
      (await ctx.store.liveMeetings.insights('session-1', 'meeting-1'))?.map(({ id }) => id),
    ).toEqual(['question-plan']);
  } finally {
    await checked.close();
  }
});

it.each(['http', 'controller'] as const)(
  'binds a paraphrased spoken request only to a question in its own meeting: %s',
  async (path) => {
    const checked = Fastify();
    const query = vi.fn().mockResolvedValue(
      JSON.stringify({
        requests: [
          {
            kind: 'research',
            request: 'research its monthly price',
            questionId: 'question-price',
            questionTitle: 'Injected title',
          },
          { kind: 'research', request: 'check the launch date', questionId: 'question-foreign' },
          { kind: 'opinion', request: 'explain the budget', questionId: null },
        ],
      }),
    );
    const controller = registerLiveMeetingRoutes(checked, ctx.store, { query });
    for (const [meetingId, questionId] of [
      ['meeting-1', 'question-price'],
      ['meeting-other', 'question-foreign'],
    ] as const) {
      await ctx.store.liveMeetings.putMeeting({
        ...meeting,
        id: meetingId,
        sessionId: 'session-1',
        state: 'active',
        ownerTokenHash: createHash('sha256').update(ownerToken).digest('hex'),
      });
      await ctx.store.liveMeetings.addInsight('session-1', {
        id: questionId,
        meetingId,
        kind: 'research',
        summary: 'What does the plan cost?',
        evidenceA: 'What does the plan cost?',
        evidenceB: null,
        sourcePath: null,
        createdAt: 1,
      });
    }
    const utterance =
      'Verity, research its monthly price and check the launch date and explain the budget.';
    try {
      const requests =
        path === 'http'
          ? (
              await checked.inject({
                method: 'POST',
                url: `${url}/addressed`,
                payload: { utterance, context: '' },
              })
            ).json().requests
          : await controller.spoken('session-1', utterance, '', 'meeting-1');
      expect(requests).toEqual([
        {
          kind: 'research',
          request: 'research its monthly price',
          questionId: 'question-price',
          questionTitle: 'What does the plan cost?',
        },
        { kind: 'research', request: 'check the launch date' },
        { kind: 'opinion', request: 'explain the budget' },
      ]);
      expect(query.mock.calls[0]?.[1]).toContain('question-price');
      expect(query.mock.calls[0]?.[1]).not.toContain('question-foreign');
    } finally {
      await checked.close();
    }
  },
);
