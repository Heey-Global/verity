import { describe, expect, it, vi } from 'vitest';
import { InMemoryEventBus } from '@verity/session';
import type { SequencedEvent, SessionRecord } from '@verity/store';
import { subscribeAgentProcessLogging } from './agent-process-logging.js';

const session: SessionRecord = {
  sessionId: 'session',
  projectId: 'project',
  model: 'codex/model',
  worktree: '/project',
  name: null,
  lastSeenEventCount: null,
};

function failure(overrides: Record<string, unknown> = {}): SequencedEvent {
  return {
    seq: 1,
    ts: 1,
    event: {
      t: 'diagnostic',
      source: 'agent',
      outcome: 'failed',
      phase: 'prompt',
      backend: 'codex-acp',
      model: 'codex/model',
      exitCode: 1,
      signal: null,
      turnActive: true,
      stderrTail: 'fatal error',
      ...overrides,
    },
  };
}

describe('agent process logging', () => {
  it.each([
    { exitCode: 1, signal: null },
    { exitCode: null, signal: 'SIGKILL' },
  ])('logs persisted failures with project context and redacted stderr: %j', async (exit) => {
    const bus = new InMemoryEventBus();
    const warn = vi.fn();
    const stop = subscribeAgentProcessLogging(
      bus,
      { getSession: vi.fn().mockResolvedValue(session) },
      { warn },
    );
    bus.publish(
      'session',
      failure({
        ...exit,
        stderrTail: 'fatal\nCUSTOM_ENV=private-value\nsk-proj-abcdefghijklmnopqrstuvwxyz',
      }),
    );
    await Promise.resolve();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session',
        projectId: 'project',
        backend: 'codex-acp',
        model: 'codex/model',
        turnActive: true,
        ...exit,
      }),
      'agent process exited unexpectedly',
    );
    const fields = warn.mock.calls[0]?.[0] as { stderrTail: string };
    expect(fields.stderrTail).toContain('fatal');
    expect(fields.stderrTail).not.toContain('private-value');
    expect(fields.stderrTail).not.toContain('abcdefghijklmnopqrstuvwxyz');
    stop();
  });

  it('ignores clean and intentional exits and unrelated failures', async () => {
    const bus = new InMemoryEventBus();
    const warn = vi.fn();
    const getSession = vi.fn().mockResolvedValue(session);
    const stop = subscribeAgentProcessLogging(bus, { getSession }, { warn });
    bus.publish('session', failure({ outcome: 'completed', exitCode: 0 }));
    bus.publish('session', failure({ outcome: 'cancelled', signal: 'SIGTERM' }));
    bus.publish('session', failure({ exitCode: undefined }));
    bus.publish('session', failure({ source: 'tool' }));
    await Promise.resolve();
    expect(getSession).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    stop();
  });

  it('unsubscribes and suppresses pending logs after server close', async () => {
    const bus = new InMemoryEventBus();
    const warn = vi.fn();
    const getSession = vi.fn().mockResolvedValue(session);
    const stop = subscribeAgentProcessLogging(bus, { getSession }, { warn });
    bus.publish('session', failure());
    stop();
    bus.publish('session', failure());
    await Promise.resolve();
    expect(getSession).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });
});
