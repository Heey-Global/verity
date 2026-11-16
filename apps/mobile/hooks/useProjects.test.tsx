import { act, renderHook, waitFor } from '@testing-library/react-native';
import { AppState, type AppStateStatus } from 'react-native';
import { VerityApiError, type VerityClient } from '@verity/mobile';
import { useProjects } from './useProjects';
import { useSessionPreviews } from '../lib/sessionPreviews';

let mockFocused = true;
const mockConnection = { connectionState: 'connected', resourceWatching: true };
const mockSubscriptions: { refresh: () => Promise<unknown>; filter: (path: string) => boolean }[] =
  [];
jest.mock('../lib/liveConnection', () => ({
  liveConnectionFor: () => mockConnection,
  subscribeLiveRefresh: (
    _client: unknown,
    refresh: () => Promise<unknown>,
    filter: (path: string) => boolean,
  ) => {
    const entry = { refresh, filter };
    mockSubscriptions.push(entry);
    return () => {
      mockSubscriptions.splice(mockSubscriptions.indexOf(entry), 1);
    };
  },
}));
jest.mock('../lib/sessionSwitchTiming', () => ({ beginClientActivity: () => () => undefined }));
jest.mock('expo-router', () => ({
  useFocusEffect: (callback: () => void) =>
    require('react').useEffect(
      () => (mockFocused ? callback() : undefined),
      [callback, mockFocused],
    ),
}));

beforeEach(() => {
  jest.spyOn(AppState, 'addEventListener').mockReturnValue({ remove: jest.fn() });
  Object.defineProperty(AppState, 'currentState', { configurable: true, value: 'active' });
  mockFocused = true;
  mockConnection.connectionState = 'connected';
  mockConnection.resourceWatching = true;
});

afterEach(() => jest.restoreAllMocks());

it('keeps empty runtime maps stable across overview renders and refreshes', async () => {
  const client = {
    listProjects: jest.fn().mockResolvedValue([]),
  };
  const { result, rerender, unmount } = renderHook(() =>
    useProjects(client as unknown as VerityClient),
  );
  await waitFor(() => expect(result.current.loading).toBe(false));
  const servers = result.current.devServersByProject;
  const detections = result.current.detectionsByProject;
  // Fresh empty maps invalidate project grouping even when only selection changed.
  rerender({});
  expect(result.current.devServersByProject).toBe(servers);
  expect(result.current.detectionsByProject).toBe(detections);
  await act(async () => {
    await result.current.refresh();
  });
  expect(result.current.devServersByProject).toBe(servers);
  expect(result.current.detectionsByProject).toBe(detections);
  unmount();
});

it('refreshes only the invalidated project share source and keeps list refresh independent', async () => {
  const client = {
    listProjects: jest.fn().mockResolvedValue([
      { id: 'p1', state: 'active' },
      { id: 'p2', state: 'active' },
    ]),
    listPublicPreviewShares: jest.fn().mockResolvedValue([]),
    listProjectLocalPreviewShares: jest.fn().mockResolvedValue([]),
  };
  const { unmount } = renderHook(() => useProjects(client as unknown as VerityClient));
  await waitFor(() => expect(client.listProjectLocalPreviewShares).toHaveBeenCalledTimes(2));
  const signal = client.listPublicPreviewShares.mock.calls[0]![1] as AbortSignal;
  client.listPublicPreviewShares.mockClear();
  client.listProjectLocalPreviewShares.mockClear();
  await act(async () => {
    await Promise.all(
      mockSubscriptions
        .filter(({ filter }) => filter('/projects/p1/public-shares'))
        .map(({ refresh }) => refresh()),
    );
  });
  expect(client.listPublicPreviewShares).toHaveBeenCalledTimes(1);
  expect(client.listPublicPreviewShares).toHaveBeenCalledWith('p1', expect.any(AbortSignal));
  expect(client.listProjectLocalPreviewShares).not.toHaveBeenCalled();
  client.listPublicPreviewShares.mockClear();
  await act(async () => {
    await Promise.all(
      mockSubscriptions.filter(({ filter }) => filter('/projects')).map(({ refresh }) => refresh()),
    );
  });
  expect(client.listProjects).toHaveBeenCalledTimes(2);
  expect(client.listPublicPreviewShares).not.toHaveBeenCalled();
  expect(client.listProjectLocalPreviewShares).not.toHaveBeenCalled();
  unmount();
  expect(mockSubscriptions).toHaveLength(0);
  expect(signal.aborted).toBe(false);
});

