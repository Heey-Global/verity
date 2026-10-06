import { SANDBOX_NOT_READY_ERROR_KIND, type AgentEvent } from '@verity/events';
import type { SequencedEvent } from '@verity/store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPushFirePoints, persistedTurnInitiator } from './push-fire-points.js';
import type { PushRouter, SessionNotification } from './push-router.js';
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

/** A router that pushes every notification, so these tests see exactly what the
 * fire points decided to send; per-user routing is `push-router.test.ts`'s. */
function routerFor(sender: Pick<PushSender, 'send'>): Pick<PushRouter, 'notify' | 'cancel'> & {
  notify: ReturnType<typeof vi.fn<PushRouter['notify']>>;
  cancel: ReturnType<typeof vi.fn<PushRouter['cancel']>>;
} {
  return {
    notify: vi.fn<PushRouter['notify']>(async (input: SessionNotification) => {
      await sender.send(input.notification);
      return 'delivered';
    }),
    cancel: vi.fn<PushRouter['cancel']>(),
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
      router: routerFor(sender),
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
      body: 'A session requests permission to continue.',
      categoryId: 'PERMISSION_PROMPT',
      data: { sessionId: 'session-1', kind: 'permission', toolUseId: 'tool-use-1' },
      priority: 'high',
      sound: 'default',
    });
    expect(JSON.stringify(sender.send.mock.calls)).not.toContain('sensitive command');
    await firePoints.close();
  });

  it('adds project and session context without exposing tool input', async () => {
    const sender = fakeSender();
    const firePoints = createPushFirePoints({
      router: routerFor(sender),
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
        body: 'Push polish requests permission to continue.',
      }),
    );
    expect(JSON.stringify(sender.send.mock.calls)).not.toContain('secret command');
    expect(JSON.stringify(sender.send.mock.calls)).not.toContain('Bash');
    await firePoints.close();
  });

  it('cancels a permission push resolved during the debounce window', async () => {
    const sender = fakeSender();
    const firePoints = createPushFirePoints({
      router: routerFor(sender),
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
      router: routerFor(sender),
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
      router: routerFor(sender),
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

  it('sends no crash notification when the turn only found the Sandbox asleep', async () => {
    // This module keeps its own copy of the terminal error kinds, on purpose: what
    // ends a turn and what is worth waking somebody for are different questions.
    // `sandbox_not_ready` is the case where they diverge — the turn is over, but
    // the Sandbox comes back on its own and there is nothing to act on. A phone
    // buzzing "your session crashed" for that is the same false alarm as the red
    // badge, just harder to ignore.
    const sender = fakeSender();
    const firePoints = createPushFirePoints({
      router: routerFor(sender),
      debounceMs: 10,
    });

    firePoints.observe('session-1', event({ t: 'prompt', text: 'go' }));
    firePoints.observe(
      'session-1',
      event({ t: 'error', kind: SANDBOX_NOT_READY_ERROR_KIND, message: 'x' }, 2),
    );
    await vi.advanceTimersByTimeAsync(10);
    expect(sender.send).not.toHaveBeenCalled();
    await firePoints.close();
  });

  it('lets an authoritative crash replace a pending optimistic result notification', async () => {
    const sender = fakeSender();
    const firePoints = createPushFirePoints({
      router: routerFor(sender),
      debounceMs: 100,
    });

    firePoints.observe('session-1', event(resultEvent(), 1));
    firePoints.observe('session-1', event({ t: 'status', state: 'crashed' }, 2));
    await vi.advanceTimersByTimeAsync(100);

    expect(sender.send).toHaveBeenCalledOnce();
    expect(sender.send).toHaveBeenCalledWith(
      expect.objectContaining({ data: { sessionId: 'session-1', kind: 'crashed' } }),
    );
    await firePoints.close();
  });

  it('cancels a stale completion when the next turn starts during debounce', async () => {
    const sender = fakeSender();
    const firePoints = createPushFirePoints({
      router: routerFor(sender),
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
      router: routerFor(sender),
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

  it('does not let a stale task id suppress completion of a later turn', async () => {
    const sender = fakeSender();
    const firePoints = createPushFirePoints({
      router: routerFor(sender),
      debounceMs: 10,
    });
    firePoints.observe('session-1', event({ t: 'task', id: 'old-task', phase: 'started' }));
    firePoints.observe('session-1', event({ t: 'prompt', text: 'new turn' }, 2));
    firePoints.observe('session-1', event(resultEvent(), 3));
    await vi.advanceTimersByTimeAsync(10);
    expect(sender.send).toHaveBeenCalledOnce();
    await firePoints.close();
  });

  it('fires AGENT_QUESTION when a turn ends on a prose question', async () => {
    const sender = fakeSender();
    const firePoints = createPushFirePoints({
      router: routerFor(sender),
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
      sound: 'default',
    });
    await firePoints.close();
  });

  it('sees through trailing markdown wrappers around the question mark', async () => {
    const sender = fakeSender();
    const firePoints = createPushFirePoints({
      router: routerFor(sender),
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
      router: routerFor(sender),
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
      router: routerFor(sender),
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
      router: routerFor(sender),
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

  it('contains sender failures and logs no upstream detail', async () => {
    const sender = fakeSender();
    sender.send.mockRejectedValueOnce(new Error('sensitive Expo response'));
    const logger = fakeLogger();
    const firePoints = createPushFirePoints({
      router: routerFor(sender),
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

  describe('recipient and alert', () => {
    function permission(id: string, seq: number): SequencedEvent {
      return event({ t: 'permission', id, tool: 'Bash', input: {}, riskClass: 'ask' }, seq);
    }

    it('addresses a turn to the user who started it, not to whoever steered it', async () => {
      const router = routerFor(fakeSender());
      const firePoints = createPushFirePoints({ router, debounceMs: 10 });
      firePoints.observe(
        'session-1',
        event({ t: 'prompt', text: 'go', initiatedBy: { userId: 'user-a' } }),
      );
      // A steering message from someone else stays part of A's turn.
      firePoints.observe(
        'session-1',
        event({ t: 'prompt', text: 'also', steered: true, initiatedBy: { userId: 'user-b' } }, 2),
      );
      firePoints.observe('session-1', permission('p1', 3));
      await vi.advanceTimersByTimeAsync(10);

      expect(router.notify).toHaveBeenCalledWith(
        expect.objectContaining({
          key: 'permission:session-1:p1',
          initiatorUserId: 'user-a',
          alert: expect.objectContaining({ kind: 'permission', toolUseId: 'p1' }),
        }),
      );
      expect(await firePoints.initiatorOf('session-1')).toBe('user-a');
      await firePoints.close();
    });

    it('keeps the last initiator for a prompt without one', async () => {
      const router = routerFor(fakeSender());
      const firePoints = createPushFirePoints({ router, debounceMs: 10 });
      firePoints.observe(
        'session-1',
        event({ t: 'prompt', text: 'go', initiatedBy: { userId: 'user-a' } }),
      );
      // A server-authored follow-up (no user behind it) continues A's work.
      firePoints.observe('session-1', event({ t: 'prompt', text: 'follow-up' }, 2));
      firePoints.observe('session-1', event(resultEvent(), 3));
      await vi.advanceTimersByTimeAsync(10);

      expect(router.notify).toHaveBeenCalledWith(
        expect.objectContaining({ initiatorUserId: 'user-a' }),
      );
      await firePoints.close();
    });

    it('turns a turn that ends on fixed choices into a question with their labels', async () => {
      const router = routerFor(fakeSender());
      const firePoints = createPushFirePoints({ router, debounceMs: 10 });
      firePoints.observe('session-1', event({ t: 'prompt', text: 'go' }));
      firePoints.observe('session-1', textEvent('Ready to ship.', 2));
      firePoints.observe(
        'session-1',
        event(
          { t: 'choices', options: [{ label: 'Push + PR', recommended: true }, { label: 'Wait' }] },
          3,
        ),
      );
      firePoints.observe('session-1', event(resultEvent(), 4));
      await vi.advanceTimersByTimeAsync(10);

      const input = router.notify.mock.calls[0]?.[0];
      expect(input?.notification.categoryId).toBe('AGENT_QUESTION');
      expect(input?.alert?.choices).toEqual(['Push + PR', 'Wait']);
      // The labels are agent text: they ride the live socket, never the push.
      expect(JSON.stringify(input?.notification)).not.toContain('Push + PR');
      await firePoints.close();
    });

    it('offers no buttons for choices that do not fit on a notification', async () => {
      const router = routerFor(fakeSender());
      const firePoints = createPushFirePoints({ router, debounceMs: 10 });
      firePoints.observe('session-1', event({ t: 'prompt', text: 'go' }));
      firePoints.observe(
        'session-1',
        event(
          {
            t: 'choices',
            options: ['a', 'b', 'c', 'd', 'e'].map((label) => ({ label })),
          },
          2,
        ),
      );
      firePoints.observe('session-1', event(resultEvent(), 3));
      await vi.advanceTimersByTimeAsync(10);

      const input = router.notify.mock.calls[0]?.[0];
      expect(input?.notification.categoryId).toBe('AGENT_QUESTION');
      expect(input?.alert).toBeDefined();
      expect(input?.alert?.choices).toBeUndefined();
      await firePoints.close();
    });

    it('withdraws the escalation of a permission once it is answered', async () => {
      const router = routerFor(fakeSender());
      const firePoints = createPushFirePoints({ router, debounceMs: 10 });
      firePoints.observe('session-1', permission('p1', 1));
      await vi.advanceTimersByTimeAsync(10);
      firePoints.permissionResolved('session-1', 'p1');

      expect(router.cancel).toHaveBeenCalledWith('permission:session-1:p1');
      await firePoints.close();
    });

    it('withdraws an open question when the next prompt arrives', async () => {
      const router = routerFor(fakeSender());
      const firePoints = createPushFirePoints({ router, debounceMs: 10 });
      firePoints.observe('session-1', event({ t: 'prompt', text: 'answer' }));

      expect(router.cancel).toHaveBeenCalledWith('question:session-1');
      await firePoints.close();
    });

    it('sends informational notifications without an in-app alert', async () => {
      const router = routerFor(fakeSender());
      const firePoints = createPushFirePoints({ router, debounceMs: 10 });
      firePoints.observe('session-1', event(resultEvent()));
      await vi.advanceTimersByTimeAsync(10);

      expect(router.notify).toHaveBeenCalledWith(
        expect.objectContaining({
          notification: expect.objectContaining({ categoryId: 'SESSION_STATUS' }),
        }),
      );
      expect(router.notify.mock.calls[0]?.[0].alert).toBeUndefined();
      await firePoints.close();
    });
  });
});

it('recovers the last identified turn owner while preserving anonymous follow-ups and steering', () => {
  expect(
    persistedTurnInitiator([
      { t: 'prompt', text: 'first', initiatedBy: { userId: 'alice' } },
      { t: 'prompt', text: 'second', initiatedBy: { userId: 'bob' } },
      { t: 'prompt', text: 'steering', steered: true, initiatedBy: { userId: 'alice' } },
      { t: 'prompt', text: 'follow-up' },
    ]),
  ).toBe('bob');
});

it('recovers ownership for permission alerts following an anonymous post-restart prompt', async () => {
  vi.useFakeTimers();
  const router = routerFor(fakeSender());
  const firePoints = createPushFirePoints({
    router,
    debounceMs: 10,
    getEvents: async () => [
      { t: 'prompt', text: 'original', initiatedBy: { userId: 'alice' } },
      { t: 'prompt', text: 'follow-up' },
    ],
  });
  try {
    firePoints.observe('s1', event({ t: 'prompt', text: 'follow-up' }));
    firePoints.observe(
      's1',
      event({ t: 'permission', id: 'p1', tool: 'Bash', input: {}, riskClass: 'ask' }, 2),
    );
    await vi.advanceTimersByTimeAsync(10);
    expect(router.notify).toHaveBeenCalledWith(
      expect.objectContaining({ initiatorUserId: 'alice' }),
    );
  } finally {
    await firePoints.close();
    vi.useRealTimers();
  }
});

it('does not route a permission resolved while ownership recovery is pending', async () => {
  vi.useFakeTimers();
  let resolve!: (events: AgentEvent[]) => void;
  const router = routerFor(fakeSender());
  const firePoints = createPushFirePoints({
    router,
    debounceMs: 10,
    getEvents: () =>
      new Promise((done) => {
        resolve = done;
      }),
  });
  try {
    firePoints.observe(
      's1',
      event({ t: 'permission', id: 'p1', tool: 'Bash', input: {}, riskClass: 'ask' }),
    );
    await vi.advanceTimersByTimeAsync(10);
    firePoints.permissionResolved('s1', 'p1');
    resolve([{ t: 'prompt', text: 'original', initiatedBy: { userId: 'alice' } }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(router.notify).not.toHaveBeenCalled();
  } finally {
    await firePoints.close();
    vi.useRealTimers();
  }
});
