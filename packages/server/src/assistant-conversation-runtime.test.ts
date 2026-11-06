import type { AgentEvent } from '@verity/events';
import { describe, expect, it, vi } from 'vitest';

import {
  ASSISTANT_MODEL,
  PREVIOUS_ASSISTANT_MODEL,
  moveAssistantToFastModel,
  watchAssistantTiming,
  type AssistantModelMoveDeps,
} from './assistant-conversation-runtime.js';

function moveDeps(model: string, overrides: Partial<AssistantModelMoveDeps> = {}) {
  let current = model;
  const store = {
    getSession: vi.fn(async () => ({ model: current })),
    getSessionBackendStates: vi.fn(async () => [{ backendSessionId: 'old-thread' }]),
    setSessionModel: vi.fn(async (_id: string, next: string) => {
      current = next;
      return true;
    }),
    deleteSessionBackendStates: vi.fn(async () => undefined),
  };
  const deps = {
    store: store as unknown as AssistantModelMoveDeps['store'],
    isBusy: () => false,
    available: async () => true,
    runBackendHandoff: (_id: string, handoff: () => Promise<boolean>) => handoff(),
    closeSession: vi.fn(),
    log: { info: vi.fn(), warn: vi.fn() },
    ...overrides,
  };
  return { deps, store, model: () => current };
}

describe('assistant model move', () => {
  it('moves an idle session from the former default to Sonnet and drops its resume handles', async () => {
    const { deps, store, model } = moveDeps(PREVIOUS_ASSISTANT_MODEL);
    await moveAssistantToFastModel(deps, 'assistant');
    expect(model()).toBe(ASSISTANT_MODEL);
    expect(store.deleteSessionBackendStates).toHaveBeenCalledWith('assistant');
    expect(deps.closeSession).toHaveBeenCalledWith('old-thread');
  });

  it('leaves the model alone while busy, when Sonnet is not offered, or on another model', async () => {
    for (const [model, overrides] of [
      [PREVIOUS_ASSISTANT_MODEL, { isBusy: () => true }],
      [PREVIOUS_ASSISTANT_MODEL, { available: async () => false }],
      ['codex/default', {}],
    ] as const) {
      const moved = moveDeps(model, overrides);
      await moveAssistantToFastModel(moved.deps, 'assistant');
      expect(moved.model()).toBe(model);
    }
  });

  it('restores the model and keeps the request going when the handles cannot be dropped', async () => {
    const { deps, store, model } = moveDeps(PREVIOUS_ASSISTANT_MODEL);
    store.deleteSessionBackendStates.mockRejectedValueOnce(new Error('db'));
    await expect(moveAssistantToFastModel(deps, 'assistant')).resolves.toBeUndefined();
    expect(model()).toBe(PREVIOUS_ASSISTANT_MODEL);
    expect(deps.log.warn).toHaveBeenCalled();
  });
});

describe('assistant message timing', () => {
  it('logs the first reaction and the end of the turn the message started', () => {
    vi.useFakeTimers();
    try {
      let publish: (event: AgentEvent) => void = () => undefined;
      const log = { info: vi.fn(), warn: vi.fn() };
      watchAssistantTiming(
        (_id, listener) => {
          publish = (event) => listener({ seq: 1, ts: 0, event });
          return () => undefined;
        },
        log,
        { sessionId: 'assistant', requestId: 'req-1', prompt: 'What is open?' },
      );
      // An earlier turn still finishing is not this message's.
      publish({ t: 'text', delta: 'earlier' });
      vi.advanceTimersByTime(300);
      publish({ t: 'prompt', text: 'What is open?' });
      vi.advanceTimersByTime(900);
      publish({ t: 'tool_call', id: 'c', name: 'verity_tasks', input: {} });
      vi.advanceTimersByTime(1_800);
      publish({
        t: 'result',
        stopReason: 'end_turn',
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
      });
      expect(log.info).toHaveBeenCalledWith(
        {
          sessionId: 'assistant',
          requestId: 'req-1',
          outcome: 'result',
          firstMs: 1_200,
          doneMs: 3_000,
        },
        'verity: assistant message timing',
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
