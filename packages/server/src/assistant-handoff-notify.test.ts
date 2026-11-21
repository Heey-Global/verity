import { InMemoryEventBus } from '@verity/session';
import { createTestDb, truncateAll, type TestDb } from '@verity/store/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ASSISTANT_HANDOFF_PUSH_MAX,
  announceAssistantHandoffResult,
  assistantHandoffPushBody,
  installAssistantHandoffNotices,
  type AssistantHandoffNoticeDeps,
} from './assistant-handoff-notify.js';
import { SESSION_HANDOFF_TRANSCRIPT_LABEL } from './session-handoff-tool.js';

let ctx: TestDb;
beforeAll(async () => {
  ctx = await createTestDb();
});
afterAll(async () => {
  await ctx.close();
});

const ADMIN = '00000000-0000-4000-8000-000000000001';
const MEMBER = 'u-member';
const LONG_SUMMARY =
  'Documents are excluded from the backup since the last release. The exclusion is in backup.yml, and a restore test ran without documents. Nothing else changed in the schedule.';

function deps(readable = true) {
  const notify = vi.fn<NonNullable<AssistantHandoffNoticeDeps['pushRouter']>['notify']>(
    async () => ({ delivered: 1 }) as never,
  );
  const value: AssistantHandoffNoticeDeps = {
    eventStore: ctx.store,
    bus: new InMemoryEventBus(),
    pushRouter: { notify },
    permitted: async (_user, projectId) => readable && projectId === 'a',
    log: { warn: vi.fn() },
  };
  return { deps: value, notify };
}

/** The briefing's line in the target transcript, as the handoff tool writes it. */
const briefingPrompt = (title = 'Backup check') => ({
  t: 'prompt' as const,
  text: `${SESSION_HANDOFF_TRANSCRIPT_LABEL} Publish a short outcome.\n\nTitle: ${title}\n\nAre documents excluded from the backup?`,
});

async function handOff(userId: string | null = MEMBER, title = 'Backup check') {
  await ctx.store.assistant.recordHandoff({
    targetSessionId: 't1',
    assistantSessionId: 'assistant',
    projectId: 'a',
    userId: userId ?? undefined,
    title,
    handedOffAt: new Date(),
  });
  await ctx.store.appendEvent('t1', briefingPrompt(title));
}

const publish = (summary = LONG_SUMMARY, outcomeDelivered = true) =>
  ctx.store.appendEvent('t1', { t: 'session_progress', summary, outcomeDelivered });

const notices = async () =>
  (await ctx.store.getEvents('assistant')).flatMap((event) =>
    event.t === 'notice' ? [event.text] : [],
  );

beforeEach(async () => {
  await truncateAll(ctx.db);
  await ctx.store.upsertProject({
    id: 'a',
    owner: 'heey-global',
    repo: 'deep-ocr',
    containerName: 'a',
    state: 'active',
  });
  await ctx.store.assistant.configure(true, ADMIN);
  await ctx.store.assistant.session('assistant');
  await ctx.store.assistant.setGrant('a', ADMIN, 'delegate');
  await ctx.store.createSession({ sessionId: 'assistant', worktree: '/assistant', model: 'm' });
  await ctx.store.createSession({ sessionId: 't1', worktree: '/t1', model: 'm', projectId: 'a' });
});

