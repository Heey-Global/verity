// Locks the refetch contract the engine picker relies on: opening the picker calls
// `refresh()` (app/session/[id].tsx), so a catalog the server discovers AFTER this
// screen mounted — e.g. Codex models that only surface once the secret store is
// unlocked — must reach the picker on the next open, without a screen remount. The
// hook keeps the previous list visible while the refetch is in flight so the sheet
// never blanks. The @verity/mobile client is faked; only `listModels` is exercised.
import { type VerityClient, type ModelList } from '@verity/mobile';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import { useModels } from './useModels';

function fakeClient(listModels: () => Promise<ModelList>): VerityClient {
  return { listModels } as unknown as VerityClient;
}

describe('useModels', () => {
  it('defers the catalog request until the transcript is ready', async () => {
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
    const { result } = renderHook(() => useModels(fakeClient(listModels), true, 'p/1'));
    await waitFor(() => expect(result.current.allowedAgents).toEqual(['codex']));
    expect(listModels).toHaveBeenCalledWith('p/1');
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
