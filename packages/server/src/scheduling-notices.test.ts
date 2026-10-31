import type { EventStore } from '@verity/store';
import { describe, expect, it } from 'vitest';
import { assistantNoticeTarget } from './scheduling-notices.js';

function store(
  overrides: {
    enabled?: boolean;
    sessionId?: string | null;
    mode?: 'off' | 'tasks' | 'delegate';
    ungranted?: boolean;
    hidden?: boolean;
    archived?: boolean;
  } = {},
) {
  const { enabled = true, sessionId = 'assistant', mode = 'tasks' } = overrides;
  return {
    assistant: {
      settings: async () => ({ enabled, session_id: sessionId }),
      grant: async () => (overrides.ungranted ? undefined : { project_id: 'p1', mode }),
    },
    getProject: async () => ({
      owner: 'team',
      repo: 'shop',
      hiddenAt: overrides.hidden ? new Date() : null,
      archived: overrides.archived ?? false,
    }),
  } as unknown as Pick<EventStore, 'assistant' | 'getProject'>;
}

const request = { sessionId: 'project-session', projectId: 'p1' };

describe('assistant scheduling notices', () => {
  it('copies a notice of a granted project to the assistant, naming the project', async () => {
    expect(await assistantNoticeTarget(store(), request)).toEqual({
      sessionId: 'assistant',
      prefix: 'team/shop: ',
    });
  });

  it('copies nothing the assistant may not see or already has', async () => {
    // Each of these would put a project's scheduling news where the operator did not allow it,
    // or announce the assistant's own request twice in its session.
    expect(await assistantNoticeTarget(store({ mode: 'off' }), request)).toBeUndefined();
    expect(await assistantNoticeTarget(store({ ungranted: true }), request)).toBeUndefined();
    expect(await assistantNoticeTarget(store({ enabled: false }), request)).toBeUndefined();
    expect(await assistantNoticeTarget(store({ sessionId: null }), request)).toBeUndefined();
    expect(await assistantNoticeTarget(store({ hidden: true }), request)).toBeUndefined();
    expect(await assistantNoticeTarget(store({ archived: true }), request)).toBeUndefined();
    expect(
      await assistantNoticeTarget(store(), { sessionId: 'assistant', projectId: 'p1' }),
    ).toBeUndefined();
    expect(
      await assistantNoticeTarget(store(), { sessionId: 'project-session', projectId: null }),
    ).toBeUndefined();
  });
});
