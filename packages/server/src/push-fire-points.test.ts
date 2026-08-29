import type { AgentEvent } from '@verity/events';
import type { SequencedEvent } from '@verity/store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPushFirePoints, createPushForegroundPresence } from './push-fire-points.js';
import type { PushLogger, PushSendResult, PushSender } from './push-sender.js';

const SENT: PushSendResult = {
  targets: 1,
  ticketsAccepted: 1,
  ticketErrors: 0,
  receiptsQueued: 1,
  pruned: 0,
  transportErrors: 0,
};

function event(value: AgentEvent, seq = 1): SequencedEvent {
  return { seq, ts: seq * 1_000, event: value };
}

function resultEvent(): AgentEvent {
  return {
    t: 'result',
    usage: {
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    },
    stopReason: 'end_turn',
  };
}

function textEvent(delta: string, seq: number, parentToolId?: string): SequencedEvent {
  return event(
    parentToolId === undefined ? { t: 'text', delta } : { t: 'text', delta, parentToolId },
    seq,
  );
}

function fakeSender(): Omit<PushSender, 'send'> & {
  send: ReturnType<typeof vi.fn<PushSender['send']>>;
} {
  return {
    send: vi.fn<PushSender['send']>().mockResolvedValue(SENT),
    processDueReceipts: vi.fn().mockResolvedValue({
      due: 0,
      delivered: 0,
      receiptErrors: 0,
      missing: 0,
      retried: 0,
      expired: 0,
      pruned: 0,
      transportErrors: 0,
    }),
    start: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

function fakeLogger(): Omit<PushLogger, 'warn'> & {
  warn: ReturnType<typeof vi.fn<PushLogger['warn']>>;
} {
  return {
    info: vi.fn<PushLogger['info']>(),
    warn: vi.fn<PushLogger['warn']>(),
  };
}

describe('PushFirePoints', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('sends a generic permission payload without agent-generated content', async () => {
    const sender = fakeSender();
    const firePoints = createPushFirePoints({
      sender,
      presence: createPushForegroundPresence(),
      debounceMs: 750,
    });

    firePoints.observe(
      'session-1',
      event({
        t: 'permission',
        id: 'tool-use-1',
        tool: 'Bash',
        input: { command: 'sensitive command' },
        riskClass: 'ask',
      }),
    );
    await vi.advanceTimersByTimeAsync(750);

    expect(sender.send).toHaveBeenCalledWith({
      title: 'Verity · Permission needed',
      body: 'A session wants to run Bash.',
      categoryId: 'PERMISSION_PROMPT',
      data: { sessionId: 'session-1', kind: 'permission', toolUseId: 'tool-use-1' },
      priority: 'high',
    });
    expect(JSON.stringify(sender.send.mock.calls)).not.toContain('sensitive command');
    await firePoints.close();
  });

  it('adds project and session context without exposing tool input', async () => {
    const sender = fakeSender();
    const firePoints = createPushFirePoints({
      sender,
      presence: createPushForegroundPresence(),
      debounceMs: 10,
      describeSession: async () => ({ project: 'heey-global/verity', session: 'Push polish' }),
    });
    firePoints.observe(
      'session-1',
      event({
        t: 'permission',
        id: 'p1',
        tool: 'Bash',
        input: { command: 'secret command' },
        riskClass: 'ask',
      }),
    );
    await vi.advanceTimersByTimeAsync(10);
    expect(sender.send).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'heey-global/verity · Permission needed',
        body: 'Push polish wants to run Bash.',
      }),
    );
    expect(JSON.stringify(sender.send.mock.calls)).not.toContain('secret command');
    await firePoints.close();
  });

  it('suppresses fan-out while any device has the session open', async () => {
    const sender = fakeSender();
    const presence = createPushForegroundPresence();
    const detachPhone = presence.attach('session-1');
    const detachTablet = presence.attach('session-1');
    const firePoints = createPushFirePoints({ sender, presence, debounceMs: 100 });

    firePoints.observe(
      'session-1',
      event({ t: 'permission', id: 'p1', tool: 'Bash', input: {}, riskClass: 'ask' }),
    );
    await vi.advanceTimersByTimeAsync(100);
    detachPhone();
    firePoints.observe(
      'session-1',
      event({ t: 'permission', id: 'p2', tool: 'Bash', input: {}, riskClass: 'ask' }, 2),
    );
    await vi.advanceTimersByTimeAsync(100);
    expect(sender.send).not.toHaveBeenCalled();

    detachTablet();
    firePoints.observe(
      'session-1',
      event({ t: 'permission', id: 'p3', tool: 'Bash', input: {}, riskClass: 'ask' }, 3),
    );
    await vi.advanceTimersByTimeAsync(100);
    expect(sender.send).toHaveBeenCalledOnce();
    await firePoints.close();
  });

  it('lets a reconnect during the debounce window suppress the push', async () => {
    const sender = fakeSender();
    const presence = createPushForegroundPresence();
    const firePoints = createPushFirePoints({ sender, presence, debounceMs: 750 });

    firePoints.observe(
      'session-1',
      event({ t: 'permission', id: 'p1', tool: 'Bash', input: {}, riskClass: 'ask' }),
    );
    await vi.advanceTimersByTimeAsync(500);
    presence.attach('session-1');
    await vi.advanceTimersByTimeAsync(250);

    expect(sender.send).not.toHaveBeenCalled();
    await firePoints.close();
  });

  it('cancels a permission push resolved during the debounce window', async () => {
    const sender = fakeSender();
    const firePoints = createPushFirePoints({
      sender,
      presence: createPushForegroundPresence(),
      debounceMs: 100,
    });
    firePoints.observe(
      'session-1',
      event({ t: 'permission', id: 'p1', tool: 'Bash', input: {}, riskClass: 'ask' }),
    );
    firePoints.permissionResolved('session-1', 'p1');
    await vi.advanceTimersByTimeAsync(100);

    expect(sender.send).not.toHaveBeenCalled();
    await firePoints.close();
  });

  it('cancels a stale permission when its turn settles during debounce', async () => {
    const sender = fakeSender();
    const firePoints = createPushFirePoints({
      sender,
      presence: createPushForegroundPresence(),
      debounceMs: 100,
    });
    firePoints.observe(
      'session-1',
      event({ t: 'permission', id: 'p1', tool: 'Bash', input: {}, riskClass: 'ask' }),
    );
    firePoints.observe('session-1', event({ t: 'status', state: 'crashed' }, 2));
    await vi.advanceTimersByTimeAsync(100);

    expect(sender.send).toHaveBeenCalledOnce();
    expect(sender.send).toHaveBeenCalledWith(
      expect.objectContaining({ data: { sessionId: 'session-1', kind: 'crashed' } }),
    );
    await firePoints.close();
  });

  it('deduplicates result plus status and emits a later crashed turn separately', async () => {
    const sender = fakeSender();
    const firePoints = createPushFirePoints({
      sender,
      presence: createPushForegroundPresence(),
      debounceMs: 10,
    });

    firePoints.observe('session-1', event({ t: 'prompt', text: 'first' }));
    firePoints.observe('session-1', event(resultEvent(), 2));
    firePoints.observe('session-1', event({ t: 'status', state: 'completed' }, 3));
    await vi.advanceTimersByTimeAsync(10);
    expect(sender.send).toHaveBeenCalledTimes(1);
    expect(sender.send).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: { sessionId: 'session-1', kind: 'completed' } }),
    );

    firePoints.observe('session-1', event({ t: 'prompt', text: 'second' }, 4));
    firePoints.observe('session-1', event({ t: 'error', kind: 'run_failed', message: 'x' }, 5));
    await vi.advanceTimersByTimeAsync(10);
    expect(sender.send).toHaveBeenCalledTimes(2);
    expect(sender.send).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: { sessionId: 'session-1', kind: 'crashed' } }),
    );
    await firePoints.close();
  });

  it('cancels a stale completion when the next turn starts during debounce', async () => {
    const sender = fakeSender();
    const firePoints = createPushFirePoints({
      sender,
      presence: createPushForegroundPresence(),
      debounceMs: 100,
    });
    firePoints.observe('session-1', event(resultEvent()));
    await vi.advanceTimersByTimeAsync(50);
    firePoints.observe('session-1', event({ t: 'prompt', text: 'next turn' }, 2));
    await vi.advanceTimersByTimeAsync(50);

    expect(sender.send).not.toHaveBeenCalled();
    await firePoints.close();
  });

  it('does not treat a result with an open background task as turn completion', async () => {
    const sender = fakeSender();
    const firePoints = createPushFirePoints({
      sender,
      presence: createPushForegroundPresence(),
      debounceMs: 10,
    });
    firePoints.observe('session-1', event({ t: 'task', id: 'task-1', phase: 'started' }));
    firePoints.observe('session-1', event(resultEvent(), 2));
    await vi.advanceTimersByTimeAsync(10);
    expect(sender.send).not.toHaveBeenCalled();

    firePoints.observe(
      'session-1',
      event({ t: 'task', id: 'task-1', phase: 'ended', status: 'completed' }, 3),
    );
    firePoints.observe('session-1', event({ t: 'status', state: 'completed' }, 4));
    await vi.advanceTimersByTimeAsync(10);
    expect(sender.send).toHaveBeenCalledOnce();
    await firePoints.close();
  });

  it('fires AGENT_QUESTION when a turn ends on a prose question', async () => {
    const sender = fakeSender();
    const firePoints = createPushFirePoints({
      sender,
      presence: createPushForegroundPresence(),
      debounceMs: 10,
    });
    firePoints.observe('session-1', event({ t: 'prompt', text: 'do the thing' }));
    firePoints.observe(
      'session-1',
      textEvent('I can do that. Which branch should I base it on?', 2),
    );
    firePoints.observe('session-1', event(resultEvent(), 3));
    await vi.advanceTimersByTimeAsync(10);

    expect(sender.send).toHaveBeenCalledOnce();
    expect(sender.send).toHaveBeenCalledWith({
      title: 'Verity · Reply needed',
      body: 'A session is waiting for your answer.',
      categoryId: 'AGENT_QUESTION',
      data: { sessionId: 'session-1', kind: 'question' },
      priority: 'high',
    });
    await firePoints.close();
  });

  it('sees through trailing markdown wrappers around the question mark', async () => {
    const sender = fakeSender();
    const firePoints = createPushFirePoints({
      sender,
      presence: createPushForegroundPresence(),
      debounceMs: 10,
    });
    firePoints.observe('session-1', event({ t: 'prompt', text: 'go' }));
    firePoints.observe('session-1', textEvent('Ready — **shall I proceed?**\n', 2));
    firePoints.observe('session-1', event(resultEvent(), 3));
    await vi.advanceTimersByTimeAsync(10);

    expect(sender.send).toHaveBeenCalledWith(
      expect.objectContaining({
        categoryId: 'AGENT_QUESTION',
        data: { sessionId: 'session-1', kind: 'question' },
      }),
    );
    await firePoints.close();
  });

  it('fires the ordinary completion when the final prose is not a question', async () => {
    const sender = fakeSender();
    const firePoints = createPushFirePoints({
      sender,
      presence: createPushForegroundPresence(),
      debounceMs: 10,
    });
    firePoints.observe('session-1', event({ t: 'prompt', text: 'go' }));
    firePoints.observe('session-1', textEvent('All done — I shipped the change.', 2));
    firePoints.observe('session-1', event(resultEvent(), 3));
    await vi.advanceTimersByTimeAsync(10);

    expect(sender.send).toHaveBeenCalledWith(
      expect.objectContaining({
        categoryId: 'SESSION_STATUS',
        data: { sessionId: 'session-1', kind: 'completed' },
      }),
    );
    await firePoints.close();
  });

  it('ignores tool-nested text when deciding whether a turn asked a question', async () => {
    const sender = fakeSender();
    const firePoints = createPushFirePoints({
      sender,
      presence: createPushForegroundPresence(),
      debounceMs: 10,
    });
    firePoints.observe('session-1', event({ t: 'prompt', text: 'audit it' }));
    // A subagent's own prose (parentToolId) is not a question directed at the operator.
    firePoints.observe('session-1', textEvent('Should I delete this file?', 2, 'tool-7'));
    firePoints.observe('session-1', event(resultEvent(), 3));
    await vi.advanceTimersByTimeAsync(10);

    expect(sender.send).toHaveBeenCalledWith(
      expect.objectContaining({
        categoryId: 'SESSION_STATUS',
        data: { sessionId: 'session-1', kind: 'completed' },
      }),
    );
    await firePoints.close();
  });

  it('resets the question tail across turns so a prior question does not taint a later completion', async () => {
    const sender = fakeSender();
    const firePoints = createPushFirePoints({
      sender,
      presence: createPushForegroundPresence(),
      debounceMs: 10,
    });
    firePoints.observe('session-1', event({ t: 'prompt', text: 'one' }));
    firePoints.observe('session-1', textEvent('What should I name it?', 2));
    firePoints.observe('session-1', event(resultEvent(), 3));
    await vi.advanceTimersByTimeAsync(10);
    expect(sender.send).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: { sessionId: 'session-1', kind: 'question' } }),
    );

    firePoints.observe('session-1', event({ t: 'prompt', text: 'call it foo' }, 4));
    firePoints.observe('session-1', textEvent('Done — merged as foo.', 5));
    firePoints.observe('session-1', event(resultEvent(), 6));
    await vi.advanceTimersByTimeAsync(10);
    expect(sender.send).toHaveBeenCalledTimes(2);
    expect(sender.send).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: { sessionId: 'session-1', kind: 'completed' } }),
    );
    await firePoints.close();
  });

  it('suppresses the question push while a device views the session', async () => {
    const sender = fakeSender();
    const presence = createPushForegroundPresence();
    presence.attach('session-1');
    const firePoints = createPushFirePoints({ sender, presence, debounceMs: 10 });
    firePoints.observe('session-1', event({ t: 'prompt', text: 'go' }));
    firePoints.observe('session-1', textEvent('Which one?', 2));
    firePoints.observe('session-1', event(resultEvent(), 3));
    await vi.advanceTimersByTimeAsync(10);

    expect(sender.send).not.toHaveBeenCalled();
    await firePoints.close();
  });

  it('contains sender failures and logs no upstream detail', async () => {
    const sender = fakeSender();
    sender.send.mockRejectedValueOnce(new Error('sensitive Expo response'));
    const logger = fakeLogger();
    const firePoints = createPushFirePoints({
      sender,
      presence: createPushForegroundPresence(),
      logger,
      debounceMs: 10,
    });
    firePoints.observe('session-1', event(resultEvent()));
    await vi.advanceTimersByTimeAsync(10);

    expect(logger.warn).toHaveBeenCalledWith(
      { component: 'push', kind: 'completed' },
      'verity: push fire point failed',
    );
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('sensitive');
    await firePoints.close();
  });
});
