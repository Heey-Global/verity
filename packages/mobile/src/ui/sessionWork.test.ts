import { describe, expect, it } from 'vitest';
import type { SessionPr, SessionSummary } from '../api.js';
import { inboxItems } from './inbox.js';
import { retainWorkMembers, sessionWorkSections } from './sessionWork.js';

function session(id: string, fields: Partial<SessionSummary> = {}): SessionSummary {
  return {
    sessionId: id,
    worktree: `/wt/${id}`,
    model: 'test-model',
    name: id,
    status: 'completed',
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      turns: 0,
    },
    lastActivityAt: 0,
    ...fields,
  };
}
const pr = (fields: Partial<SessionPr> = {}): SessionPr => ({
  phase: 'open',
  pipeline: 'failure',
  mergeable: false,
  ...fields,
});
const sections = (sessions: SessionSummary[], unread: ReadonlySet<string> = new Set()) =>
  sessionWorkSections(sessions, inboxItems({ sessions, projects: [], now: 0 }), unread);

function membership(sessions: SessionSummary[], unread: ReadonlySet<string> = new Set()) {
  const groups = sections(sessions, unread);
  return {
    needs: groups.needsYou.flatMap((e) => (e.kind === 'session' ? [e.session.sessionId] : [])),
    active: groups.active.map((s) => s.sessionId),
    results: groups.results.map((s) => s.sessionId),
  };
}

describe('sessionWorkSections', () => {
  it('moves one session between CI work, stopped failure, agent work and unread result', () => {
    const current = session('checks', { pr: pr({ pipeline: 'running' }) });
    expect(membership([current])).toEqual({ needs: [], active: ['checks'], results: [] });
    const failed = { ...current, pr: pr() };
    expect(membership([failed])).toEqual({ needs: ['checks'], active: [], results: [] });
    expect(membership([{ ...failed, status: 'running' }])).toEqual({
      needs: [],
      active: ['checks'],
      results: [],
    });
    expect(membership([{ ...failed, backgroundWorking: true }])).toEqual({
      needs: [],
      active: ['checks'],
      results: [],
    });
    expect(membership([current])).toEqual({ needs: [], active: ['checks'], results: [] });
    const result = { ...current, pr: pr({ phase: 'merged', pipeline: 'success' }) };
    expect(membership([result], new Set(['checks']))).toEqual({
      needs: [],
      active: [],
      results: ['checks'],
    });
    expect(membership([result])).toEqual({ needs: [], active: [], results: [] });
  });

  it.each([
    ['failed checks', pr()],
    ['merge conflict', pr({ pipeline: 'unknown', mergeState: 'dirty' })],
    ['blocked merge', pr({ pipeline: 'success', mergeState: 'blocked' })],
  ])('does not mistake dependency waiting for an agent resolving %s', (_, state) => {
    expect(membership([session('waiting', { status: 'awaiting_dependency', pr: state })])).toEqual({
      needs: ['waiting'],
      active: [],
      results: [],
    });
    expect(membership([session('working', { status: 'running', pr: state })])).toEqual({
      needs: [],
      active: ['working'],
      results: [],
    });
  });

  it('keeps explicit permission, question and review decisions ahead of background work', () => {
    const permission = session('permission', {
      backgroundWorking: true,
      permissionAwaitingInput: true,
      pendingPermissions: ['permission-1'],
    });
    const question = session('question', {
      status: 'running',
      openChoices: { question: 'Continue?', options: [{ label: 'Yes' }] },
    });
    const plan = session('plan', {
      backgroundWorking: true,
      planning: 'active',
      planningPresented: true,
    });
    const groups = membership(
      [permission, question, plan],
      new Set(['permission', 'question', 'plan']),
    );
    expect(groups.needs.sort()).toEqual(['permission', 'plan', 'question']);
    expect(groups.active).toEqual([]);
    expect(groups.results).toEqual([]);
  });

  it('keeps a crashed or disconnected session actionable despite background activity', () => {
    const crashed = session('crashed', { status: 'crashed', backgroundWorking: true });
    const disconnected = session('disconnected', {
      status: 'running',
      attention: [{ code: 'sandbox_disconnected', message: 'Connection lost' }],
    });
    expect(membership([crashed, disconnected])).toEqual({
      needs: ['crashed', 'disconnected'],
      active: [],
      results: [],
    });
  });

  it('does not recreate a dismissed question from its lifecycle status', () => {
    const question = session('question', {
      status: 'awaiting_input',
      openChoices: { question: 'Continue?', options: [{ label: 'Yes' }] },
    });
    const items = inboxItems({ sessions: [question], projects: [], now: 0 });
    expect(items).toHaveLength(1);
    const hidden = sessionWorkSections([question], [], new Set());
    expect(hidden).toEqual({ needsYou: [], active: [], results: [] });
  });

  it('places a session with several decisions exactly once using the first visible reason', () => {
    const current = session('many', {
      status: 'crashed',
      openChoices: { question: 'Continue?', options: [{ label: 'Yes' }] },
      pr: pr(),
    });
    const items = inboxItems({ sessions: [current], projects: [], now: 0 });
    expect(items.length).toBeGreaterThan(1);
    const groups = sessionWorkSections([current], items, new Set(['many']));
    expect(groups.needsYou).toEqual([
      { kind: 'session', session: current, item: items[0], additionalItems: items.slice(1) },
    ]);
    expect(groups.active).toEqual([]);
    expect(groups.results).toEqual([]);
  });

  it('never counts unread work as a second result, and leaves settled read sessions out', () => {
    const working = session('working', { status: 'running' });
    const ci = session('ci', { pr: pr({ pipeline: 'pending' }) });
    const result = session('result');
    const quiet = session('quiet');
    const groups = membership([working, ci, result, quiet], new Set(['working', 'ci', 'result']));
    expect(groups).toEqual({ needs: [], active: ['working', 'ci'], results: ['result'] });
  });
});

describe('retainWorkMembers', () => {
  it('retains order only for still eligible members and appends entering sessions', () => {
    expect(retainWorkMembers(['old-question', 'b', 'a'], ['a', 'b', 'new-question'])).toEqual([
      'b',
      'a',
      'new-question',
    ]);
    expect(retainWorkMembers(['b', 'a'], ['a'])).toEqual(['a']);
  });
});
