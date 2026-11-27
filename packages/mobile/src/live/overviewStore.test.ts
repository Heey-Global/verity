import type { DomainEvent } from '@verity/events';
import { describe, expect, it, vi } from 'vitest';
import type { ProjectRecord, SessionSummary } from '../api.js';
import { OverviewStore, type OverviewReadScope } from './overviewStore.js';

const usage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  turns: 0,
};

function session(sessionId: string, extra: Partial<SessionSummary> = {}): SessionSummary {
  return {
    sessionId,
    projectId: 'p1',
    worktree: `/wt/${sessionId}`,
    model: 'm',
    name: null,
    status: 'idle',
    usage,
    ...extra,
  };
}

function project(id: string, extra: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    id,
    owner: 'o',
    repo: id,
    containerName: id,
    kind: 'github',
    imageRef: null,
    state: 'active',
    provisionError: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...extra,
  };
}

const waiting = (id = 's1') =>
  session(id, {
    status: 'awaiting_input',
    permissionAwaitingInput: true,
    pendingPermissions: ['tool-1'],
    pendingPermissionRequests: [
      { toolUseId: 'tool-1', tool: 'Bash', riskClass: 'secret', detached: true },
    ],
  });

const decided = (rev: number): DomainEvent => ({
  t: 'permission.decided',
  sessionId: 's1',
  toolUseId: 'tool-1',
  rev,
  outcome: 'allowed',
});

const allSessions: OverviewReadScope<SessionSummary> = { covers: () => true };
const projectSessions = (projectId: string): OverviewReadScope<SessionSummary> => ({
  covers: (s) => s.projectId === projectId,
});
const allProjects: OverviewReadScope<ProjectRecord> = { covers: () => true };

function readSessions(store: OverviewStore, sessions: SessionSummary[], scope = allSessions) {
  store.applySessions(store.beginRead(), sessions, scope);
}

