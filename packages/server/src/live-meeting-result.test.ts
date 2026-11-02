import { createTestDb, truncateAll, type TestDb } from '@verity/store/testing';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { meetingResultWorker } from './live-meeting-result.js';

let ctx: TestDb;
beforeAll(async () => {
  ctx = await createTestDb();
});
afterAll(async () => {
  await ctx.close();
});
beforeEach(async () => {
  await truncateAll(ctx.db);
  await ctx.store.createSession({ sessionId: 's', worktree: '/one', model: 'm' });
  await ctx.store.liveMeetings.putMeeting({
    id: 'meeting',
    sessionId: 's',
    engine: 'apple-speech',
    startedAt: 0,
    endedAt: 1000,
    state: 'ended',
    transcript: 'We will ship on Friday.',
    captureStatus: 'paused',
    ownerTokenHash: 'hash',
    revision: 1,
  });
});
const answer = JSON.stringify({
  title: 'Release',
  summary: 'The team will ship on Friday.',
  decisions: [
    { text: 'Ship Friday', quote: 'We will ship on Friday.' },
    { text: 'Invented', quote: 'We bought a car.' },
  ],
  tasks: [],
  openQuestions: [],
});
it('grounds the result and deduplicates repeated uploads at one revision', async () => {
  const query = vi.fn().mockResolvedValue(answer);
  const onReady = vi.fn().mockResolvedValue(undefined);
  const worker = meetingResultWorker({ store: ctx.store, query, onReady, onError: vi.fn() });
  try {
    worker.start('s', 'meeting');
    await vi.waitFor(async () =>
      expect((await ctx.store.liveMeetings.result('s', 'meeting'))?.status).toBe('ready'),
    );
    expect((await ctx.store.liveMeetings.result('s', 'meeting'))?.decisions).toEqual([
      expect.objectContaining({ text: 'Ship Friday', speaker: null, atSeconds: null }),
    ]);
    await vi.waitFor(() => expect(onReady).toHaveBeenCalledOnce());
    worker.start('s', 'meeting');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(query).toHaveBeenCalledOnce();
  } finally {
    worker.close();
  }
});
it('fails after three attempts and permits an explicit retry', async () => {
  const query = vi.fn().mockRejectedValue(new Error('Unavailable'));
  const worker = meetingResultWorker({
    store: ctx.store,
    query,
    onReady: vi.fn(),
    onError: vi.fn(),
  });
  try {
    worker.start('s', 'meeting');
    await vi.waitFor(async () =>
      expect((await ctx.store.liveMeetings.result('s', 'meeting'))?.status).toBe('failed'),
    );
    expect(query).toHaveBeenCalledTimes(3);
    query.mockResolvedValue(answer);
    worker.start('s', 'meeting', true);
    await vi.waitFor(async () =>
      expect((await ctx.store.liveMeetings.result('s', 'meeting'))?.status).toBe('ready'),
    );
    expect(query).toHaveBeenCalledTimes(4);
  } finally {
    worker.close();
  }
});
it('does not publish an obsolete model response after transcript correction', async () => {
  let resolve!: (value: string) => void;
  const query = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<string>((done) => {
          resolve = done;
        }),
    )
    .mockResolvedValue(answer);
  const worker = meetingResultWorker({
    store: ctx.store,
    query,
    onReady: vi.fn(),
    onError: vi.fn(),
  });
  try {
    worker.start('s', 'meeting');
    await vi.waitFor(() => expect(query).toHaveBeenCalledOnce());
    const current = (await ctx.store.liveMeetings.changes('s', 0)).meetings[0]!;
    await ctx.store.liveMeetings.putMeeting({
      ...current,
      ownerTokenHash: 'hash',
      revision: 2,
      transcript: 'No decision was made.',
    });
    resolve(answer);
    await vi.waitFor(async () =>
      expect((await ctx.store.liveMeetings.result('s', 'meeting'))?.revision).toBe(2),
    );
    await vi.waitFor(async () =>
      expect((await ctx.store.liveMeetings.result('s', 'meeting'))?.status).toBe('ready'),
    );
    expect((await ctx.store.liveMeetings.result('s', 'meeting'))?.decisions).toEqual([]);
  } finally {
    worker.close();
  }
});

