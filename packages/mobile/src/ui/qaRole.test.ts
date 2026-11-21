import { describe, expect, it } from 'vitest';

import type { ProjectRecord } from '../api.js';
import type { ProjectQASummary } from '../project-qa-api.js';
import { parseQAPush } from '../push/payload.js';
import { inboxItems, inboxSummary } from './inbox.js';
import { qaIssueLabel, qaRowView } from './qaRole.js';

const NOW = Date.parse('2026-11-21T08:20:00Z');
const summary = (over: Partial<ProjectQASummary> = {}): ProjectQASummary => ({
  mode: 'automatic',
  health: 'healthy',
  checkedAt: new Date(NOW - 60_000).toISOString(),
  open: 0,
  repairing: 0,
  needsYou: 0,
  failingPullRequests: 0,
  failingWorkflows: 0,
  stopped: [],
  ...over,
});
const project = (over: Partial<ProjectRecord> = {}): ProjectRecord => ({
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
});

describe('qaRowView', () => {
  it('is green only after a fresh, complete check', () => {
    const clear = qaRowView(summary(), NOW);
    expect(clear.state).toBe('clear');
    expect(clear.sources).toEqual([
      { label: 'PRs ok', intent: 'ready' },
      { label: 'CI ok', intent: 'ready' },
    ]);
    expect(clear.checked).toMatch(/^Checked \d\d:\d\d$/);
    // An old check vouches for nothing.
    const stale = qaRowView(summary({ checkedAt: new Date(NOW - 30 * 60_000).toISOString() }), NOW);
    expect(stale.state).toBe('access');
    expect(stale.checked).toBeNull();
    expect(stale.sources.every((s) => s.intent === 'unknown')).toBe(true);
    expect(qaRowView(summary({ checkedAt: null }), NOW).subtitle).toBe('Not checked yet');
  });

  it('shows an unreadable source instead of green', () => {
    const view = qaRowView(summary({ health: 'workflow-monitoring-unsupported' }), NOW);
    expect(view.state).toBe('access');
    expect(view.subtitle).toBe("Can't read Actions");
    expect(view.sources).toEqual([
      { label: 'PRs ok', intent: 'ready' },
      { label: 'CI unreadable', intent: 'unknown' },
    ]);
    expect(qaRowView(summary({ health: 'unavailable' }), NOW).subtitle).toBe(
      "Can't read pull requests",
    );
  });

  it('puts a decision first and counts open work and repairs', () => {
    const view = qaRowView(
      summary({ needsYou: 1, open: 3, repairing: 1, failingPullRequests: 2 }),
      NOW,
    );
    expect(view.state).toBe('needsYou');
    expect(view.subtitle).toBe('3 open · 1 repair running');
    expect(view.sources[0]).toEqual({ label: 'PRs 2', intent: 'needsSetup' });
    expect(qaRowView(summary({ open: 2, repairing: 2 }), NOW)).toMatchObject({
      state: 'working',
      subtitle: '2 open · 2 repairs running',
    });
  });

  it('makes no claim while paused or switched off', () => {
    expect(qaRowView(summary({ mode: 'paused', needsYou: 2 }), NOW)).toMatchObject({
      state: 'paused',
      sources: [],
      checked: null,
    });
    expect(qaRowView(summary({ mode: 'off' }), NOW)).toMatchObject({ state: 'off', sources: [] });
  });
});

describe('QA on Home', () => {
  it('raises one answerable item per stopped issue, sent by the project QA', () => {
    const items = inboxItems({
      sessions: [],
      now: NOW,
      projects: [
        project({
          qaSummary: summary({
            needsYou: 1,
            stopped: [
              {
                id: 'issue-88',
                key: 'pr:88',
                reason: 'rounds-exhausted',
                detail: null,
                updatedAt: '2026-11-21T08:09:00Z',
              },
            ],
          }),
        }),
      ],
    });
    const qa = items.filter((item) => item.kind === 'qa_stop');
    expect(qa).toHaveLength(1);
    expect(qa[0]).toMatchObject({
      title: 'Repair stopped: PR #88',
      context: 'QA · acme/website',
      tag: 'Needs you',
      projectId: 'p1',
    });
    expect(qa[0]!.dismiss).toBeUndefined();
    expect(qa[0]!.actions.map((a) => a.label)).toEqual(['Another round', 'Take over', 'Defer']);
    expect(qa[0]!.actions[0]).toMatchObject({
      kind: 'qa_decision',
      projectId: 'p1',
      issueId: 'issue-88',
      decision: 'another_round',
    });
    expect(inboxSummary(qa)).toBe('1 QA decision');
  });

  it('raises nothing for archived projects or projects QA does not watch', () => {
    const stopped = summary({
      stopped: [{ id: 'i', key: 'workflow:ci', reason: null, detail: null, updatedAt: '' }],
    });
    expect(
      inboxItems({
        sessions: [],
        now: NOW,
        projects: [project({ archived: true, qaSummary: stopped }), project({ id: 'p2' })],
      }).filter((item) => item.kind === 'qa_stop'),
    ).toEqual([]);
  });
});

it('labels issues by their resource', () => {
  expect(qaIssueLabel('pr:88')).toBe('PR #88');
  expect(qaIssueLabel('workflow:nightly')).toBe('Workflow nightly');
});

it('accepts only a complete QA push and never treats it as an action', () => {
  expect(parseQAPush({ kind: 'qa', projectId: 'p1', issueId: 'i', deviceId: 'd' })).toEqual({
    kind: 'qa',
    projectId: 'p1',
    issueId: 'i',
    deviceId: 'd',
  });
  expect(parseQAPush({ kind: 'qa', projectId: 'p1' })).toBeNull();
  expect(parseQAPush({ kind: 'vulnerability', projectId: 'p1', deviceId: 'd' })).toBeNull();
});