it('coalesces invalidations while a share read is queued or in flight', async () => {
  let resolveRead!: (shares: never[]) => void;
  const pending = new Promise<never[]>((resolve) => {
    resolveRead = resolve;
  });
  const client = {
    listProjects: jest.fn().mockResolvedValue([{ id: 'p1', state: 'active' }]),
    listPublicPreviewShares: jest.fn().mockReturnValueOnce(pending).mockResolvedValue([]),
    listProjectLocalPreviewShares: jest.fn().mockResolvedValue([]),
  };
  const { unmount } = renderHook(() => useProjects(client as unknown as VerityClient));
  await waitFor(() => expect(client.listPublicPreviewShares).toHaveBeenCalledTimes(1));
  const subscription = mockSubscriptions.find(({ filter }) =>
    filter('/projects/p1/public-shares'),
  )!;
  await act(async () => {
    await subscription.refresh();
    await subscription.refresh();
  });
  expect(client.listPublicPreviewShares).toHaveBeenCalledTimes(1);
  await act(async () => {
    resolveRead([]);
  });
  await waitFor(() => expect(client.listPublicPreviewShares).toHaveBeenCalledTimes(2));
  unmount();
});

it('keeps existing share reads when project membership changes and aborts removed projects', async () => {
  const client = {
    listProjects: jest.fn().mockResolvedValue([{ id: 'p1', state: 'active' }]),
    listPublicPreviewShares: jest.fn().mockResolvedValue([]),
    listProjectLocalPreviewShares: jest.fn().mockResolvedValue([]),
  };
  const { unmount } = renderHook(() => useProjects(client as unknown as VerityClient));
  await waitFor(() => expect(client.listPublicPreviewShares).toHaveBeenCalledTimes(1));
  const firstSignal = client.listPublicPreviewShares.mock.calls[0]![1] as AbortSignal;
  const refreshList = mockSubscriptions.find(({ filter }) => filter('/projects'))!.refresh;
  client.listProjects.mockResolvedValue([
    { id: 'p1', state: 'active' },
    { id: 'p2', state: 'active' },
  ]);
  await act(async () => {
    await refreshList();
  });
  await waitFor(() => expect(client.listPublicPreviewShares).toHaveBeenCalledTimes(2));
  expect(client.listPublicPreviewShares.mock.calls[1]![0]).toBe('p2');
  expect(client.listProjectLocalPreviewShares).toHaveBeenCalledTimes(2);
  expect(firstSignal.aborted).toBe(false);
  const secondSignal = client.listPublicPreviewShares.mock.calls[1]![1] as AbortSignal;
  client.listProjects.mockResolvedValue([{ id: 'p1', state: 'active' }]);
  await act(async () => {
    await refreshList();
  });
  expect(client.listPublicPreviewShares).toHaveBeenCalledTimes(2);
  expect(client.listProjectLocalPreviewShares).toHaveBeenCalledTimes(2);
  expect(secondSignal.aborted).toBe(false);
  expect(firstSignal.aborted).toBe(false);
  unmount();
});

function previewClient() {
  return {
    observeReads: jest.fn(),
    liveBaseUrl: () => 'https://test.invalid',
    listProjects: jest.fn().mockResolvedValue([{ id: 'p1', state: 'active' }]),
    listPublicPreviewShares: jest.fn().mockResolvedValue([]),
    listProjectLocalPreviewShares: jest.fn().mockResolvedValue([]),
  };
}

it('detaches share watches on blur and reloads both sources on refocus', async () => {
  const client = previewClient();
  const { rerender, unmount } = renderHook(() => useProjects(client as unknown as VerityClient));
  await waitFor(() => expect(client.listProjectLocalPreviewShares).toHaveBeenCalledTimes(1));
  const shareWatches = () =>
    mockSubscriptions.filter(
      ({ filter }) => filter('/projects/p1/public-shares') || filter('/projects/p1/local-shares'),
    );
  expect(shareWatches()).toHaveLength(2);
  await act(async () => {
    mockFocused = false;
    rerender({});
  });
  expect(shareWatches()).toHaveLength(0);
  expect(client.listPublicPreviewShares).toHaveBeenCalledTimes(1);
  await act(async () => {
    mockFocused = true;
    rerender({});
  });
  await waitFor(() => expect(client.listPublicPreviewShares).toHaveBeenCalledTimes(2));
  expect(client.listProjectLocalPreviewShares).toHaveBeenCalledTimes(2);
  expect(shareWatches()).toHaveLength(2);
  unmount();
});

