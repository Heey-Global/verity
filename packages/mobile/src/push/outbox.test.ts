import { describe, expect, it, vi } from 'vitest';
import { createPushOutbox, type PushOutboxEntry, type PushOutboxStorage } from './outbox.js';
import type { PushReplyAction, PushReplyOutcome } from './response.js';

function memoryStorage(initial: PushOutboxEntry[] = []): PushOutboxStorage & {
  snapshot: () => PushOutboxEntry[];
} {
  let entries = [...initial];
  return {
    load: () => Promise.resolve(entries.map((e) => ({ ...e }))),
    save: (next) => {
      entries = next.map((e) => ({ ...e }));
      return Promise.resolve();
    },
    snapshot: () => entries,
  };
}

function sequentialIds(): () => string {
  let n = 0;
  return () => `reply-${++n}`;
}

const PERMISSION_ACTION: PushReplyAction = {
  type: 'decide-permission',
  sessionId: 's1',
  toolUseId: 't1',
  decision: { behavior: 'allow' },
};

describe('createPushOutbox', () => {
  it('can persist without waiting for a network attempt', async () => {
    const storage = memoryStorage();
    const perform = vi.fn<(action: PushReplyAction) => Promise<PushReplyOutcome>>();
    const outbox = createPushOutbox({
      storage,
      perform,
      newId: sequentialIds(),
      now: () => 1000,
    });
    await outbox.queue(PERMISSION_ACTION);
    expect(perform).not.toHaveBeenCalled();
    expect(await outbox.pending()).toEqual([
      { id: 'reply-1', action: PERMISSION_ACTION, attempts: 0, createdAt: 1000 },
    ]);
  });

  it('enqueues, delivers immediately, and drains the entry', async () => {
    const storage = memoryStorage();
    const perform = vi
      .fn<(action: PushReplyAction) => Promise<PushReplyOutcome>>()
      .mockResolvedValue('done');
    const outbox = createPushOutbox({
      storage,
      perform,
      newId: sequentialIds(),
      now: () => 1000,
    });
    await outbox.enqueue(PERMISSION_ACTION);
    // The entry's own id is threaded to `perform` as the clientReplyId (ADR 0008).
    expect(perform).toHaveBeenCalledWith(PERMISSION_ACTION, 'reply-1');
    expect(storage.snapshot()).toEqual([]);
  });

  it('keeps a retryable entry and delivers it on the next flush', async () => {
    const storage = memoryStorage();
    const perform = vi
      .fn<(action: PushReplyAction) => Promise<PushReplyOutcome>>()
      .mockResolvedValueOnce('retry')
      .mockResolvedValueOnce('done');
    const outbox = createPushOutbox({
      storage,
      perform,
      newId: sequentialIds(),
      now: () => 1000,
    });
    await outbox.enqueue(PERMISSION_ACTION);
    expect(await outbox.pending()).toEqual([
      { id: 'reply-1', action: PERMISSION_ACTION, attempts: 1, createdAt: 1000 },
    ]);
    await outbox.flush();
    expect(await outbox.pending()).toEqual([]);
    expect(perform).toHaveBeenCalledTimes(2);
  });

  it('drops a stale entry without retrying', async () => {
    const storage = memoryStorage();
    const perform = vi
      .fn<(action: PushReplyAction) => Promise<PushReplyOutcome>>()
      .mockResolvedValue('stale');
    const outbox = createPushOutbox({
      storage,
      perform,
      newId: sequentialIds(),
      now: () => 1,
    });
    await outbox.enqueue(PERMISSION_ACTION);
    expect(await outbox.pending()).toEqual([]);
    expect(perform).toHaveBeenCalledTimes(1);
  });

  it('never loses an entry solely because transient failures repeat', async () => {
    const storage = memoryStorage();
    const perform = vi
      .fn<(action: PushReplyAction) => Promise<PushReplyOutcome>>()
      .mockResolvedValue('retry');
    const outbox = createPushOutbox({
      storage,
      perform,
      newId: sequentialIds(),
      now: () => 1,
    });
    await outbox.enqueue(PERMISSION_ACTION); // attempt 1 → kept (attempts=1)
    expect((await outbox.pending())[0]?.attempts).toBe(1);
    await outbox.flush();
    expect((await outbox.pending())[0]?.attempts).toBe(2);
  });

  it('never delivers an entry twice when a flush races an enqueue', async () => {
    const storage = memoryStorage();
    const seen: string[] = [];
    const label = (action: PushReplyAction): string => {
      if (action.type === 'send-turn') return action.prompt;
      if (action.type === 'decide-permission') return action.toolUseId;
      return action.sessionId;
    };
    // A slow perform so both operations overlap in wall-clock; serialization must
    // still deliver each action exactly once.
    const perform = vi.fn(async (action: PushReplyAction): Promise<PushReplyOutcome> => {
      seen.push(label(action));
      await Promise.resolve();
      return 'done';
    });
    const outbox = createPushOutbox({
      storage,
      perform,
      newId: sequentialIds(),
      now: () => 1,
    });
    await Promise.all([
      outbox.enqueue(PERMISSION_ACTION),
      outbox.flush(),
      outbox.enqueue({ type: 'send-turn', sessionId: 's1', prompt: 'hi' }),
    ]);
    await outbox.flush();
    expect(seen.filter((id) => id === 't1')).toHaveLength(1);
    expect(seen.filter((id) => id === 'hi')).toHaveLength(1);
    expect(storage.snapshot()).toEqual([]);
  });
});
