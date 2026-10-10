import { act, renderHook, waitFor } from '@testing-library/react-native';
import type { VerityClient } from '@verity/mobile';
import { useProjects } from './useProjects';

const mockSubscriptions: { refresh: () => Promise<unknown>; filter: (path: string) => boolean }[] =
  [];
jest.mock('../lib/liveConnection', () => ({
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
  useFocusEffect: (callback: () => void) => require('react').useEffect(callback, [callback]),
}));

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
  expect(signal.aborted).toBe(true);
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
  expect(secondSignal.aborted).toBe(true);
  expect(firstSignal.aborted).toBe(false);
  unmount();
});