it('catches up previews when live observation is unavailable and explicit refresh reloads both sources', async () => {
  const client = previewClient();
  const { result, rerender, unmount } = renderHook(() =>
    useProjects(client as unknown as VerityClient),
  );
  await waitFor(() => expect(client.listProjectLocalPreviewShares).toHaveBeenCalledTimes(1));
  await act(async () => {
    mockFocused = false;
    rerender({});
  });
  mockConnection.resourceWatching = false;
  await act(async () => {
    mockFocused = true;
    rerender({});
  });
  await waitFor(() => expect(client.listProjectLocalPreviewShares).toHaveBeenCalledTimes(2));
  await act(async () => {
    await result.current.refresh();
  });
  await waitFor(() => expect(client.listProjectLocalPreviewShares).toHaveBeenCalledTimes(3));
  expect(client.listPublicPreviewShares).toHaveBeenCalledTimes(3);
  unmount();
});

it('cancels on background, ignores late results and resumes missing reads', async () => {
  const appStates = new Set<(state: AppStateStatus) => void>();
  const appState = (state: AppStateStatus) => {
    for (const callback of [...appStates]) callback(state);
  };
  const listener = jest
    .spyOn(AppState, 'addEventListener')
    .mockImplementation((_event, callback) => {
      appStates.add(callback);
      return { remove: () => appStates.delete(callback) };
    });
  let finish!: (value: unknown[]) => void;
  const client = previewClient();
  client.listPublicPreviewShares.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const { result, unmount } = renderHook(() => useProjects(client as unknown as VerityClient));
  await waitFor(() => expect(client.listPublicPreviewShares).toHaveBeenCalledTimes(1));
  const signal = client.listPublicPreviewShares.mock.calls[0]![1] as AbortSignal;
  Object.defineProperty(AppState, 'currentState', { configurable: true, value: 'background' });
  await act(async () => {
    appState('background');
  });
  expect(signal.aborted).toBe(true);
  await act(async () => {
    finish([{ sessionId: 'stale', url: 'https://stale.invalid' }]);
  });
  expect(result.current.previewUrls.has('stale')).toBe(false);
  Object.defineProperty(AppState, 'currentState', { configurable: true, value: 'active' });
  await act(async () => {
    appState('active');
  });
  await waitFor(() => expect(client.listPublicPreviewShares).toHaveBeenCalledTimes(2));
  unmount();
  listener.mockRestore();
});

// A project's Work list is its own screen on a phone and reads the previews
// from here; if Home stops publishing them, its markers vanish without error.
it('publishes the previews it finds for the Work list', async () => {
  const client = previewClient();
  client.listPublicPreviewShares.mockResolvedValue([
    {
      sessionId: 'shared',
      targetKind: 'static-folder',
      state: 'active',
      publicOrigin: 'https://shared.invalid',
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    },
  ]);
  const { unmount } = renderHook(() => useProjects(client as unknown as VerityClient));
  const { result } = renderHook(() => useSessionPreviews());
  await waitFor(() => expect(result.current.urls.get('shared')).toBe('https://shared.invalid'));
  expect(result.current.online.has('shared')).toBe(true);
  // Signing out or switching servers unmounts it; the links must not outlive it.
  unmount();
  expect(result.current.urls.size).toBe(0);
});

