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

  // Home hides its own unconfirmed changes on top of the store; once the
  // server confirmed them, the project page reads the same store.
  it('puts a confirmed favorite, order and deletion in the store for the other views', async () => {
    const { model, store } = harness(() => Promise.resolve([summary('s1'), summary('s2')]), {
      setSessionFavorite: vi.fn(() => Promise.resolve({ sessionId: 's1', favorite: true })),
      deleteSession: vi.fn(() => Promise.resolve({ sessionId: 's2' })),
      listSessionOverview: () =>
        Promise.resolve({
          sessions: [summary('s1'), summary('s2')],
          attention: [],
          sessionReordering: true,
        }),
      reorderSessions: vi.fn((_project: string | null, ids: string[]) => Promise.resolve(ids)),
    });
    await model.refresh();
    await model.setFavorite('s1', true);
    expect(store.session('s1')?.favorite).toBe(true);
    await model.reorder('p1', ['s2', 's1']);
    expect([store.session('s2')?.sortOrder, store.session('s1')?.sortOrder]).toEqual([0, 1]);
    await model.delete('s2');
    expect(store.session('s2')).toBeUndefined();
  });

  it('leaves the newer name in the store when an older rename answers late', async () => {
    const answers: Array<(name: string) => void> = [];
    const { model, store } = harness(() => Promise.resolve([summary('s1')]), {
      renameSession: vi.fn(
        () =>
          new Promise<{ sessionId: string; name: string }>((resolve) =>
            answers.push((name) => resolve({ sessionId: 's1', name })),
          ),
      ),
    });
    await model.refresh();
    const first = model.rename('s1', 'First');
    const second = model.rename('s1', 'Second');
    answers[1]!('Second');
    await second;
    answers[0]!('First');
    await first;
    expect(store.session('s1')?.name).toBe('Second');
  });

  it('drops a session from Home once another view read it gone', async () => {
    const { model, store, shown } = harness(() => Promise.resolve([summary('s1')]));
    await model.refresh();
    model.start();
    projectPageRead(store, []);
    expect(shown('s1')).toBeUndefined();
    expect(model.state.attentionCount).toBe(0);
    model.stop();
  });

  it('writes a confirmed order to the store in one change, unlisted sessions unordered', async () => {
    const sessions = [summary('s1'), summary('s2'), summary('s3', { sortOrder: 2 })];
    const { model, store } = harness(() => Promise.resolve(sessions), {
      listSessionOverview: () =>
        Promise.resolve({ sessions, attention: [], sessionReordering: true }),
      reorderSessions: vi.fn(() => Promise.resolve(['s2', 's1'])),
    });
    await model.refresh();
    const changes = vi.fn();
    store.subscribe(changes);
    await model.reorder('p1', ['s2', 's1']);
    expect(changes).toHaveBeenCalledTimes(1);
    expect(['s1', 's2', 's3'].map((id) => store.session(id)?.sortOrder)).toEqual([1, 0, null]);
  });

  it('keeps the name the server stored when a later rename of it fails', async () => {
    const answers: Array<{ resolve: (name: string) => void; reject: () => void }> = [];
    const { model, store, shown } = harness(() => Promise.resolve([summary('s1')]), {
      renameSession: vi.fn(
        () =>
          new Promise<{ sessionId: string; name: string }>((resolve, reject) =>
            answers.push({
              resolve: (name) => resolve({ sessionId: 's1', name }),
              reject: () => reject(new Error('refused')),
            }),
          ),
      ),
    });
    await model.refresh();
    model.start();
    const first = model.rename('s1', 'First');
    const second = model.rename('s1', 'Second');
    answers[0]!.resolve('First');
    await first;
    answers[1]!.reject();
    await second;
    expect(store.session('s1')?.name).toBe('First');
    expect(shown('s1')?.name).toBe('First');
    model.stop();
  });

  // The store never took the choice that failed; writing Home's earlier value
  // back would undo what it took from elsewhere meanwhile.
  it('leaves the store alone when a favorite fails', async () => {
    let fail: () => void = () => undefined;
    const { model, store } = harness(() => Promise.resolve([summary('s1')]), {
      setSessionFavorite: vi.fn(
        () => new Promise<never>((_resolve, reject) => (fail = () => reject(new Error('no')))),
      ),
    });
    await model.refresh();
    const write = model.setFavorite('s1', true);
    projectPageRead(store, [summary('s1', { favorite: true })]);
    fail();
    await write;
    expect(store.session('s1')?.favorite).toBe(true);
  });

  it('renders an action once, though it also changes the store', async () => {
    const onChange = vi.fn();
    const { model } = harness(() => Promise.resolve([summary('s1')]), {}, onChange);
    await model.refresh();
    model.start();
    onChange.mockClear();
    model.applySessionStatus('s1', 'idle');
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]![0].sessions[0].status).toBe('idle');
    model.stop();
  });

  // Before the shared store Home showed only its own read; now a confirmed
  // favorite laid on top would hide a later change made elsewhere.
  it('shows a favorite changed elsewhere after its own was confirmed', async () => {
    const { model, store, shown } = harness(() => Promise.resolve([summary('s1')]), {
      setSessionFavorite: vi.fn(() => Promise.resolve({ sessionId: 's1', favorite: true })),
    });
    await model.refresh();
    model.start();
    await model.setFavorite('s1', true);
    projectPageRead(store, [summary('s1')]);
    expect(shown('s1')?.favorite).toBeUndefined();
    model.stop();
  });

  // The store takes the server's rows, never Home's own copy with unconfirmed
  // writes laid on, so a write that fails after a read leaves nothing behind.
  it('keeps the server rows in the store when a read lands during a write that fails', async () => {
    const fails: Array<() => void> = [];
    const pending = <T>() =>
      new Promise<T>((_resolve, reject) => fails.push(() => reject(new Error('no'))));
    const { model, store, shown } = harness(() => Promise.resolve([summary('s1'), summary('s2')]), {
      setSessionFavorite: vi.fn(() => pending<never>()),
      deleteSession: vi.fn(() => pending<never>()),
    });
    await model.refresh();
    model.start();
    const favorite = model.setFavorite('s1', true);
    const deletion = model.delete('s2').catch(() => undefined);
    await model.refresh();
    expect(store.session('s1')?.favorite).toBeUndefined();
    expect(store.session('s2')).toBeDefined();
    for (const fail of fails) fail();
    await favorite;
    await deletion;
    expect(shown('s1')?.favorite).toBeUndefined();
    expect(shown('s2')).toBeDefined();
    model.stop();
  });

  it('publishes a read once, from the store it went into', async () => {
    const onChange = vi.fn();
    const { model, client } = harness(() => Promise.resolve([summary('s1')]), {}, onChange);
    model.start();
    await vi.waitFor(() => expect(onChange).toHaveBeenCalled());
    onChange.mockClear();
    // A read that changes the store, which notifies its listeners.
    client.listSessions.mockResolvedValueOnce([summary('s1', { status: 'idle' })]);
    await model.refresh({ silent: true });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]![0].sessions[0].status).toBe('idle');
    model.stop();
  });
});
