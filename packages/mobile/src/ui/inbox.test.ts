import { describe, expect, it } from 'vitest';

import type { ProjectRecord, SessionSummary, UpcomingMeeting } from '../api.js';
import { inboxItems, inboxSummary, inboxView, MEETING_LEAD_MS, type InboxItem } from './inbox.js';

const ZERO_USAGE = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  turns: 0,
};
const NOW = Date.parse('2026-11-03T09:46:00Z');

function session(id: string, over: Partial<SessionSummary> = {}): SessionSummary {
  return {
    sessionId: id,
    worktree: `/wt/${id}`,
    model: 'm',
    name: id,
    projectId: 'p1',
    status: 'completed',
    usage: ZERO_USAGE,
    lastActivityAt: NOW - 60_000,
    ...over,
  };
}

function project(over: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    id: 'p1',
    owner: 'acme',
    repo: 'website',
    containerName: 'c',
    kind: 'github',
    imageRef: null,
    state: 'active',
    provisionError: null,
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-11-03T09:00:00Z',
    ...over,
  };
}

function meeting(over: Partial<UpcomingMeeting> = {}): UpcomingMeeting {
  return {
    eventKey: 'cal:weekly',
    title: 'Weekly sync',
    startsAt: NOW + 14 * 60_000,
    endsAt: NOW + 74 * 60_000,
    calendar: 'Work',
    provider: 'meet',
    decision: null,
    meetingId: null,
    ...over,
  };
}

const readyPr = {
  number: 2031,
  title: 'Update uuid to v14',
  url: 'https://github.com/acme/website/pull/2031',
  phase: 'open' as const,
  pipeline: 'success' as const,
  mergeable: true,
  viewerCanMerge: true,
  checks: { completed: 3, total: 3, successful: 3, failed: 0, pending: 0 },
};

const kinds = (items: readonly InboxItem[]) => items.map((item) => item.kind);
const labels = (item: InboxItem | undefined) => item?.actions.map((action) => action.label);