describe('OverviewStore', () => {
  it('applies an event once to the shared copy and tells its listeners', () => {
    const store = new OverviewStore();
    readSessions(store, [waiting()]);
    const listener = vi.fn();
    store.subscribe(listener);
    expect(store.applyEvent(decided(2))).toEqual({ applied: true });
    expect(store.applyEvent(decided(2))).toEqual({ applied: false });
    expect(store.session('s1')?.pendingPermissionRequests).toEqual([]);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  // A read that started before an answer must not bring the answered card
  // back, on any view, however late it answers.
  it('applies events that arrived during a read on top of its late answer', () => {
    const store = new OverviewStore();
    readSessions(store, [waiting()]);
    const late = store.beginRead();
    store.applyEvent(decided(2));
    store.applySessions(late, [waiting()], allSessions);
    expect(store.session('s1')?.pendingPermissionRequests).toEqual([]);
    // A read started after the answer is the server's word again.
    readSessions(store, [waiting()]);
    expect(store.session('s1')?.pendingPermissionRequests).toHaveLength(1);
  });

  it('ignores a read that answers after a newer read of the same scope', () => {
    const store = new OverviewStore();
    const older = store.beginRead();
    const newer = store.beginRead();
    store.applySessions(newer, [session('s1', { status: 'running' })], allSessions);
    store.applySessions(older, [session('s1')], allSessions);
    expect(store.session('s1')?.status).toBe('running');
  });

  // Home reads every session, the project page one project's sessions; an
  // older Home read answering late must not undo the page's newer read.
  it('keeps what a newer overlapping read said about a session', () => {
    const store = new OverviewStore();
    const home = store.beginRead();
    const page = store.beginRead();
    store.applySessions(page, [session('new', { status: 'running' })], projectSessions('p1'));
    store.applySessions(home, [session('gone')], allSessions);
    expect(store.session('new')?.status).toBe('running');
    // The page read also spoke for sessions it did not return.
    const before = store.beginRead();
    const after = store.beginRead();
    store.applySessions(after, [], projectSessions('p1'));
    store.applySessions(before, [session('new')], allSessions);
    expect(store.session('new')).toBeUndefined();
  });

  // The newer read may show a state no event announced (here: the pull
  // request is gone); replaying the older event over it would bring it back.
  it('does not replay an event over a newer read that started after it', () => {
    const store = new OverviewStore();
    const open: DomainEvent = {
      t: 'pr.status',
      sessionId: 's1',
      rev: 1,
      pr: {
        number: 7,
        title: 'Add live status',
        url: 'https://example.test/pr/7',
        phase: 'open',
        pipeline: 'success',
        mergeable: true,
        checks: { completed: 1, total: 1, successful: 1, failed: 0, pending: 0 },
      },
    };
    readSessions(store, [session('s1')]);
    const older = store.beginRead();
    store.applyEvent(open);
    const newer = store.beginRead();
    store.applySessions(newer, [session('s1', { pullRequest: null, pr: null })], allSessions);
    store.applySessions(older, [session('s1')], allSessions);
    expect(store.session('s1')?.pullRequest).toBeNull();
  });

  // Past the bound the late read misses events it would need replayed; the
  // answered card would come back.
  it('ignores a late read once events it missed were dropped', () => {
    const store = new OverviewStore();
    readSessions(store, [waiting()]);
    const late = store.beginRead();
    store.applyEvent(decided(2));
    for (let i = 0; i < 256; i += 1)
      store.applyEvent({ t: 'choices.answered', sessionId: `other-${i}`, rev: 1 });
    expect(store.applySessions(late, [waiting()], allSessions)).toBe(false);
    expect(store.session('s1')?.pendingPermissionRequests).toEqual([]);
  });

  // With no read open nothing is kept, so a late answer would overwrite the
  // answered card with nothing to replay on top.
  it('ignores a read that already ended', () => {
    const store = new OverviewStore();
    readSessions(store, [waiting()]);
    const abandoned = store.beginRead();
    store.endRead(abandoned);
    store.applyEvent(decided(2));
    expect(store.applySessions(abandoned, [waiting()], allSessions)).toBe(false);
    expect(store.session('s1')?.pendingPermissionRequests).toEqual([]);
  });

  it('keeps the project list when only a session changes', () => {
    const store = new OverviewStore();
    readSessions(store, [waiting()]);
    store.applyProjects(store.beginRead(), [project('p1')], allProjects);
    const projects = store.projects();
    store.applyEvent(decided(2));
    expect(store.projects()).toBe(projects);
  });

  it('leaves revision checks to a caller that gates events itself', () => {
    const store = new OverviewStore({ gated: false });
    readSessions(store, [waiting()]);
    store.applyEvent(decided(5));
    expect(store.applyEvent(decided(4)).applied).toBe(true);
  });

  it('removes only the sessions a read covers and did not return', () => {
    const store = new OverviewStore();
    readSessions(store, [session('a'), session('b', { projectId: 'p2' })]);
    readSessions(store, [], projectSessions('p1'));
    expect(store.sessions().map((s) => s.sessionId)).toEqual(['b']);
  });

  it('keeps entities and lists the same objects when a read changes nothing', () => {
    const store = new OverviewStore();
    readSessions(store, [session('a'), session('b')]);
    const list = store.sessions();
    const a = store.session('a');
    const version = store.getVersion();
    readSessions(store, [session('a'), session('b')]);
    expect(store.sessions()).toBe(list);
    expect(store.session('a')).toBe(a);
    expect(store.getVersion()).toBe(version);
  });

  it('patches a held project and asks for the read the event cannot replace', () => {
    const store = new OverviewStore();
    store.applyProjects(
      store.beginRead(),
      [project('p1', { state: 'container_starting' })],
      allProjects,
    );
    const outcome = store.applyEvent({
      t: 'sandbox.lifecycle',
      projectId: 'p1',
      rev: 1,
      state: 'active',
    });
    expect(store.project('p1')?.state).toBe('active');
    expect(outcome).toEqual({ applied: true, reload: { projectId: 'p1' } });
  });

  it('does not count an event that leaves the session as it is as a change', () => {
    const store = new OverviewStore();
    readSessions(store, [session('s1', { pr: null, pullRequest: null })]);
    const listener = vi.fn();
    store.subscribe(listener);
    store.applyEvent({ t: 'pr.status', sessionId: 's1', rev: 1, pr: null });
    expect(listener).not.toHaveBeenCalled();
  });

  it('asks for a read when a request opens, even for a session not held yet', () => {
    const store = new OverviewStore();
    expect(
      store.applyEvent({ t: 'permission.requested', sessionId: 's9', toolUseId: 't', rev: 1 }),
    ).toEqual({ applied: true, reload: { sessionId: 's9' } });
  });

  it('applies older revisions again after a resync', () => {
    const store = new OverviewStore();
    readSessions(store, [waiting()]);
    store.applyEvent(decided(5));
    store.resync();
    expect(store.applyEvent(decided(4)).applied).toBe(true);
  });

  it('keeps no events once no read is on its way', () => {
    const store = new OverviewStore();
    readSessions(store, [waiting()]);
    const failed = store.beginRead();
    store.applyEvent(decided(2));
    store.endRead(failed);
    // A read that starts now must answer with the server's state, not the kept event.
    readSessions(store, [waiting()]);
    expect(store.session('s1')?.pendingPermissionRequests).toHaveLength(1);
  });
});
