import { DEVCONTAINER_ROOT_USER_WARNING, PROJECT_IMAGE_REBUILDING_WARNING } from '@verity/events';
import { describe, expect, it } from 'vitest';

import type { ProjectLifecycleState, SandboxUpdate, SessionSummary } from '../api.js';
import { projectLifecycleBadge } from './projectBadge.js';
import { projectAgentMark, projectCardState, shortProvisionReason } from './projectCardState.js';
import { sessionAgentMark } from './sessionTile.js';
import { sessionWorkActive } from './sessionWork.js';

type CardProject = Parameters<typeof projectCardState>[0];

const running: CardProject = { state: 'active', provisionError: null };

// A Record keyed by the union fails to compile when the server adds a state, so
// the loop below cannot quietly skip one.
const LIFECYCLE_STATES = Object.keys({
  absent: true,
  cloning: true,
  container_starting: true,
  active: true,
  failed: true,
  sleeping_starting: true,
  sleeping: true,
  waking: true,
} satisfies Record<ProjectLifecycleState, true>) as ProjectLifecycleState[];

const update = (over: Partial<SandboxUpdate>): SandboxUpdate => ({
  state: 'available',
  kind: null,
  category: null,
  reason: null,
  current: null,
  target: null,
  currentVersion: null,
  currentRevision: null,
  targetVersion: null,
  targetRevision: null,
  selfRepair: 'converging',
  turnBlocked: false,
  lastRepairFailure: null,
  ...over,
});

describe('projectCardState', () => {
  // The card and the project page's Repair action must agree on what is broken,
  // and the card and the lifecycle badge on what runs; restating the mapping
  // here would keep passing after either side moved.
  it.each(LIFECYCLE_STATES)('agrees with the lifecycle badge for %s', (lifecycleState) => {
    const project: CardProject = { ...running, lifecycleState };
    const badge = projectLifecycleBadge(project);
    const expected = badge.needsRepair ? 'error' : badge.tone === 'done' ? 'running' : 'paused';
    expect(projectCardState(project).state).toBe(expected);
  });

  it('reads setup that has not started as on its way up', () => {
    expect(
      projectCardState({ state: 'absent', provisionError: null, setupStatus: 'pending' }),
    ).toEqual({
      state: 'paused',
      note: { label: 'Preparing…', tone: 'muted' },
    });
    expect(projectCardState({ state: 'absent', provisionError: null })).toEqual({
      state: 'paused',
    });
  });

  // Right after a Server deploy every project converges at once; a card that
  // changed for it would light up the whole list for nothing to do.
  it('keeps background work on a running sandbox off the card', () => {
    expect(
      projectCardState({
        ...running,
        provisionWarning: PROJECT_IMAGE_REBUILDING_WARNING,
        sandboxUpdate: update({}),
      }),
    ).toEqual({ state: 'running' });
  });

  it('names what to check on a running project briefly', () => {
    const note = (project: CardProject) => projectCardState(project).note?.label;
    expect(note({ ...running, provisionWarning: DEVCONTAINER_ROOT_USER_WARNING })).toBe(
      'Runs as root',
    );
    expect(note({ ...running, provisionWarning: 'Something else entirely.' })).toBe(
      'Check workspace',
    );
    expect(
      note({ ...running, toolkitDrift: { verdict: 'drifted', carrier: 'devcontainer' } }),
    ).toBe('Toolkit check');
    // A base image is not repaired by anything Verity offers; the page says so.
    expect(note({ ...running, toolkitDrift: { verdict: 'drifted', carrier: 'base-image' } })).toBe(
      undefined,
    );
    expect(note({ ...running, sandboxUpdate: update({ selfRepair: 'stalled' }) })).toBe(
      'Update stuck',
    );
    expect(note({ ...running, sandboxUpdate: update({ turnBlocked: true }) })).toBe(
      'Update waiting',
    );
    expect(projectCardState({ ...running, provisionWarning: 'x' }).state).toBe('running');
  });

  // A failed project that still carried a rebuild warning once read as busy
  // rather than broken; the error must win over every background signal.
  it('reports a failure with its short reason over any background work', () => {
    expect(
      projectCardState({
        state: 'failed',
        provisionError: 'Sandbox container stopped — Repair to restart it.',
        provisionWarning: PROJECT_IMAGE_REBUILDING_WARNING,
        sandboxUpdate: update({ selfRepair: 'stalled' }),
      }),
    ).toEqual({
      state: 'error',
      note: { label: 'Needs repair · Sandbox container stopped', tone: 'attention' },
    });
    expect(projectCardState({ state: 'failed', provisionError: null }).note?.label).toBe(
      'Needs repair',
    );
  });
});

describe('shortProvisionReason', () => {
  it.each([
    ['Sandbox container stopped — Repair to restart it.', 'Sandbox container stopped'],
    ['Devcontainer build failed: exit code 1', 'Devcontainer build failed'],
    ['Image pull failed. Retry later.', 'Image pull failed'],
    ['Container vanished.', 'Container vanished'],
  ])('shortens %j', (error, short) => {
    expect(shortProvisionReason(error)).toBe(short);
  });

  it('has nothing to say without an error', () => {
    expect(shortProvisionReason(null)).toBeUndefined();
    expect(shortProvisionReason('  ')).toBeUndefined();
  });
});

describe('projectAgentMark', () => {
  const session = (id: string, over: Partial<SessionSummary> = {}) =>
    ({ sessionId: id, status: 'idle', ...over }) as SessionSummary;

  // The card's corner must say what its most urgent session row says. Each
  // case's expectation comes from sessionAgentMark over that one session, so the
  // ranking lives in one place.
  it('takes the most urgent mark its sessions carry on their own rows', () => {
    const waiting = session('w', { status: 'awaiting_input' });
    const working = session('r', { status: 'running' });
    const fresh = session('n');
    const unread = new Set(['n', 'r']);
    const rowMark = (s: SessionSummary) => {
      const isWorking = sessionWorkActive(s);
      return sessionAgentMark({
        status: s.status,
        working: isWorking,
        unread: !isWorking && unread.has(s.sessionId),
      });
    };
    const rank = (mark: string | undefined) =>
      [rowMark(waiting), rowMark(working), rowMark(fresh), undefined].indexOf(
        mark as ReturnType<typeof rowMark>,
      );
    for (const sessions of [
      [fresh, working, waiting],
      [fresh, working],
      [fresh],
      [session('quiet')],
    ]) {
      const expected = sessions.map(rowMark).sort((a, b) => rank(a) - rank(b))[0];
      expect(projectAgentMark({ sessions, unread, waiting: false })).toBe(expected);
    }
  });

  // "N waiting for you" in the line and the corner must not disagree, also for
  // an approval or review that does not leave the session awaiting input.
  it('shows waiting whenever the line counts something waiting', () => {
    expect(projectAgentMark({ sessions: [session('a')], unread: new Set(), waiting: true })).toBe(
      sessionAgentMark({ status: 'awaiting_input', working: false, unread: false }),
    );
  });

  it('lets running work hide its own unread mark, as on the row', () => {
    expect(
      projectAgentMark({
        sessions: [session('b', { status: 'idle', backgroundWorking: true })],
        unread: new Set(['b']),
        waiting: false,
      }),
    ).toBe('working');
  });
});
