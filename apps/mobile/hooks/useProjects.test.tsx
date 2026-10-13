import { act, renderHook, waitFor } from '@testing-library/react-native';
import { AppState, type AppStateStatus } from 'react-native';
import type { VerityClient } from '@verity/mobile';
import { useProjects } from './useProjects';

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

it('keeps preview watchers on blur and refreshes only dirty sources on refocus', async () => {
  const client = previewClient();
  const { rerender, unmount } = renderHook(() => useProjects(client as unknown as VerityClient));
  await waitFor(() => expect(client.listProjectLocalPreviewShares).toHaveBeenCalledTimes(1));
  const subscription = mockSubscriptions.find(({ filter }) =>
    filter('/projects/p1/public-shares'),
  )!;
  await act(async () => {
    mockFocused = false;
    rerender({});
  });
  await act(async () => {
    await subscription.refresh();
    await subscription.refresh();
  });
  expect(client.listPublicPreviewShares).toHaveBeenCalledTimes(1);
  await act(async () => {
    mockFocused = true;
    rerender({});
  });
  await waitFor(() => expect(client.listPublicPreviewShares).toHaveBeenCalledTimes(2));
  expect(client.listProjectLocalPreviewShares).toHaveBeenCalledTimes(1);
  expect(mockSubscriptions).toContain(subscription);
  await act(async () => {
    mockFocused = false;
    rerender({});
  });
  await act(async () => {
    mockFocused = true;
    rerender({});
  });
  expect(client.listPublicPreviewShares).toHaveBeenCalledTimes(2);
  expect(client.listProjectLocalPreviewShares).toHaveBeenCalledTimes(1);
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
  let appState!: (state: AppStateStatus) => void;
  const listener = jest
    .spyOn(AppState, 'addEventListener')
    .mockImplementation((_event, callback) => {
      appState = callback;
      return { remove: jest.fn() };
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

it('retains cached links on blur, aborts an invalidated read and catches up after reconnect', async () => {
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
  // Reconnect invalidates retained resource watchers even while their screen is hidden.
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
