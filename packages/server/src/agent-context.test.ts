import { describe, expect, it, vi } from 'vitest';
import type { EventStore, SessionRecord } from '@verity/store';
import { resolveAgentContext } from './agent-context.js';

describe('personal context ownership', () => {
  it('uses the running prompt initiator and removes private context when no initiator exists', async () => {
    let initiator: string | undefined = 'first';
    const read = vi.fn(async (id: string) => ({
      instructions: `Rules for ${id}`,
      memory: `Facts for ${id}`,
      revision: 1,
    }));
    const store = {
      listRunningTurns: async () => [{ sessionId: 's', promptSeq: 4 }],
      getEventsAfter: async () => [
        {
          seq: 4,
          event: { t: 'prompt', initiatedBy: initiator ? { userId: initiator } : undefined },
        },
      ],
      userContext: { read },
    } as unknown as EventStore;
    const session = { sessionId: 's', projectId: null } as SessionRecord;
    const first = await resolveAgentContext(store, '/unused', session, async () => undefined);
    expect(first.prompt).toContain('Rules for first');
    expect(first.fingerprint).toMatch(/^v2:legacy:/);
    const canonical = await resolveAgentContext(
      store,
      '/unused',
      session,
      async () => undefined,
      true,
    );
    expect(canonical.fingerprint).toMatch(/^v2:canonical:/);
    read.mockClear();
    initiator = 'second';
    const second = await resolveAgentContext(store, '/unused', session, async () => undefined);
    expect(second.prompt).toContain('Rules for second');
    expect(second.prompt).not.toContain('first');
    expect(second.fingerprint).not.toBe(first.fingerprint);
    initiator = undefined;
    const empty = await resolveAgentContext(store, '/unused', session, async () => undefined);
    expect(empty.prompt).toBe('');
    expect(empty.fingerprint).not.toBe(second.fingerprint);
    expect(read).toHaveBeenCalledTimes(1);
    const initial = await resolveAgentContext(
      store,
      '/unused',
      session,
      async () => undefined,
      false,
      { userId: 'initial' },
    );
    expect(initial.prompt).toContain('Rules for initial');
  });
});
