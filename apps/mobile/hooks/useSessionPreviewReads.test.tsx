import { act, renderHook, waitFor } from '@testing-library/react-native';
import type { VerityClient } from '@verity/mobile';
import { useSessionPreviewReads } from './useSessionPreviewReads';
import { subscribeLiveRefresh } from '../lib/liveConnection';

jest.mock('../lib/liveConnection', () => ({
  subscribeLiveRefresh: jest.fn(() => jest.fn()),
}));

beforeEach(() => jest.clearAllMocks());

function deferredRead() {
  const pending: { resolve: (value: unknown[]) => void; reject: (error: Error) => void }[] = [];
  const read = jest.fn(
    (_id: string, _signal: AbortSignal) =>
      new Promise<unknown[]>((resolve, reject) => pending.push({ resolve, reject })),
  );
  return { read, pending };
}

function setup() {
  const managed = deferredRead();
  const dev = deferredRead();
  const publicShares = deferredRead();
  const local = deferredRead();
  const client = {
    listManagedDevServers: managed.read,
    listSessionDevServers: dev.read,
    listPublicPreviewShares: publicShares.read,
    listSessionLocalPreviewShares: local.read,
  };
  const hook = renderHook(
    ({
      projectId,
      sessionId,
      completedServerTools,
      loaded,
    }: {
      projectId: string;
      sessionId: string;
      completedServerTools: number;
      loaded: boolean;
    }) =>
      useSessionPreviewReads({
        client: client as unknown as VerityClient,
        projectId,
        sessionId,
        loaded,
        completedServerTools,
        devServers: undefined,
      }),
    {
      initialProps: {
        projectId: 'p1',
        sessionId: 's1',
        completedServerTools: 0,
        loaded: true,
      },
    },
  );
  return { ...hook, managed, dev, publicShares, local };
}

function liveRefresh(path: string): () => void | Promise<unknown> {
  const subscription = jest
    .mocked(subscribeLiveRefresh)
    .mock.calls.find(([, , filter]) => filter?.(path));
  expect(subscription).toBeDefined();
  return subscription![1];
}

const activePublic = () => [
  {
    targetKind: 'static-folder',
    sessionId: 's1',
    state: 'active',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  },
];
const activeLocal = () => [{ expiresAt: new Date(Date.now() + 60_000) }];

it('refreshes only the invalidated source and publishes shares without waiting for siblings', async () => {
  const { result, publicShares, local, dev, managed } = setup();
  await act(async () => publicShares.pending[0]!.resolve(activePublic()));
  expect(result.current.hasActiveStaticPreview).toBe(true);
  const publicRefresh = liveRefresh('/projects/p1/public-shares');
  let refreshed: void | Promise<unknown>;
  act(() => {
    refreshed = publicRefresh();
  });
  expect(publicShares.read).toHaveBeenCalledTimes(2);
  for (const sibling of [local, dev, managed]) {
    expect(sibling.read).toHaveBeenCalledTimes(1);
    expect(sibling.read.mock.calls[0]![1].aborted).toBe(false);
  }
  await act(async () => {
    local.pending[0]!.resolve(activeLocal());
    publicShares.pending[1]!.reject(new Error('offline'));
    await refreshed;
  });
  expect(result.current.hasActiveStaticPreview).toBe(true);
  for (const path of [
    '/sessions/s1/local-shares',
    '/sessions/s1/dev-servers',
    '/sessions/s1/managed-dev-servers',
  ]) {
    expect(liveRefresh(path)).not.toBe(publicRefresh);
  }
});

it.each([
  ['local', '/sessions/s1/local-shares'],
  ['dev', '/sessions/s1/dev-servers'],
  ['managed', '/sessions/s1/managed-dev-servers'],
] as const)('keeps a %s invalidation isolated from the other reads', async (source, path) => {
  const sources = setup();
  const readers = {
    publicShares: sources.publicShares,
    local: sources.local,
    dev: sources.dev,
    managed: sources.managed,
  };
  await act(async () => {
    for (const reader of Object.values(readers)) reader.pending[0]!.resolve([]);
  });
  act(() => void liveRefresh(path)());
  for (const [name, reader] of Object.entries(readers)) {
    expect(reader.read).toHaveBeenCalledTimes(name === source ? 2 : 1);
  }
});

it('returns pending promises, prevents overlap and retains one trailing read per busy source', async () => {
  const { publicShares, result, local, dev } = setup();
  const refreshPublic = liveRefresh('/projects/p1/public-shares');
  let completed = false;
  let completion: Promise<unknown>;
  act(() => {
    completion = Promise.resolve(refreshPublic()).then(() => {
      completed = true;
    });
    void refreshPublic();
    void result.current.refreshStaticPreview();
  });
  expect(publicShares.read).toHaveBeenCalledTimes(1);
  expect(local.read).toHaveBeenCalledTimes(1);
  expect(dev.read).toHaveBeenCalledTimes(1);
  await act(async () => publicShares.pending[0]!.resolve([]));
  expect(completed).toBe(false);
  expect(publicShares.read).toHaveBeenCalledTimes(2);
  expect(publicShares.read.mock.calls[0]![1].aborted).toBe(false);
  await act(async () => {
    publicShares.pending[1]!.resolve(activePublic());
    await completion;
  });
  expect(completed).toBe(true);
  expect(publicShares.read).toHaveBeenCalledTimes(2);
  expect(result.current.hasActiveStaticPreview).toBe(true);
});

