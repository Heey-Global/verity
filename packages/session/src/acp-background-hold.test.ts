import { createIsolatedTestDb, truncateAll, type TestDb } from '@verity/store/testing';
import type { AgentEvent } from '@verity/events';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AcpClaudeBackend,
  BACKGROUND_HOLD_DIRECTIVE,
  CLAUDE_SCHEDULING_TOOLS,
} from './acp-claude-backend.js';
import { AcpCodexBackend } from './acp-codex-backend.js';
import type { RunTurnOptions, SpawnedProcess, Spawner } from './backend-contract.js';
import { BACKGROUND_HOLD_TASK_ID } from './background-work.js';

let ctx: TestDb;
beforeAll(async () => {
  ctx = await createIsolatedTestDb();
});
afterAll(async () => {
  await ctx.close();
});
beforeEach(async () => {
  await truncateAll(ctx.db);
});

const SESSION = 'claude-session-1';

function lifecycle(value: Record<string, unknown>): Record<string, unknown> {
  return {
    sessionUpdate: 'session_info_update',
    _meta: { verity: { lifecycle: value } },
  };
}

function chunk(text: string): Record<string, unknown> {
  return { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } };
}

/**
 * An ACP agent the test scripts frame by frame. The first `session/prompt` runs
 * `onPrompt`, which decides what the agent streams and when it answers — the
 * shape of a Claude turn that starts background work and ends its own prompt
 * before that work reports back.
 */
function scriptedAgent(onPrompt: (agent: ScriptedAgent, id: unknown, index: number) => void): {
  spawner: Spawner;
  agent: ScriptedAgent;
} {
  const queue: string[] = [];
  const waiters: Array<(value: IteratorResult<string>) => void> = [];
  let closed = false;
  let resolveExit: (code: number) => void = () => undefined;
  const exited = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });
  const push = (message: unknown): void => {
    const value = `${JSON.stringify(message)}\n`;
    const waiter = waiters.shift();
    if (waiter === undefined) queue.push(value);
    else waiter({ value, done: false });
  };
  const close = (): void => {
    if (closed) return;
    closed = true;
    for (const waiter of waiters.splice(0)) waiter({ value: undefined, done: true });
    resolveExit(0);
  };
  let prompts = 0;
  const agent: ScriptedAgent = {
    writes: [],
    kill: vi.fn<(signal?: NodeJS.Signals) => void>(() => close()),
    emit(update) {
      push({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: SESSION, update } });
    },
    answer(id, stopReason = 'end_turn') {
      push({ jsonrpc: '2.0', id, result: { stopReason } });
    },
    fail(id) {
      push({ jsonrpc: '2.0', id, error: { code: -32603, message: 'Internal error' } });
    },
    crash: close,
    get closed() {
      return closed;
    },
  };
  const stdout: AsyncIterable<string> = {
    [Symbol.asyncIterator]() {
      return {
        next: async (): Promise<IteratorResult<string>> => {
          const value = queue.shift();
          if (value !== undefined) return { value, done: false };
          if (closed) return { value: undefined, done: true };
          return await new Promise((resolve) => waiters.push(resolve));
        },
      };
    },
  };
  const spawner: Spawner = (): SpawnedProcess => ({
    stdout,
    pid: 321,
    exited,
    stderr: () => '',
    kill: agent.kill,
    closeStdin: close,
    writeStdin(data) {
      for (const line of data.split('\n').filter(Boolean)) {
        const message = JSON.parse(line) as Record<string, unknown>;
        agent.writes.push(message);
        const id = message['id'];
        switch (message['method']) {
          case 'initialize':
            push({
              jsonrpc: '2.0',
              id,
              result: { protocolVersion: 1, agentCapabilities: { loadSession: true } },
            });
            break;
          case 'session/new':
            push({ jsonrpc: '2.0', id, result: { sessionId: SESSION } });
            break;
          case 'session/prompt':
            onPrompt(agent, id, prompts++);
            break;
          case 'session/cancel':
            break;
          default:
            if (id !== undefined) push({ jsonrpc: '2.0', id, result: {} });
        }
      }
      return !closed;
    },
  });
  return { spawner, agent };
}

interface ScriptedAgent {
  writes: Record<string, unknown>[];
  kill: ReturnType<typeof vi.fn<(signal?: NodeJS.Signals) => void>>;
  emit(update: Record<string, unknown>): void;
  answer(id: unknown, stopReason?: string): void;
  fail(id: unknown): void;
  crash(): void;
  readonly closed: boolean;
}

function turn(
  spawner: Spawner,
  storeSessionId: string,
  extra: Partial<RunTurnOptions> = {},
): RunTurnOptions {
  return {
    store: ctx.store,
    storeSessionId,
    worktree: '/work/project',
    cwd: '/work/project',
    prompt: 'Review and push',
    spawner,
    backgroundQuietMs: 20,
    ...extra,
  };
}

