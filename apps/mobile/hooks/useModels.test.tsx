// Catalog reads follow picker demand; explicit refresh also supports other consumers.
// Existing results stay visible while a fresh catalog is loading.
import { type VerityClient, type ModelList } from '@verity/mobile';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import { useModels } from './useModels';

function fakeClient(listModels: () => Promise<ModelList>): VerityClient {
  return { listModels } as unknown as VerityClient;
}

describe('useModels', () => {
  it('defers the catalog request until enabled', async () => {
    const listModels = jest.fn().mockResolvedValue({ models: ['codex/default'] });
    const client = fakeClient(listModels);
    const { result, rerender } = renderHook(
      ({ ready }: { ready: boolean }) => useModels(client, ready),
      {
        initialProps: { ready: false },
      },
    );
    // A request here silently competes with the history fetch for the transport.
    expect(listModels).not.toHaveBeenCalled();
    rerender({ ready: true });
    await waitFor(() => expect(result.current.models).toEqual(['codex/default']));
    expect(listModels).toHaveBeenCalledTimes(1);
  });

  // Without the project the session picker offers agents its project turned off,
  // and every pick would be refused by the server.
  it('asks for the project-narrowed list and surfaces its allowed agents', async () => {
    const listModels = jest
      .fn()
      .mockResolvedValue({ models: ['codex/gpt-5.6-sol'], allowedAgents: ['codex'] });
    const client = fakeClient(listModels);
    const { result } = renderHook(() => useModels(client, true, 'p/1'));
    await waitFor(() => expect(result.current.allowedAgents).toEqual(['codex']));
    expect(listModels).toHaveBeenCalledWith('p/1', expect.any(AbortSignal));
  });

  it('re-fetches /models on refresh so a later-discovered catalog surfaces', async () => {
    const listModels = jest
      .fn<Promise<ModelList>, []>()
      .mockResolvedValueOnce({ models: ['codex/default'], default: 'codex/default' })
      .mockResolvedValueOnce({
        models: ['codex/default', 'codex/gpt-5.6-sol'],
        modelOrder: ['codex/gpt-5.6-sol', 'codex/default'],
        moreModels: ['codex/default'],
        default: 'codex/default',
      });
    // A stable client reference so the hook's load effect fires once on mount and only
    // re-runs on an explicit refresh() — mirrors the memoized client in the screen.
    const client = fakeClient(listModels);
    const { result } = renderHook(() => useModels(client));

    await waitFor(() => expect(result.current.models).toEqual(['codex/default']));
    expect(listModels).toHaveBeenCalledTimes(1);

    act(() => result.current.refresh());
    await waitFor(() =>
      expect(result.current.models).toEqual(['codex/default', 'codex/gpt-5.6-sol']),
    );
    expect(result.current.moreModels).toEqual(['codex/default']);
    expect(result.current.modelOrder).toEqual(['codex/gpt-5.6-sol', 'codex/default']);
    expect(listModels).toHaveBeenCalledTimes(2);
  });
});

it('loads only on demand, shares concurrent picker opens, and cancels stale project reads', async () => {
  let resolve!: (value: ModelList) => void;
  const listModels = jest.fn(
    (_project?: string, _signal?: AbortSignal) =>
      new Promise<ModelList>((done) => {
        resolve = done;
      }),
  );
  const client = fakeClient(listModels);
  const { result, rerender } = renderHook(
    ({ project }: { project: string }) => useModels(client, false, project),
    {
      initialProps: { project: 'one' },
    },
  );
  expect(listModels).not.toHaveBeenCalled();
  act(() => {
    result.current.refresh();
    result.current.refresh();
  });
  expect(listModels).toHaveBeenCalledTimes(1);
  const signal = listModels.mock.calls[0]![1] as AbortSignal;
  rerender({ project: 'two' });
  expect(signal.aborted).toBe(true);
  await act(async () => resolve({ models: ['old'] }));
  expect(result.current.models).toEqual([]);
  act(() => result.current.refresh());
  expect(listModels).toHaveBeenLastCalledWith('two', expect.any(AbortSignal));
});

it('loads on picker visibility and replaces an unscoped read when the project arrives', async () => {
  const listModels = jest.fn(
    (_project?: string, _signal?: AbortSignal) => new Promise<ModelList>(() => {}),
  );
  const client = fakeClient(listModels);
  const hook = renderHook(
    ({ open, project }: { open: boolean; project: string | null }) =>
      useModels(client, open, project),
    { initialProps: { open: false, project: null } },
  );
  expect(listModels).not.toHaveBeenCalled();
  hook.rerender({ open: true, project: null });
  expect(listModels).toHaveBeenCalledTimes(1);
  const first = listModels.mock.calls[0]![1]!;
  hook.rerender({ open: true, project: 'project' });
  expect(first.aborted).toBe(true);
  expect(listModels).toHaveBeenCalledTimes(2);
  expect(listModels).toHaveBeenLastCalledWith('project', expect.any(AbortSignal));
  hook.rerender({ open: false, project: 'project' });
  expect(listModels.mock.calls[1]![1]!.aborted).toBe(true);
});