it('retains cached links while hidden and catches up after discarded watches', async () => {
  const client = previewClient();
  client.listPublicPreviewShares.mockResolvedValue([
    {
      sessionId: 'kept',
      targetKind: 'static-folder',
      state: 'active',
      publicOrigin: 'https://kept.invalid',
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    },
  ]);
  const { result, rerender, unmount } = renderHook(() =>
    useProjects(client as unknown as VerityClient),
  );
  await waitFor(() => expect(result.current.previewUrls.get('kept')).toBe('https://kept.invalid'));
  let finish!: (value: unknown[]) => void;
  client.listPublicPreviewShares.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const subscription = mockSubscriptions.find(({ filter }) =>
    filter('/projects/p1/public-shares'),
  )!;
  await act(async () => {
    await subscription.refresh();
  });
  const signal = client.listPublicPreviewShares.mock.calls[1]![1] as AbortSignal;
  await act(async () => {
    mockFocused = false;
    rerender({});
  });
  expect(signal.aborted).toBe(true);
  expect(result.current.previewUrls.get('kept')).toBe('https://kept.invalid');
  // No hidden share watch remains for reconnect to reactivate.
  await act(async () => {
    await Promise.all(
      mockSubscriptions
        .filter(
          ({ filter }) =>
            filter('/projects/p1/public-shares') || filter('/projects/p1/local-shares'),
        )
        .map(({ refresh }) => refresh()),
    );
    finish([]);
  });
  expect(client.listPublicPreviewShares).toHaveBeenCalledTimes(2);
  expect(mockSubscriptions.some(({ filter }) => filter('/projects/p1/public-shares'))).toBe(false);
  await act(async () => {
    mockFocused = true;
    rerender({});
  });
  await waitFor(() => expect(client.listProjectLocalPreviewShares).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(result.current.previewUrls.get('kept')).toBe('https://kept.invalid'));
  unmount();
});

it('disowns removed-project reads even when cancellation is ignored', async () => {
  let finish!: (value: unknown[]) => void;
  const client = previewClient();
  client.listPublicPreviewShares.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const { result, unmount } = renderHook(() => useProjects(client as unknown as VerityClient));
  await waitFor(() => expect(client.listPublicPreviewShares).toHaveBeenCalledTimes(1));
  const signal = client.listPublicPreviewShares.mock.calls[0]![1] as AbortSignal;
  client.listProjects.mockResolvedValue([]);
  await act(async () => {
    await result.current.refresh();
  });
  expect(signal.aborted).toBe(true);
  await act(async () => {
    finish([
      {
        sessionId: 'removed',
        targetKind: 'static-folder',
        state: 'active',
        publicOrigin: 'https://removed.invalid',
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      },
    ]);
  });
  expect(result.current.previewUrls.has('removed')).toBe(false);
  unmount();
});

