import Fastify, { type FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import { createTestDb, truncateAll, type TestDb } from '@verity/store/testing';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { registerLiveMeetingRoutes } from './live-meeting-routes.js';

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
        utterance: `Verity, recherchier mal, was Pixelwerk kostet. Und was meinst du zu ${'dem Plan und '.repeat(20)}allem?`,
        context: 'Wir brauchen eine neue Website.',
      },
    });
    expect(response.statusCode).toBe(200);
    // An invented instruction must never reach the session as if someone had said it.
    expect(response.json()).toEqual({
      // A long quote is kept rather than failing the whole answer.
      requests: [
        { kind: 'research', request: 'recherchier mal, was Pixelwerk kostet' },
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
