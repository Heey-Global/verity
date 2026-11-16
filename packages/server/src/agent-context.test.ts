import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { EventStore, SessionRecord } from '@verity/store';
import { resolveAgentContext } from './agent-context.js';
import { readProjectInstructions, replaceProjectInstructions } from './project-instructions.js';

vi.mock('./agent-tool-availability.js', () => ({ connectorToolAvailable: async () => false }));

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

describe('project instructions', () => {
  it('reach every agent of the project as project-wide rules, and an edit reloads the context', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'agent-context-instructions-'));
    try {
      const store = {
        listRunningTurns: async () => [],
        userContext: { read: async () => undefined },
      } as unknown as EventStore;
      const session = { sessionId: 's', projectId: 'p' } as SessionRecord;
      const { revision } = await readProjectInstructions(dataRoot, 'p');
      await replaceProjectInstructions(dataRoot, 'p', revision, 'Reply in German.');
      const first = await resolveAgentContext(store, dataRoot, session, async () => undefined);
      const heading = first.prompt.split('\n').find((line) => line.startsWith('## Project'));
      expect(heading).toMatch(/every agent in this project/u);
      // Repository rules are added, not overridden: the heading must not tell the
      // agent that repository guidance is someone else's to ignore.
      expect(heading).toMatch(/AGENTS\.md adds rules/u);
      expect(heading).not.toMatch(/developer-owned/u);
      expect(first.prompt).toContain('Reply in German.');
      const current = await readProjectInstructions(dataRoot, 'p');
      await replaceProjectInstructions(dataRoot, 'p', current.revision, 'Reply in English.');
      const second = await resolveAgentContext(store, dataRoot, session, async () => undefined);
      expect(second.prompt).toContain('Reply in English.');
      expect(second.fingerprint).not.toBe(first.fingerprint);
    } finally {
      await rm(dataRoot, { recursive: true, force: true });
    }
  });
});