async function events(sessionId: string): Promise<AgentEvent[]> {
  return await ctx.store.getEvents(sessionId);
}

function terminal(list: readonly AgentEvent[]): AgentEvent[] {
  return list.filter((event) => event.t === 'result' || event.t === 'status');
}

describe('ACP turns held open for background work', () => {
  // The failure this guards: the agent starts a background review or a Monitor,
  // says "I'll wait for it", and its prompt answers. Ending the turn there kills
  // the agent process with the work inside it, and the follow-up the agent would
  // start when the work reports back never happens.
  it('keeps the turn and the agent alive until the background work and its follow-up end', async () => {
    let first: unknown;
    const { spawner, agent } = scriptedAgent((a, id) => {
      first = id;
      a.emit(chunk('Started the review in the background; I will wait for it.'));
      a.emit(lifecycle({ type: 'task', id: 'review', phase: 'started' }));
      a.answer(id);
    });
    const run = new AcpClaudeBackend().run(turn(spawner, 'held-follow-up'));
    await vi.waitFor(async () => {
      const list = await events('held-follow-up');
      expect(list.some((event) => event.t === 'text')).toBe(true);
    });
    expect(first).toBeDefined();
    // Held: the answer so far is published, but the turn has not settled.
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(terminal(await events('held-follow-up'))).toEqual([{ t: 'status', state: 'running' }]);
    expect(agent.kill).not.toHaveBeenCalled();

    agent.emit(lifecycle({ type: 'task', id: 'review', phase: 'ended', status: 'completed' }));
    agent.emit(lifecycle({ type: 'cycle', phase: 'started' }));
    agent.emit(chunk('The review passed; pushing now.'));
    agent.emit(lifecycle({ type: 'cycle', phase: 'ended' }));

    expect(await run).toMatchObject({ exitCode: 0, aborted: false });
    const list = await events('held-follow-up');
    const text = list.flatMap((event) => (event.t === 'text' ? [event.delta] : [])).join('');
    expect(text).toContain('I will wait for it.');
    expect(text).toContain('The review passed; pushing now.');
    // The follow-up lands BEFORE the turn's closing rows, inside the same turn.
    const followUp = list.findIndex(
      (event) => event.t === 'text' && event.delta.includes('pushing now'),
    );
    const result = list.findIndex((event) => event.t === 'result');
    expect(followUp).toBeGreaterThan(-1);
    expect(result).toBeGreaterThan(followUp);
    expect(list.at(-2)).toMatchObject({ t: 'status', state: 'completed' });
    expect(agent.kill).toHaveBeenCalled();
    // The hold is durable in the transcript: the Conductor reads this marker to
    // tell a held, legitimately silent turn from a stalled one.
    const hold = list.filter((event) => event.t === 'task' && event.id === BACKGROUND_HOLD_TASK_ID);
    expect(hold).toEqual([
      expect.objectContaining({ phase: 'started' }),
      expect.objectContaining({ phase: 'ended', status: 'completed' }),
    ]);
    expect(list.findIndex((event) => event === hold[1])).toBeLessThan(result);
  });

  // The task finished while the prompt still ran; the cycle reacting to it only
  // starts after the prompt answered. Deciding at the first idle instant killed it.
  it('holds for a cycle that starts just after the prompt answered', async () => {
    const { spawner, agent } = scriptedAgent((a, id) => {
      a.emit(lifecycle({ type: 'task', id: 'tests', phase: 'started' }));
      a.emit(lifecycle({ type: 'task', id: 'tests', phase: 'ended' }));
      a.answer(id);
      setTimeout(() => {
        a.emit(lifecycle({ type: 'cycle', phase: 'started' }));
        a.emit(chunk('Tests passed; continuing.'));
        a.emit(lifecycle({ type: 'cycle', phase: 'ended' }));
      }, 100);
    });
    await new AcpClaudeBackend().run(turn(spawner, 'held-late-cycle', { backgroundQuietMs: 200 }));
    const list = await events('held-late-cycle');
    const followUp = list.findIndex(
      (event) => event.t === 'text' && event.delta.includes('Tests passed'),
    );
    expect(followUp).toBeGreaterThan(-1);
    expect(list.findIndex((event) => event.t === 'result')).toBeGreaterThan(followUp);
    expect(agent.kill).toHaveBeenCalled();
  });

  it('ends a turn without background work at its prompt response, as before', async () => {
    const { spawner, agent } = scriptedAgent((a, id) => {
      a.emit(chunk('Done.'));
      a.answer(id);
    });
    const started = Date.now();
    await new AcpClaudeBackend().run(turn(spawner, 'held-none', { backgroundQuietMs: 10_000 }));
    // No quiet window either: nothing was ever running in the background.
    expect(Date.now() - started).toBeLessThan(5_000);
    expect((await events('held-none')).filter((event) => event.t === 'task')).toEqual([]);
    expect(terminal(await events('held-none')).at(-1)).toEqual({
      t: 'status',
      state: 'completed',
    });
    expect(agent.kill).toHaveBeenCalled();
  });

  it('drops a task whose end was lost once the live background level omits it', async () => {
    const { spawner } = scriptedAgent((a, id) => {
      a.emit(lifecycle({ type: 'task', id: 'lost-end', phase: 'started' }));
      a.answer(id);
      a.emit(lifecycle({ type: 'background', live: [] }));
    });
    await new AcpClaudeBackend().run(turn(spawner, 'held-level'));
    expect(terminal(await events('held-level')).at(-1)).toEqual({
      t: 'status',
      state: 'completed',
    });
  });

  it('ends background work at the hold limit with a visible notice, not a crash', async () => {
    const { spawner, agent } = scriptedAgent((a, id) => {
      a.emit(lifecycle({ type: 'task', id: 'monitor', phase: 'started' }));
      a.answer(id);
    });
    await new AcpClaudeBackend().run(turn(spawner, 'held-limit', { backgroundHoldMaxMs: 150 }));
    const list = await events('held-limit');
    expect(list).toContainEqual({
      t: 'notice',
      text: 'Background work was still running after 1 s; Verity ended it with this turn.',
    });
    expect(terminal(list).at(-1)).toEqual({ t: 'status', state: 'completed' });
    expect(agent.writes.some((write) => write['method'] === 'session/cancel')).toBe(true);
    expect(agent.kill).toHaveBeenCalled();
  });

  it('stops a held turn and its background work on Stop', async () => {
    const controller = new AbortController();
    const { spawner, agent } = scriptedAgent((a, id) => {
      a.emit(chunk('Waiting for the monitor.'));
      a.emit(lifecycle({ type: 'task', id: 'monitor', phase: 'started' }));
      a.answer(id);
    });
    const run = new AcpClaudeBackend().run(
      turn(spawner, 'held-stop', { signal: controller.signal }),
    );
    await vi.waitFor(async () => {
      expect((await events('held-stop')).some((event) => event.t === 'text')).toBe(true);
    });
    controller.abort();
    expect(agent.kill).toHaveBeenCalledWith('SIGKILL');
    expect(await run).toMatchObject({ aborted: true });
    const list = await events('held-stop');
    expect(list.filter((event) => event.t === 'status' && event.state !== 'running')).toEqual([]);
    expect(list.filter((event) => event.t === 'error')).toEqual([]);
    expect(
      list.filter((event) => event.t === 'task' && event.id === BACKGROUND_HOLD_TASK_ID),
    ).toEqual([
      expect.objectContaining({ phase: 'started' }),
      expect.objectContaining({ phase: 'ended', status: 'stopped' }),
    ]);
  });

  it('sends a message written during the hold to the live agent as a prompt', async () => {
    let steer: ((message: { text: string }) => boolean) | undefined;
    const { spawner, agent } = scriptedAgent((a, id, index) => {
      if (index === 0) {
        a.emit(chunk('Waiting for the tests.'));
        a.emit(lifecycle({ type: 'task', id: 'tests', phase: 'started' }));
        a.answer(id);
        return;
      }
      // The held prompt: the agent answers it and the tests finish meanwhile.
      a.emit(chunk('Noted, I will also update the changelog.'));
      a.emit(lifecycle({ type: 'task', id: 'tests', phase: 'ended' }));
      a.answer(id);
    });
    const run = new AcpClaudeBackend().run(
      turn(spawner, 'held-steer', {
        onSteer: (inject) => {
          steer = inject;
        },
      }),
    );
    await vi.waitFor(async () => {
      expect((await events('held-steer')).some((event) => event.t === 'text')).toBe(true);
    });
    await vi.waitFor(() => expect(steer?.({ text: 'Also update the changelog' })).toBe(true));
    await run;
    const prompts = agent.writes.filter((write) => write['method'] === 'session/prompt');
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toMatchObject({
      params: { sessionId: SESSION, prompt: [{ type: 'text', text: 'Also update the changelog' }] },
    });
    expect(agent.writes.filter((write) => write['method'] === '_session/steering')).toEqual([]);
    const text = (await events('held-steer'))
      .flatMap((event) => (event.t === 'text' ? [event.delta] : []))
      .join('');
    expect(text).toContain('update the changelog');
  });

  it('says so when a message sent during the hold does not reach the agent', async () => {
    let steer: ((message: { text: string }) => boolean) | undefined;
    let held: unknown;
    const { spawner, agent } = scriptedAgent((a, id, index) => {
      if (index === 0) {
        a.emit(chunk('Waiting for the build.'));
        a.emit(lifecycle({ type: 'task', id: 'build', phase: 'started' }));
        a.answer(id);
        return;
      }
      held = id;
      a.fail(id);
    });
    const run = new AcpClaudeBackend().run(
      turn(spawner, 'held-steer-fails', {
        onSteer: (inject) => {
          steer = inject;
        },
      }),
    );
    await vi.waitFor(async () => {
      expect((await events('held-steer-fails')).some((event) => event.t === 'text')).toBe(true);
    });
    await vi.waitFor(() => expect(steer?.({ text: 'Also run lint' })).toBe(true));
    await vi.waitFor(() => expect(held).toBeDefined());
    await vi.waitFor(async () => {
      expect(
        (await events('held-steer-fails')).some(
          (event) => event.t === 'notice' && event.text.includes('could not be delivered'),
        ),
      ).toBe(true);
    });
    agent.emit(lifecycle({ type: 'task', id: 'build', phase: 'ended' }));
    await run;
  });

  it('records a crash when the agent dies while the turn is held', async () => {
    const { spawner, agent } = scriptedAgent((a, id) => {
      a.emit(lifecycle({ type: 'task', id: 'review', phase: 'started' }));
      a.answer(id);
    });
    const run = new AcpClaudeBackend().run(turn(spawner, 'held-crash'));
    await vi.waitFor(() =>
      expect(agent.writes.some((write) => write['method'] === 'session/prompt')).toBe(true),
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    agent.crash();
    // Not a quiet settle: the work the turn was held for is gone with the agent.
    expect(await run).toMatchObject({ exitCode: 1 });
    const list = await events('held-crash');
    expect(list.some((event) => event.t === 'error')).toBe(true);
    expect(terminal(list).at(-1)).toEqual({ t: 'status', state: 'crashed' });
    expect(
      list.filter((event) => event.t === 'task' && event.id === BACKGROUND_HOLD_TASK_ID),
    ).toEqual([
      expect.objectContaining({ phase: 'started' }),
      expect.objectContaining({ phase: 'ended', status: 'failed' }),
    ]);
  });

  it('does not hold Codex turns, whose profile does not opt in', async () => {
    const { spawner, agent } = scriptedAgent((a, id) => {
      a.emit(lifecycle({ type: 'task', id: 'background', phase: 'started' }));
      a.answer(id);
    });
    const codexTurn = turn(spawner, 'held-codex');
    delete codexTurn.backgroundQuietMs;
    await new AcpCodexBackend().run(codexTurn);
    expect(terminal(await events('held-codex')).at(-1)).toEqual({
      t: 'status',
      state: 'completed',
    });
    expect(agent.kill).toHaveBeenCalled();
  });
});

describe('Claude scheduling tools', () => {
  // A wakeup or cron fires inside the agent process, which ends with the turn.
  // An agent allowed to schedule one promises a check that never happens.
  it('are unavailable in every Claude turn, whatever the caller disallows', async () => {
    const { spawner, agent } = scriptedAgent((a, id) => a.answer(id));
    await new AcpClaudeBackend().run(
      turn(spawner, 'scheduling-tools', { disallowedTools: ['WebFetch'] }),
    );
    const opened = agent.writes.find((write) => write['method'] === 'session/new');
    const disallowed = (
      opened?.['params'] as {
        _meta: { claudeCode: { options: { disallowedTools: string[] } } };
      }
    )._meta.claudeCode.options.disallowedTools;
    expect(disallowed).toEqual(expect.arrayContaining(['WebFetch', ...CLAUDE_SCHEDULING_TOOLS]));
    expect(CLAUDE_SCHEDULING_TOOLS).toEqual(
      expect.arrayContaining(['ScheduleWakeup', 'CronCreate']),
    );
  });

  it('tells ordinary Claude turns about the hold, but not turns that cannot start work', async () => {
    const appended = async (extra: Partial<RunTurnOptions>): Promise<string | undefined> => {
      const { spawner, agent } = scriptedAgent((a, id) => a.answer(id));
      await new AcpClaudeBackend().run(
        turn(spawner, `directive-${Object.keys(extra).join('-')}`, extra),
      );
      const opened = agent.writes.find((write) => write['method'] === 'session/new');
      return (opened?.['params'] as { _meta: { systemPrompt?: { append: string } } })._meta
        .systemPrompt?.append;
    };
    expect(await appended({ appendSystemPrompt: 'Base' })).toBe(
      `Base\n\n${BACKGROUND_HOLD_DIRECTIVE}`,
    );
    expect(BACKGROUND_HOLD_DIRECTIVE).toContain('at most 2 hours');
    expect(await appended({ toolless: true })).toBeUndefined();
  });
});