it('aborts project reads on project change and rejects old results without clearing managed servers', async () => {
  const { result, rerender, managed, publicShares, local, dev } = setup();
  await act(async () => managed.pending[0]!.resolve([{ instance: { id: 'managed' } }]));
  rerender({ projectId: 'p2', sessionId: 's1', completedServerTools: 0, loaded: true });
  for (const source of [publicShares, local, dev]) {
    expect(source.read.mock.calls[0]![1].aborted).toBe(true);
    expect(source.read).toHaveBeenCalledTimes(2);
  }
  expect(managed.read).toHaveBeenCalledTimes(1);
  expect(result.current.managedByInstance.has('managed')).toBe(true);
  await act(async () => {
    publicShares.pending[0]!.resolve(activePublic());
    local.pending[0]!.resolve(activeLocal());
    dev.pending[0]!.resolve([{ port: 1234 }]);
  });
  expect(result.current.hasActiveStaticPreview).toBe(false);
  expect(result.current.hasRunningDevServer).toBe(false);
  await act(async () => local.pending[1]!.resolve(activeLocal()));
  expect(result.current.hasActiveStaticPreview).toBe(true);
});

it('coalesces managed-server tool updates and stops queued work when the source is disabled', async () => {
  const { rerender, managed, publicShares, local, dev } = setup();
  rerender({ projectId: 'p1', sessionId: 's1', completedServerTools: 1, loaded: true });
  rerender({ projectId: 'p1', sessionId: 's1', completedServerTools: 2, loaded: true });
  expect(managed.read).toHaveBeenCalledTimes(1);
  await act(async () => managed.pending[0]!.resolve([]));
  expect(managed.read).toHaveBeenCalledTimes(2);
  act(() => void liveRefresh('/projects/p1/public-shares')());
  rerender({ projectId: 'p1', sessionId: 's1', completedServerTools: 2, loaded: false });
  for (const source of [publicShares, local, dev]) {
    expect(source.read.mock.calls[0]![1].aborted).toBe(true);
  }
  await act(async () => publicShares.pending[0]!.resolve(activePublic()));
  expect(publicShares.read).toHaveBeenCalledTimes(1);
});

it('does not carry unsupported detection or stale reads to a replacement client', async () => {
  const firstPublic = deferredRead();
  const first = {
    listSessionDevServers: jest.fn(async () => null),
    listPublicPreviewShares: firstPublic.read,
  };
  const second = {
    listSessionDevServers: jest.fn(async () => [{ port: 1234 }]),
    listPublicPreviewShares: jest.fn(async () => []),
  };
  const { result, rerender } = renderHook(
    ({ client }: { client: VerityClient }) =>
      useSessionPreviewReads({
        client,
        sessionId: 's1',
        projectId: 'p1',
        loaded: true,
        completedServerTools: 0,
        devServers: undefined,
      }),
    { initialProps: { client: first as unknown as VerityClient } },
  );
  await act(async () => undefined);
  await act(async () => liveRefresh('/sessions/s1/dev-servers')());
  expect(first.listSessionDevServers).toHaveBeenCalledTimes(1);
  rerender({ client: second as unknown as VerityClient });
  await act(async () => firstPublic.pending[0]!.resolve(activePublic()));
  expect(firstPublic.read.mock.calls[0]![1].aborted).toBe(true);
  expect(second.listSessionDevServers).toHaveBeenCalledTimes(1);
  expect(result.current.hasRunningDevServer).toBe(true);
  expect(result.current.hasActiveStaticPreview).toBe(false);
});

it('aborts actual preview and managed requests on session switch and unmount, ignoring stale results', async () => {
  const resolves: ((value: unknown[]) => void)[] = [];
  const read = () => new Promise<unknown[]>((resolve) => resolves.push(resolve));
  const client = {
    listManagedDevServers: jest.fn(read),
    listSessionDevServers: jest.fn(read),
    listPublicPreviewShares: jest.fn(read),
    listSessionLocalPreviewShares: jest.fn(read),
  };
  const options = {
    client: client as unknown as VerityClient,
    projectId: 'p1',
    loaded: true,
    completedServerTools: 0,
    devServers: undefined,
  };
  const { result, rerender, unmount } = renderHook(
    ({ sessionId }: { sessionId: string }) => useSessionPreviewReads({ ...options, sessionId }),
    { initialProps: { sessionId: 's1' } },
  );
  const methods = [
    client.listManagedDevServers,
    client.listSessionDevServers,
    client.listPublicPreviewShares,
    client.listSessionLocalPreviewShares,
  ];
  for (const method of methods) expect(method).toHaveBeenCalledTimes(1);
  const firstSignals = methods.map(
    (method) => (method.mock.calls[0] as unknown as [string, AbortSignal])[1],
  );
  rerender({ sessionId: 's2' });
  for (const signal of firstSignals) expect(signal.aborted).toBe(true);
  await act(async () => {
    resolves[0]!([{ instance: { id: 'stale' } }]);
    resolves[1]!([{ port: 1234 }]);
    resolves[2]!([
      {
        targetKind: 'static-folder',
        sessionId: 's1',
        state: 'active',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    ]);
    resolves[3]!([{ expiresAt: new Date(Date.now() + 60_000) }]);
  });
  expect(result.current.managedByInstance.size).toBe(0);
  expect(result.current.hasRunningDevServer).toBe(false);
  expect(result.current.hasActiveStaticPreview).toBe(false);
  await act(async () => {
    resolves[4]!([{ instance: { id: 'current' } }]);
    resolves[5]!([]);
    resolves[6]!([]);
    resolves[7]!([]);
  });
  await waitFor(() => expect(result.current.managedByInstance.has('current')).toBe(true));
  const secondSignals = methods.map(
    (method) => (method.mock.calls[1] as unknown as [string, AbortSignal])[1],
  );
  unmount();
  for (const signal of secondSignals) expect(signal.aborted).toBe(true);
});