describe('assistant handoff result notices', () => {
  it('pushes the shortened summary once per publication and records it for the card', async () => {
    const { deps: d, notify } = deps();
    await handOff();
    await publish();
    expect(await announceAssistantHandoffResult(d, 't1')).toBe(true);
    // The same publication seen again (a retry, a second observer) announces nothing.
    expect(await announceAssistantHandoffResult(d, 't1')).toBe(false);
    expect(notify).toHaveBeenCalledTimes(1);
    const { notification, sessionId, initiatorUserId } = notify.mock.calls[0]![0];
    expect(sessionId).toBe('assistant');
    // The push goes to the user the work was delegated for.
    expect(initiatorUserId).toBe(MEMBER);
    expect(notification.title).toBe('heey-global/deep-ocr · Backup check');
    expect(notification.body.startsWith('Done: Documents are excluded')).toBe(true);
    expect(notification.body).toHaveLength(ASSISTANT_HANDOFF_PUSH_MAX);
    // The assistant's own transcript names the handoff, never the session's words.
    const [notice] = await notices();
    expect(notice).toContain('Backup check');
    expect(notice).not.toContain('Documents');
    expect(await ctx.store.assistant.recordedResults('assistant', ['t1'])).toEqual([
      expect.objectContaining({ delivered: true, summary: LONG_SUMMARY }),
    ]);
    // A replacing publication is one more announcement; a required decision stands in for a
    // blocker the session did not name.
    await ctx.store.appendEvent('t1', {
      t: 'session_progress',
      summary: 'Exclusion reverted; waiting for your decision.',
      outcomeDelivered: false,
      requiredDecision: 'Needs your approval.',
    });
    expect(await announceAssistantHandoffResult(d, 't1')).toBe(true);
    expect(notify.mock.calls[1]![0].notification.body).toBe(
      'Open: Exclusion reverted; waiting for your decision.',
    );
    expect(await ctx.store.assistant.recordedResults('assistant', ['t1'])).toEqual([
      expect.objectContaining({ delivered: false, blocker: 'Needs your approval.' }),
    ]);
  });

  it('stays silent for unrelated publications, a disabled assistant or withdrawn access', async () => {
    const { deps: d, notify } = deps();
    // No handoff at all.
    await publish();
    expect(await announceAssistantHandoffResult(d, 't1')).toBe(false);
    // Recorded, but the briefing has not started: what the session publishes answers another.
    await ctx.store.assistant.recordHandoff({
      targetSessionId: 't1',
      assistantSessionId: 'assistant',
      projectId: 'a',
      userId: MEMBER,
      title: 'Backup check',
      handedOffAt: new Date(),
    });
    await publish();
    expect(await announceAssistantHandoffResult(d, 't1')).toBe(false);

    await ctx.store.appendEvent('t1', briefingPrompt());
    await publish();
    expect(await announceAssistantHandoffResult(deps(false).deps, 't1')).toBe(false);
    await ctx.store.assistant.setGrant('a', ADMIN, 'off');
    expect(await announceAssistantHandoffResult(d, 't1')).toBe(false);
    await ctx.store.assistant.setGrant('a', ADMIN, 'delegate');
    await ctx.store.assistant.configure(false, ADMIN);
    expect(await announceAssistantHandoffResult(d, 't1')).toBe(false);
    expect(notify).not.toHaveBeenCalled();
    expect(await notices()).toEqual([]);
  });

  it('ignores a handoff recorded for an earlier assistant session', async () => {
    const { deps: d, notify } = deps();
    await ctx.store.createSession({ sessionId: 'old', worktree: '/old', model: 'm' });
    await ctx.store.assistant.recordHandoff({
      targetSessionId: 't1',
      assistantSessionId: 'old',
      projectId: 'a',
      userId: MEMBER,
      title: 'Backup check',
      handedOffAt: new Date(),
    });
    await ctx.store.appendEvent('t1', briefingPrompt());
    await publish();
    expect(await announceAssistantHandoffResult(d, 't1')).toBe(false);
    expect(notify).not.toHaveBeenCalled();
  });

  it('announces when a published progress event reaches the bus, without starting a turn', async () => {
    const { deps: d, notify } = deps();
    const stop = installAssistantHandoffNotices(d);
    try {
      await handOff();
      const { seq, ts } = await publish();
      d.bus.publish('t1', {
        seq,
        ts,
        event: { t: 'session_progress', summary: LONG_SUMMARY, outcomeDelivered: true },
      });
      await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
      const types = (await ctx.store.getEvents('assistant')).map((event) => event.t);
      expect(types).toEqual(['notice']);
    } finally {
      stop();
    }
  });

  it('pushes to the user who switched the assistant on when no user was recorded', async () => {
    const { deps: d, notify } = deps();
    await handOff(null);
    await publish();
    expect(await announceAssistantHandoffResult(d, 't1')).toBe(true);
    expect(notify.mock.calls[0]![0].initiatorUserId).toBe(ADMIN);
  });

  it('still pushes when the notice cannot be written', async () => {
    const { deps: d, notify } = deps();
    const warn = vi.fn();
    await handOff();
    await publish();
    const store = Object.create(ctx.store) as typeof ctx.store;
    store.appendEvent = async (sessionId, event) => {
      if (sessionId === 'assistant') throw new Error('store unavailable');
      return ctx.store.appendEvent(sessionId, event);
    };
    expect(
      await announceAssistantHandoffResult({ ...d, eventStore: store, log: { warn } }, 't1'),
    ).toBe(true);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalled();
  });

  it('cuts the push text to the limit and keeps a short one whole', () => {
    expect(assistantHandoffPushBody(false, 'Needs your approval.')).toBe(
      'Open: Needs your approval.',
    );
    const long = assistantHandoffPushBody(true, 'word '.repeat(80));
    expect(long).toHaveLength(ASSISTANT_HANDOFF_PUSH_MAX);
    expect(long.endsWith('…')).toBe(true);
  });
});