it('recovers a persisted working result after a worker restart', async () => {
  await ctx.store.liveMeetings.saveResult('s', {
    meetingId: 'meeting',
    revision: 1,
    status: 'working',
    title: null,
    summary: null,
    decisions: [],
    tasks: [],
    openQuestions: [],
    model: 'm',
    createdAt: 1,
    updatedAt: 1,
  });
  expect(await ctx.store.liveMeetings.unfinishedResults()).toEqual([
    { sessionId: 's', meetingId: 'meeting' },
  ]);
  const worker = meetingResultWorker({
    store: ctx.store,
    query: vi.fn().mockResolvedValue(answer),
    onReady: vi.fn(),
    onError: vi.fn(),
  });
  try {
    worker.start('s', 'meeting');
    await vi.waitFor(async () =>
      expect((await ctx.store.liveMeetings.result('s', 'meeting'))?.status).toBe('ready'),
    );
    await vi.waitFor(async () =>
      expect(await ctx.store.liveMeetings.unfinishedResults()).toEqual([]),
    );
  } finally {
    worker.close();
  }
});

it('retries filing without regenerating or losing an already-ready result', async () => {
  const query = vi.fn().mockResolvedValue(answer);
  const onReady = vi.fn().mockRejectedValue(new Error('Disk unavailable'));
  const onError = vi.fn();
  const worker = meetingResultWorker({ store: ctx.store, query, onReady, onError });
  try {
    worker.start('s', 'meeting');
    await vi.waitFor(() => expect(onError).toHaveBeenCalled());
    expect(onReady).toHaveBeenCalledTimes(3);
    expect(query).toHaveBeenCalledOnce();
    expect((await ctx.store.liveMeetings.result('s', 'meeting'))?.status).toBe('ready');
    worker.close();
    onReady.mockResolvedValue(undefined);
    const restarted = meetingResultWorker({ store: ctx.store, query, onReady, onError });
    try {
      restarted.start('s', 'meeting');
      await vi.waitFor(async () =>
        expect(await ctx.store.liveMeetings.resultFiled('s', 'meeting', 1)).toBe(true),
      );
      expect(query).toHaveBeenCalledOnce();
    } finally {
      restarted.close();
    }
  } finally {
    worker.close();
  }
});

it('processes a revision arriving while an existing ready result is being filed', async () => {
  await ctx.store.liveMeetings.saveResult('s', {
    meetingId: 'meeting',
    revision: 1,
    status: 'ready',
    title: 'Old',
    summary: 'Old result.',
    decisions: [],
    tasks: [],
    openQuestions: [],
    model: 'm',
    createdAt: 1,
    updatedAt: 1,
  });
  let release!: () => void;
  const onReady = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<void>((done) => {
          release = done;
        }),
    )
    .mockResolvedValue(undefined);
  const query = vi.fn().mockResolvedValue(answer);
  const worker = meetingResultWorker({ store: ctx.store, query, onReady, onError: vi.fn() });
  try {
    worker.start('s', 'meeting');
    await vi.waitFor(() => expect(onReady).toHaveBeenCalledOnce());
    const current = (await ctx.store.liveMeetings.changes('s', 0)).meetings[0]!;
    await ctx.store.liveMeetings.putMeeting({
      ...current,
      revision: 2,
      ownerTokenHash: 'hash',
      transcript: 'No decision was made.',
    });
    worker.start('s', 'meeting');
    release();
    await vi.waitFor(async () =>
      expect((await ctx.store.liveMeetings.result('s', 'meeting'))?.revision).toBe(2),
    );
    await vi.waitFor(async () =>
      expect((await ctx.store.liveMeetings.result('s', 'meeting'))?.status).toBe('ready'),
    );
    expect(query).toHaveBeenCalledOnce();
  } finally {
    worker.close();
  }
});

it('recovers terminal uploads even if no worker ran before restart', async () => {
  expect(await ctx.store.liveMeetings.unfinishedResults()).toEqual([
    { sessionId: 's', meetingId: 'meeting' },
  ]);
  const worker = meetingResultWorker({
    store: ctx.store,
    query: vi.fn().mockResolvedValue(answer),
    onReady: vi.fn(),
    onError: vi.fn(),
  });
  try {
    worker.start('s', 'meeting');
    await vi.waitFor(async () =>
      expect(await ctx.store.liveMeetings.resultFiled('s', 'meeting', 1)).toBe(true),
    );
    const current = (await ctx.store.liveMeetings.changes('s', 0)).meetings[0]!;
    await ctx.store.liveMeetings.putMeeting({
      ...current,
      revision: 2,
      ownerTokenHash: 'hash',
      transcript: 'No decision.',
    });
    expect(await ctx.store.liveMeetings.unfinishedResults()).toEqual([
      { sessionId: 's', meetingId: 'meeting' },
    ]);
    expect((await ctx.store.liveMeetings.result('s', 'meeting'))?.status).toBe('working');
  } finally {
    worker.close();
  }
});