describe('project list recovery', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());
  const advance = async (ms = 0) => {
    await act(async () => {
      await jest.advanceTimersByTimeAsync(ms);
    });
  };

  it('distinguishes an unresolved initial list from a successful empty list', async () => {
    let resolve!: (projects: never[]) => void;
    const client = {
      listProjects: jest.fn(
        () =>
          new Promise<never[]>((done) => {
            resolve = done;
          }),
      ),
    };
    const { result, unmount } = renderHook(() => useProjects(client as unknown as VerityClient));
    expect(result.current.listState).toBe('loading');
    await act(async () => {
      resolve([]);
    });
    expect(result.current.listState).toBe('ready');
    expect(result.current.error).toBeUndefined();
    unmount();
  });

  it('retries a failed initial read without live invalidations, backs off and stops after recovery', async () => {
    const client = { listProjects: jest.fn().mockRejectedValue(new Error('offline')) };
    const { result, unmount } = renderHook(() => useProjects(client as unknown as VerityClient));
    await advance();
    expect(result.current.listState).toBe('error');
    for (const delay of [1000, 2000, 4000, 8000, 15000, 15000]) {
      const calls = client.listProjects.mock.calls.length;
      await advance(delay - 1);
      expect(client.listProjects).toHaveBeenCalledTimes(calls);
      await advance(1);
      expect(client.listProjects).toHaveBeenCalledTimes(calls + 1);
    }
    client.listProjects.mockResolvedValue([]);
    await advance(15000);
    expect(result.current.listState).toBe('ready');
    expect(result.current.error).toBeUndefined();
    const calls = client.listProjects.mock.calls.length;
    await advance(60000);
    expect(client.listProjects).toHaveBeenCalledTimes(calls);
    unmount();
  });

  it('keeps the last successful projects and recovers from a failed live refresh', async () => {
    const projects = [{ id: 'p1', state: 'absent' }];
    const client = { listProjects: jest.fn().mockResolvedValue(projects) };
    const { result, unmount } = renderHook(() => useProjects(client as unknown as VerityClient));
    await advance();
    const previous = result.current.projects;
    client.listProjects.mockRejectedValueOnce(new VerityApiError(503, 'temporarily unavailable'));
    await act(async () => {
      await mockSubscriptions.find(({ filter }) => filter('/projects'))!.refresh();
    });
    expect(result.current.projects).toBe(previous);
    expect(result.current.error).toBe('temporarily unavailable');
    expect(result.current.listState).toBe('error');
    await advance(1000);
    expect(result.current.listState).toBe('ready');
    expect(result.current.projects).toEqual(projects);
    unmount();
  });

  it('pauses retries in the background and retries on foreground without navigation', async () => {
    const listeners = new Set<(state: AppStateStatus) => void>();
    jest.spyOn(AppState, 'addEventListener').mockImplementation((_, listener) => {
      listeners.add(listener);
      return { remove: () => listeners.delete(listener) };
    });
    const changeState = async (state: AppStateStatus) => {
      await act(async () => {
        Object.defineProperty(AppState, 'currentState', { configurable: true, value: state });
        for (const listener of [...listeners]) listener(state);
      });
    };
    const client = { listProjects: jest.fn().mockRejectedValue(new Error('offline')) };
    const { result, unmount } = renderHook(() => useProjects(client as unknown as VerityClient));
    await advance();
    await changeState('background');
    await advance(60000);
    expect(client.listProjects).toHaveBeenCalledTimes(1);
    client.listProjects.mockResolvedValue([]);
    await changeState('active');
    expect(client.listProjects).toHaveBeenCalledTimes(2);
    expect(result.current.listState).toBe('ready');
    unmount();
    expect(listeners.size).toBe(0);
  });

  it('cancels scheduled retries on unmount', async () => {
    const client = { listProjects: jest.fn().mockRejectedValue(new Error('offline')) };
    const { unmount } = renderHook(() => useProjects(client as unknown as VerityClient));
    await advance();
    unmount();
    await advance(60000);
    expect(client.listProjects).toHaveBeenCalledTimes(1);
  });

  it('does not schedule retries when an in-flight request fails after unmount', async () => {
    let reject!: (error: Error) => void;
    const client = {
      listProjects: jest.fn(
        () =>
          new Promise((_, fail) => {
            reject = fail;
          }),
      ),
    };
    const { unmount } = renderHook(() => useProjects(client as unknown as VerityClient));
    unmount();
    await act(async () => {
      reject(new Error('offline'));
    });
    await advance(60000);
    expect(client.listProjects).toHaveBeenCalledTimes(1);
  });

  it.each([401, 403])('does not retry authorization failure %i', async (status) => {
    const client = {
      listProjects: jest.fn().mockRejectedValue(new VerityApiError(status, 'Unauthorized')),
    };
    const { result, unmount } = renderHook(() => useProjects(client as unknown as VerityClient));
    await advance();
    expect(result.current.listState).toBe('error');
    await advance(60000);
    expect(client.listProjects).toHaveBeenCalledTimes(1);
    unmount();
  });
});

it('retains refresh and empty preview identities through parent renders and equal publications', async () => {
  const client = previewClient();
  const hook = renderHook(() => useProjects(client as unknown as VerityClient));
  await waitFor(() => expect(client.listProjectLocalPreviewShares).toHaveBeenCalledTimes(1));
  const refresh = hook.result.current.refresh;
  const urls = hook.result.current.previewUrls;
  const publicIds = hook.result.current.publicPreviews;
  hook.rerender({});
  expect(hook.result.current.refresh).toBe(refresh);
  await act(async () => {
    await hook.result.current.refresh();
  });
  expect(hook.result.current.refresh).toBe(refresh);
  expect(hook.result.current.previewUrls).toBe(urls);
  expect(hook.result.current.publicPreviews).toBe(publicIds);
  hook.unmount();
});