describe('inboxItems', () => {
  it('is empty when nothing needs the operator', () => {
    const items = inboxItems({ sessions: [session('quiet')], projects: [project()], now: NOW });
    expect(items).toEqual([]);
    expect(inboxSummary(items)).toBe('Nothing needs you right now.');
  });

  it('offers a session’s choices as answers, plus its own answer', () => {
    const [item] = inboxItems({
      sessions: [
        session('form', {
          openChoices: {
            question: 'Which library?',
            options: [{ label: 'Zod' }, { label: 'Valibot' }],
          },
        }),
      ],
      projects: [project()],
      now: NOW,
    });
    expect(item).toMatchObject({
      kind: 'question',
      title: 'Which library?',
      context: 'acme/website · form',
    });
    expect(item?.actions).toEqual([
      { kind: 'answer', label: 'Zod', sessionId: 'form', answer: 'Zod' },
      { kind: 'answer', label: 'Valibot', sessionId: 'form', answer: 'Valibot' },
      { kind: 'open_session', label: 'Own answer', sessionId: 'form' },
    ]);
  });

  it('sends a multi-select question to the session instead of answering one option', () => {
    const [item] = inboxItems({
      sessions: [
        session('pick', {
          openChoices: { options: [{ label: 'A' }, { label: 'B' }], multiSelect: true },
        }),
      ],
      projects: [project()],
      now: NOW,
    });
    expect(labels(item)).toEqual(['Answer']);
  });

  it('keys a question by what it asks and a crash by the turn it ended', () => {
    const keyOf = (over: Parameters<typeof session>[1]) =>
      inboxItems({ sessions: [session('s', over)], projects: [project()], now: NOW })[0]?.key;
    const asked = {
      status: 'completed' as const,
      openChoices: {
        question: 'Which library?',
        options: [{ label: 'Zod' }, { label: 'Valibot' }],
      },
    };
    // Unrelated activity must not bring an answered question back…
    expect(keyOf({ ...asked, eventCount: 10, lastActivityAt: 1 })).toBe(
      keyOf({ ...asked, eventCount: 11, lastActivityAt: 2 }),
    );
    // …and a new question in a quick next turn must not inherit the answered one.
    expect(keyOf(asked)).not.toBe(
      keyOf({ ...asked, openChoices: { question: 'Which port?', options: [{ label: '3000' }] } }),
    );
    // A crash after Resume is a new item, not the one already resumed.
    expect(keyOf({ status: 'crashed', eventCount: 10 })).not.toBe(
      keyOf({ status: 'crashed', eventCount: 14 }),
    );
  });

  it('decides described permissions in place and opens the rest', () => {
    const items = inboxItems({
      sessions: [
        session('egress', {
          status: 'awaiting_input',
          permissionAwaitingInput: true,
          pendingPermissions: ['t1', 't2', 'link-1'],
          pendingPermissionRequests: [
            {
              toolUseId: 't1',
              tool: 'WebFetch',
              riskClass: 'ask',
              input: { url: 'https://api.exa.ai' },
            },
            // Too large for the summary: no input means no blind Allow.
            { toolUseId: 't2', tool: 'Write', riskClass: 'ask' },
          ],
        }),
      ],
      projects: [project()],
      now: NOW,
    });
    const permissions = items.filter((item) => item.kind === 'permission');
    expect(permissions.map(labels)).toEqual([['Allow', 'Deny', 'Open'], ['Review'], ['Review']]);
    expect(permissions[0]?.actions[0]).toMatchObject({ kind: 'allow', toolUseId: 't1' });
    // Allow travels with the complete input, never with only the tool's summary.
    expect(permissions[0]?.request).toBe(JSON.stringify({ url: 'https://api.exa.ai' }, null, 2));
    expect(permissions.slice(1).map((item) => item.request)).toEqual([undefined, undefined]);
    // An awaiting session whose question IS the permission is not also a question.
    expect(kinds(items)).not.toContain('question');
  });

  it('never offers a generic Allow for a package install', () => {
    const [item] = inboxItems({
      sessions: [
        session('deps', {
          status: 'awaiting_input',
          permissionAwaitingInput: true,
          pendingPermissions: ['t1'],
          pendingPermissionRequests: [
            { toolUseId: 't1', tool: 'verity_package_install', riskClass: 'ask', input: {} },
          ],
        }),
      ],
      projects: [project()],
      now: NOW,
    });
    expect(labels(item)).toEqual(['Review']);
  });

  it('offers Resume only while the session can still take a turn', () => {
    const items = inboxItems({
      sessions: [
        session('ok', { status: 'crashed', resumable: true }),
        session('gone', { status: 'crashed', resumable: false }),
      ],
      projects: [project()],
      now: NOW,
    });
    expect(items.map(labels)).toEqual([['Resume', 'Open'], ['Open']]);
  });

  it('offers Merge exactly when the session’s merge button would', () => {
    const ready = inboxItems({
      sessions: [
        session('pr', {
          pr: { phase: 'open', pipeline: 'success', mergeable: true },
          pullRequest: readyPr,
        }),
      ],
      projects: [project()],
      now: NOW,
    });
    expect(ready[0]).toMatchObject({ kind: 'merge_ready', context: 'acme/website · PR #2031' });
    expect(ready[0]?.actions[0]).toEqual({
      kind: 'merge',
      label: 'Squash & merge',
      sessionId: 'pr',
      number: 2031,
    });
    // A maintainer-only merge is still worth seeing, but not with a button that fails.
    const maintainer = inboxItems({
      sessions: [
        session('pr', {
          pr: { phase: 'open', pipeline: 'success', mergeable: true },
          pullRequest: { ...readyPr, viewerCanMerge: false },
        }),
      ],
      projects: [project()],
      now: NOW,
    });
    expect(labels(maintainer[0])).toEqual(['Open']);
    // Running CI is not something to act on.
    const running = inboxItems({
      sessions: [session('pr', { pr: { phase: 'open', pipeline: 'running', mergeable: null } })],
      projects: [project()],
      now: NOW,
    });
    expect(running).toEqual([]);
  });

  it('shows a meeting inside the join window until it is decided', () => {
    const at = (over: Partial<UpcomingMeeting>) =>
      inboxItems({ sessions: [], projects: [], meetings: [meeting(over)], now: NOW });
    expect(labels(at({})[0])).toEqual(['Join with Verity', 'Skip']);
    // In person has no session to record into from Home yet.
    expect(at({ provider: null })).toEqual([]);
    expect(at({ startsAt: NOW + MEETING_LEAD_MS + 60_000 })).toEqual([]);
    // Joined meetings belong to the overlay; ended ones to nobody.
    expect(at({ decision: 'joined' })).toEqual([]);
    expect(at({ startsAt: NOW - 70 * 60_000, endsAt: NOW - 1 })).toEqual([]);
  });

  it('reports one health item per project, repair first', () => {
    const items = inboxItems({
      sessions: [],
      projects: [
        project({ id: 'broken', state: 'failed', provisionError: 'Image pull failed' }),
        project({ id: 'scan', vulnerabilitySummary: { count: 4, critical: 1, high: 2 } }),
        project({ id: 'minor', vulnerabilitySummary: { count: 3, critical: 0, high: 0 } }),
        project({ id: 'archived', archived: true, state: 'failed' }),
      ],
      now: NOW,
    });
    expect(items.map((item) => [item.projectId, item.tag])).toEqual([
      ['broken', 'Repair'],
      ['scan', 'Vulnerabilities'],
    ]);
    expect(items[0]?.actions[0]).toEqual({
      kind: 'repair_project',
      label: 'Repair',
      projectId: 'broken',
    });
  });

  it('orders time-bound and blocking items first, newest first within a kind', () => {
    const items = inboxItems({
      sessions: [
        session('older-q', {
          lastActivityAt: NOW - 600_000,
          openChoices: { options: [{ label: 'A' }] },
        }),
        session('newer-q', {
          lastActivityAt: NOW - 60_000,
          openChoices: { options: [{ label: 'B' }] },
        }),
        session('crash', { status: 'crashed' }),
        session('perm', {
          status: 'awaiting_input',
          permissionAwaitingInput: true,
          pendingPermissions: ['t'],
          pendingPermissionRequests: [
            { toolUseId: 't', tool: 'WebFetch', riskClass: 'ask', input: {} },
          ],
        }),
      ],
      projects: [project()],
      meetings: [meeting()],
      now: NOW,
    });
    expect(items.map((item) => item.sessionId ?? item.kind)).toEqual([
      'meeting',
      'perm',
      'newer-q',
      'older-q',
      'crash',
    ]);
    expect(inboxSummary(items)).toBe(
      '1 meeting soon · 1 permission · 2 questions · 1 crashed session',
    );
  });

  it('drops an item once its source no longer reports it', () => {
    const asked = session('form', { openChoices: { options: [{ label: 'Zod' }] } });
    expect(inboxItems({ sessions: [asked], projects: [project()], now: NOW })).toHaveLength(1);
    const answered = { ...asked, openChoices: undefined, status: 'running' as const };
    expect(inboxItems({ sessions: [answered], projects: [project()], now: NOW })).toEqual([]);
  });

  it('leaves out sessions of archived projects', () => {
    const items = inboxItems({
      sessions: [session('old', { status: 'crashed' })],
      projects: [project({ archived: true })],
      now: NOW,
    });
    expect(items).toEqual([]);
  });
});

