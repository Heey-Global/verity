import {
  createWatchInboxDrainer,
  WATCH_PROJECT_LIMIT,
  watchCaptureProject,
  watchProjectList,
  type WatchCapture,
} from './watchCapture';

jest.mock('./tasksStore', () => ({ captureTask: jest.fn() }));

const capture = (id: string): WatchCapture => ({
  id,
  text: `note ${id}`,
  createdAt: '2026-10-08T10:00:00Z',
  durationMs: 1200,
});

function inbox(initial: WatchCapture[]) {
  const entries = [...initial];
  return {
    entries,
    pending: jest.fn(async () => [...entries]),
    acknowledge: jest.fn(async (id: string) => {
      entries.splice(
        entries.findIndex((entry) => entry.id === id),
        1,
      );
    }),
  };
}

describe('watch inbox drain', () => {
  it('saves each capture before releasing it from the inbox', async () => {
    const box = inbox([capture('a'), capture('b')]);
    const order: string[] = [];
    const save = jest.fn(async (c: WatchCapture) => void order.push(`save ${c.id}`));
    box.acknowledge.mockImplementation(async (id: string) => {
      order.push(`ack ${id}`);
      box.entries.splice(
        box.entries.findIndex((entry) => entry.id === id),
        1,
      );
    });
    await createWatchInboxDrainer(box, save)();
    expect(order).toEqual(['save a', 'ack a', 'save b', 'ack b']);
    expect(box.entries).toHaveLength(0);
  });

  // The silent failure: acknowledging a capture the queue never stored deletes
  // the only copy of the recording on the iPhone.
  it('keeps a capture in the inbox when saving fails', async () => {
    const box = inbox([capture('a')]);
    const save = jest.fn(async () => {
      throw new Error('Sign in to save tasks');
    });
    await expect(createWatchInboxDrainer(box, save)()).rejects.toThrow('Sign in');
    expect(box.acknowledge).not.toHaveBeenCalled();
    expect(box.entries).toHaveLength(1);
  });

  it('saves later captures when an earlier one keeps failing', async () => {
    const box = inbox([capture('a'), capture('b')]);
    const save = jest.fn(async (c: WatchCapture) => {
      if (c.id === 'a') throw new Error('rejected');
    });
    await expect(createWatchInboxDrainer(box, save)()).rejects.toThrow('rejected');
    expect(box.entries.map((entry) => entry.id)).toEqual(['a']);
  });

  it('runs another pass for a capture that lands mid-drain', async () => {
    const box = inbox([capture('a')]);
    let drain: () => Promise<void> = async () => undefined;
    const save = jest.fn(async (c: WatchCapture) => {
      if (c.id === 'a') {
        box.entries.push(capture('b'));
        void drain();
      }
    });
    drain = createWatchInboxDrainer(box, save);
    await drain();
    expect(save.mock.calls.map(([c]) => c.id)).toEqual(['a', 'b']);
    expect(box.entries).toHaveLength(0);
  });
});

describe('watch project list', () => {
  const project = (id: string) => ({ id, repo: `repo-${id}` });
  const capturedAt = (projectId: string, createdAt: string) => ({
    projectId,
    origin: 'user' as const,
    createdAt,
  });

  it('puts the last quick-capture project first, then the most recently captured into', () => {
    const list = watchProjectList(
      [project('a'), project('b'), project('c')],
      [capturedAt('b', '2026-10-08T09:00:00Z'), capturedAt('c', '2026-10-08T10:00:00Z')],
      'a',
    );
    expect(list).toEqual([
      { id: 'a', name: 'repo-a' },
      { id: 'c', name: 'repo-c' },
      { id: 'b', name: 'repo-b' },
    ]);
  });

  // The silent failure: a remembered project from another account or a deleted
  // one must not push itself into the list.
  it('ignores a last project that is not in the list', () => {
    const list = watchProjectList([project('a'), project('b')], [], 'gone');
    expect(list.map((entry) => entry.id)).toEqual(['a', 'b']);
  });

  it('keeps the last project even when it falls beyond the cut', () => {
    const projects = Array.from({ length: WATCH_PROJECT_LIMIT + 3 }, (_, i) => project(`p${i}`));
    const last = projects[projects.length - 1].id;
    const list = watchProjectList(projects, [], last);
    expect(list).toHaveLength(WATCH_PROJECT_LIMIT);
    expect(list[0].id).toBe(last);
  });
});

describe('watch capture project', () => {
  const known = { scope: 'account-1', ids: new Set(['p1']) };
  const picked = (overrides: Partial<WatchCapture>): WatchCapture => ({
    ...capture('a'),
    projectId: 'p1',
    scope: 'account-1',
    ...overrides,
  });

  it('saves to the project picked on the watch', () => {
    expect(watchCaptureProject(picked({}), known, 'account-1')).toBe('p1');
  });

  // Each of these would otherwise file the note under a project the user did
  // not pick, or under another account's project.
  it.each([
    ['no project was picked', picked({ projectId: undefined })],
    ['it was picked under another account', picked({ scope: 'account-2' })],
    ['the project is unknown here', picked({ projectId: 'p2' })],
  ])('holds the capture when %s', (_, held) => {
    expect(() => watchCaptureProject(held, known, 'account-1')).toThrow();
  });

  // Right after an account switch the loaded projects can still be the previous
  // account's while the task queue already writes for the new one.
  it('holds a capture while the known projects belong to another sign-in', () => {
    expect(() => watchCaptureProject(picked({}), known, 'account-2')).toThrow('another account');
  });

  it('holds every capture until the projects are loaded', () => {
    expect(() => watchCaptureProject(picked({}), null, 'account-1')).toThrow();
  });

  it('keeps a held capture in the inbox and saves the next one', async () => {
    const box = inbox([picked({ id: 'a', scope: 'account-2' }), picked({ id: 'b' })]);
    const saved: string[] = [];
    const save = jest.fn(async (c: WatchCapture) => {
      saved.push(`${c.id}:${watchCaptureProject(c, known, 'account-1')}`);
    });
    await expect(createWatchInboxDrainer(box, save)()).rejects.toThrow('another account');
    expect(saved).toEqual(['b:p1']);
    expect(box.entries.map((entry) => entry.id)).toEqual(['a']);
  });
});
