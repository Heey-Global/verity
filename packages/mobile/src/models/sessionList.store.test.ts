import { describe, expect, it, vi, type Mock } from 'vitest';
import type { SessionSummary, VerityClient } from '../api.js';
import { OverviewStore } from '../live/overviewStore.js';
import { SessionListModel } from './sessionList.js';

const usage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  turns: 0,
};

function summary(id: string, extra: Partial<SessionSummary> = {}): SessionSummary {
  return {
    sessionId: id,
    worktree: `/wt/${id}`,
    model: 'm',
    name: null,
    status: 'running',
    usage,
    projectId: 'p1',
    ...extra,
  };
}

interface Harness {
  model: SessionListModel;
  store: OverviewStore;
  client: VerityClient & { listSessions: Mock<() => Promise<SessionSummary[]>> };
  shown: (id: string) => SessionSummary | undefined;
}

function harness(
  reads: () => Promise<SessionSummary[]>,
  writes: Partial<VerityClient> = {},
  onChange?: (state: SessionListModel['state']) => void,
): Harness {
  const store = new OverviewStore();
  const client = {
    listSessions: vi.fn(reads),
    listProviderLimits: () => Promise.resolve([]),
    renameSession: vi.fn(),
    setSessionFavorite: vi.fn(),
    deleteSession: vi.fn(),
    ...writes,
  } as unknown as Harness['client'];
  const model = new SessionListModel({
    client,
    store: () => store,
    pollIntervalMs: 0,
    schedule: () => () => undefined,
    ...(onChange === undefined ? {} : { onChange }),
  });
  // As the hook does: a running list follows the store.
  store.subscribe(() => model.storeChanged());
  return {
    model,
    store,
    client,
    shown: (id) => model.state.sessions.find((session) => session.sessionId === id),
  };
}

/** Another view (the project page) reading the project's sessions. */
function projectPageRead(store: OverviewStore, sessions: SessionSummary[]): void {
  store.applySessions(store.beginRead(), sessions, {
    covers: (session) => session.projectId === 'p1',
  });
}

describe('SessionListModel with the shared overview store', () => {
  it("shows what another view read, its new sessions too, and puts Home's read in the store", async () => {
    const { model, store, shown } = harness(() => Promise.resolve([summary('s1')]));
    const changes = vi.fn();
    store.subscribe(changes);
    await model.refresh();
    // Home's read is the store's copy for every other view.
    expect(store.session('s1')?.status).toBe('running');

    model.start();
    projectPageRead(store, [summary('s1', { status: 'idle' }), summary('s2')]);
    expect(shown('s1')?.status).toBe('idle');
    expect(shown('s2')).toBeDefined();
    model.stop();
  });

  // Without the adoption the project page kept the old status until its next
  // read, while Home already showed the action's answer.
  it("puts an action's answer in the store, where an older read does not undo it", async () => {
    let answer: (sessions: SessionSummary[]) => void = () => undefined;
    const { model, store, client } = harness(() => Promise.resolve([summary('s1')]));
    await model.refresh();
    client.listSessions.mockImplementationOnce(
      () => new Promise<SessionSummary[]>((resolve) => (answer = resolve)),
    );
    const older = model.refresh();
    model.applySessionStatus('s1', 'idle');
    expect(store.session('s1')?.status).toBe('idle');
    answer([summary('s1', { status: 'running' })]);
    await older;
    expect(store.session('s1')?.status).toBe('idle');
  });

  it('keeps a favorite and a name being saved over the store copy', async () => {
    let saved: () => void = () => undefined;
    const { model, store, shown } = harness(() => Promise.resolve([summary('s1')]), {
      setSessionFavorite: vi.fn(
        () => new Promise((resolve) => (saved = () => resolve({ favorite: true }))),
      ),
      renameSession: vi.fn(() => new Promise(() => undefined)),
    } as Partial<VerityClient>);
    await model.refresh();
    model.start();
    const favorite = model.setFavorite('s1', true);
    void model.rename('s1', 'Renamed');
    // Another view's read of the old state must not hide either change.
    projectPageRead(store, [summary('s1', { status: 'idle' })]);
    expect(shown('s1')).toMatchObject({ favorite: true, name: 'Renamed', status: 'idle' });
    saved();
    await favorite;
    expect(shown('s1')?.favorite).toBe(true);
    model.stop();
  });

  it('does not bring back a session being deleted from the store', async () => {
    const { model, store, shown } = harness(() => Promise.resolve([summary('s1')]), {
      deleteSession: vi.fn(() => new Promise(() => undefined)),
    } as Partial<VerityClient>);
    await model.refresh();
    model.start();
    void model.delete('s1').catch(() => undefined);
    projectPageRead(store, [summary('s1')]);
    expect(shown('s1')).toBeUndefined();
    model.stop();
  });

  // Past the store's replay bound it refuses the read; Home must still list
  // what the server sent, and read once more to get back into the store.
  it('lists its own read when the store refused it, and reads again once', async () => {
    let answer: (sessions: SessionSummary[]) => void = () => undefined;
    const { model, store, client, shown } = harness(
      () => new Promise<SessionSummary[]>((resolve) => (answer = resolve)),
    );
    model.start();
    // Another view's stale copy that the refused read must not show.
    projectPageRead(store, [summary('s1', { name: 'Stale' })]);
    for (let i = 0; i < 257; i += 1)
      store.applyEvent({ t: 'choices.answered', sessionId: `other-${i}`, rev: 1 });
    answer([summary('s1', { name: 'Fresh' })]);
    await vi.waitFor(() => expect(client.listSessions.mock.calls).toHaveLength(2));
    expect(shown('s1')?.name).toBe('Fresh');
    answer([summary('s1', { name: 'Fresh' })]);
    await vi.waitFor(() => expect(store.session('s1')?.name).toBe('Fresh'));
    expect(client.listSessions.mock.calls).toHaveLength(2);
    model.stop();
  });

  it('shows changes the store took while the list was stopped when it starts', async () => {
    const statuses: string[] = [];
    const { model, store, client } = harness(
      () => new Promise(() => undefined),
      {},
      (state) => statuses.push(state.sessions[0]?.status ?? ''),
    );
    client.listSessions.mockResolvedValueOnce([summary('s1')]);
    await model.refresh();
    statuses.length = 0;
    // Stopped: nothing is shown until the list runs again.
    projectPageRead(store, [summary('s1', { status: 'idle' })]);
    expect(statuses).toEqual([]);
    model.start();
    expect(statuses[0]).toBe('idle');
    model.stop();
  });
});
