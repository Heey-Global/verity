import { act, renderHook, waitFor } from '@testing-library/react-native';
import type { VerityClient } from '@verity/mobile';
import { useSessionPreviewReads } from './useSessionPreviewReads';

jest.mock('../lib/liveConnection', () => ({ subscribeLiveRefresh: () => () => undefined }));

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