describe('inboxView', () => {
  const asking = (over: Partial<SessionSummary> = {}) =>
    session('s1', {
      status: 'awaiting_input',
      openChoices: { question: 'Ship it?', options: [{ label: 'Yes' }] },
      ...over,
    });

  it('hides dismissed items and keeps them apart for restoring', () => {
    const open = inboxView({ sessions: [asking({ inboxDismissed: [] })], projects: [], now: NOW });
    expect(open.visible).toHaveLength(1);
    expect(open.visible[0]?.dismiss).toBe('session');
    const key = open.visible[0]!.key;
    const view = inboxView({
      sessions: [asking({ inboxDismissed: [key] })],
      projects: [],
      now: NOW,
    });
    expect(view.visible).toEqual([]);
    expect(view.hidden.map((item) => item.key)).toEqual([key]);
    // The line above Home counts only what it shows.
    expect(inboxSummary(view.visible)).toBe('Nothing needs you right now.');
  });

  it('offers no X against a server that cannot keep the dismissal', () => {
    const [item] = inboxView({ sessions: [asking()], projects: [], now: NOW }).visible;
    expect(item?.dismiss).toBeUndefined();
    // A meeting's X is its Skip, which every server already stores.
    const [call] = inboxView({
      sessions: [],
      projects: [],
      meetings: [meeting()],
      now: NOW,
    }).visible;
    expect(call?.dismiss).toBe('meeting');
  });

  it('brings a dismissed pull request back with a new commit', () => {
    const pr = (headSha: string) =>
      session('pr', {
        pr: { phase: 'open', pipeline: 'success', mergeable: true },
        pullRequest: { ...readyPr, headSha },
      });
    const [first] = inboxItems({ sessions: [pr('aaa')], projects: [project()], now: NOW });
    const view = inboxView({
      sessions: [{ ...pr('bbb'), inboxDismissed: [first!.key] }],
      projects: [project()],
      now: NOW,
    });
    expect(view.visible).toHaveLength(1);
    expect(view.hidden).toEqual([]);
  });

  it('brings a dismissed project problem back when the project breaks again', () => {
    const broken = (stateChangedAt: string) =>
      project({ state: 'failed', provisionError: 'Image pull failed', stateChangedAt });
    const [first] = inboxItems({
      sessions: [],
      projects: [broken('2026-11-03T08:00:00Z')],
      now: NOW,
    });
    expect(first?.key.startsWith('health:p1:')).toBe(true);
    const again = inboxView({
      sessions: [],
      projects: [{ ...broken('2026-11-03T09:30:00Z'), inboxDismissed: [first!.key] }],
      now: NOW,
    });
    expect(again.visible.map((item) => item.dismiss)).toEqual(['project']);
  });
});