it('defers project invalidations and in-flight results while blurred, then catches up once', async () => {
  const client = { listProjects: jest.fn().mockResolvedValue([{ id: 'old', state: 'absent' }]) };
  const hook = renderHook(() => useProjects(client as unknown as VerityClient));
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  const previous = hook.result.current.projects;
  let resolve!: (value: { id: string; state: string }[]) => void;
  client.listProjects.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const subscription = mockSubscriptions.find(({ filter }) => filter('/projects'))!;
  let pending!: Promise<unknown>;
  act(() => {
    pending = subscription.refresh();
  });
  act(() => {
    mockFocused = false;
    hook.rerender({});
  });
  await act(async () => {
    resolve([{ id: 'stale', state: 'absent' }]);
    await pending;
    await subscription.refresh();
    await subscription.refresh();
  });
  expect(client.listProjects).toHaveBeenCalledTimes(2);
  expect(hook.result.current.projects).toBe(previous);
  client.listProjects.mockResolvedValue([{ id: 'fresh', state: 'absent' }]);
  await act(async () => {
    mockFocused = true;
    hook.rerender({});
  });
  expect(client.listProjects).toHaveBeenCalledTimes(3);
  expect(hook.result.current.projects[0]?.id).toBe('fresh');
  hook.unmount();
});

it('defers hidden foreground notifications and refreshes on visible foreground without navigation', async () => {
  const listeners = new Set<(state: AppStateStatus) => void>();
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_, listener) => {
    listeners.add(listener);
    return { remove: () => listeners.delete(listener) };
  });
  const client = { listProjects: jest.fn().mockResolvedValue([]) };
  const hook = renderHook(() => useProjects(client as unknown as VerityClient));
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  const change = async (state: AppStateStatus) => {
    await act(async () => {
      Object.defineProperty(AppState, 'currentState', { configurable: true, value: state });
      for (const listener of [...listeners]) listener(state);
    });
  };
  await change('background');
  await act(async () => {
    await mockSubscriptions.find(({ filter }) => filter('/projects'))!.refresh();
  });
  expect(client.listProjects).toHaveBeenCalledTimes(1);
  await change('active');
  expect(client.listProjects).toHaveBeenCalledTimes(2);
  act(() => {
    mockFocused = false;
    hook.rerender({});
  });
  await change('background');
  await change('active');
  expect(client.listProjects).toHaveBeenCalledTimes(2);
  await act(async () => {
    mockFocused = true;
    hook.rerender({});
  });
  expect(client.listProjects).toHaveBeenCalledTimes(3);
  hook.unmount();
  expect(listeners.size).toBe(0);
});

it('retains equal populated previews but publishes changed links and expiry', async () => {
  const realNow = Date.now;
  const startedAt = realNow();
  let now = startedAt;
  jest.spyOn(Date, 'now').mockImplementation(() => realNow() + now - startedAt);
  const client = previewClient();
  const share = {
    sessionId: 'kept',
    targetKind: 'static-folder',
    state: 'active',
    publicOrigin: 'https://first.invalid',
    expiresAt: new Date(now + 60000).toISOString(),
  };
  client.listPublicPreviewShares.mockResolvedValue([share]);
  const hook = renderHook(() => useProjects(client as unknown as VerityClient));
  await waitFor(() =>
    expect(hook.result.current.previewUrls.get('kept')).toBe('https://first.invalid'),
  );
  const urls = hook.result.current.previewUrls;
  const ids = hook.result.current.publicPreviews;
  const subscription = mockSubscriptions.find(({ filter }) =>
    filter('/projects/p1/public-shares'),
  )!;
  await act(async () => {
    await subscription.refresh();
  });
  await waitFor(() => expect(client.listPublicPreviewShares).toHaveBeenCalledTimes(2));
  // A project refresh synchronously republishes the installed source snapshots.
  await act(async () => {
    await hook.result.current.refresh();
  });
  expect(hook.result.current.previewUrls).toBe(urls);
  expect(hook.result.current.publicPreviews).toBe(ids);
  client.listPublicPreviewShares.mockResolvedValue([
    { ...share, publicOrigin: 'https://changed.invalid' },
  ]);
  await act(async () => {
    await subscription.refresh();
  });
  await waitFor(() =>
    expect(hook.result.current.previewUrls.get('kept')).toBe('https://changed.invalid'),
  );
  expect(hook.result.current.publicPreviews).toBe(ids);
  now += 60001;
  await act(async () => {
    await mockSubscriptions.find(({ filter }) => filter('/projects'))!.refresh();
  });
  expect(hook.result.current.previewUrls.has('kept')).toBe(false);
  expect(hook.result.current.publicPreviews.has('kept')).toBe(false);
  hook.unmount();
});
