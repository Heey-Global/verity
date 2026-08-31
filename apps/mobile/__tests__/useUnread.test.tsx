// Concurrency-sensitive glue in the useUnread hook (#387): the optimistic override,
// the sentRef dedup gate (the split-pane auto-mark effect calls markSeen for the open
// session on EVERY 2s poll), the PATCH-failure rollback, and the reconcile-on-poll
// that hands control back to the server value. The pure compare/advance/reconcile
// logic is unit-tested in packages/mobile (unread.test.ts); this pins the wiring.
import type { VerityClient, SessionSummary } from '@verity/mobile';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import { useUnread } from '../hooks/useUnread';

const ZERO_USAGE = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  turns: 0,
};

function session(
  id: string,
  eventCount: number,
  lastSeenEventCount: number | null,
): SessionSummary {
  return {
    sessionId: id,
    worktree: `/wt/${id}`,
    model: 'm',
    name: null,
    status: 'idle',
    usage: ZERO_USAGE,
    eventCount,
    lastSeenEventCount,
  };
}

/** A fake client whose setSessionSeen resolves (or rejects) on demand. */
function fakeClient(impl: (id: string, eventCount: number) => Promise<unknown>) {
  const setSessionSeen = jest.fn(impl);
  return { client: { setSessionSeen } as unknown as VerityClient, setSessionSeen };
}

describe('useUnread', () => {
  it('clears the dot optimistically and PATCHes the seen count', async () => {
    const { client, setSessionSeen } = fakeClient((id, n) =>
      Promise.resolve({ sessionId: id, lastSeenEventCount: n }),
    );
    const sessions = [session('a', 10, 5)]; // eventCount 10 > seen 5 → unread
    const { result } = renderHook(() => useUnread(client, sessions));
    expect(result.current.unread.has('a')).toBe(true);

    act(() => result.current.markSeen('a', 10));

    expect(result.current.unread.has('a')).toBe(false); // override cleared it at once
    expect(setSessionSeen).toHaveBeenCalledWith('a', 10);
    await waitFor(() => expect(setSessionSeen).toHaveBeenCalledTimes(1));
  });

  it('does not re-PATCH an unchanged mark (the 2s auto-mark gate)', async () => {
    const { client, setSessionSeen } = fakeClient((id, n) =>
      Promise.resolve({ sessionId: id, lastSeenEventCount: n }),
    );
    const { result } = renderHook(() => useUnread(client, [session('a', 10, 5)]));

    act(() => result.current.markSeen('a', 10));
    act(() => result.current.markSeen('a', 10)); // same count → skipped
    act(() => result.current.markSeen('a', 8)); // older count → skipped

    expect(setSessionSeen).toHaveBeenCalledTimes(1);
  });

  it('re-PATCHes once new activity advances the count', async () => {
    const { client, setSessionSeen } = fakeClient((id, n) =>
      Promise.resolve({ sessionId: id, lastSeenEventCount: n }),
    );
    const { result } = renderHook(() => useUnread(client, [session('a', 10, 5)]));

    act(() => result.current.markSeen('a', 10));
    act(() => result.current.markSeen('a', 14)); // new events → fresh write

    expect(setSessionSeen).toHaveBeenNthCalledWith(1, 'a', 10);
    expect(setSessionSeen).toHaveBeenNthCalledWith(2, 'a', 14);
  });

  it('rolls the dot back when the write fails', async () => {
    const { client } = fakeClient(() => Promise.reject(new Error('offline')));
    const { result } = renderHook(() => useUnread(client, [session('a', 10, 5)]));

    act(() => result.current.markSeen('a', 10));
    expect(result.current.unread.has('a')).toBe(false); // optimistic clear

    await waitFor(() => expect(result.current.unread.has('a')).toBe(true)); // rolled back
  });

  it('drops the override once the polled server mark catches up', async () => {
    const { client } = fakeClient((id, n) =>
      Promise.resolve({ sessionId: id, lastSeenEventCount: n }),
    );
    const { result, rerender } = renderHook(
      ({ sessions }: { sessions: SessionSummary[] }) => useUnread(client, sessions),
      { initialProps: { sessions: [session('a', 10, 5)] } },
    );

    act(() => result.current.markSeen('a', 10));
    // Server confirms the mark on the next poll; the override is now redundant, and a
    // freshly-arrived event (eventCount 12 > server mark 10) must read as unread again.
    await act(async () => {
      rerender({ sessions: [session('a', 12, 10)] });
    });

    expect(result.current.unread.has('a')).toBe(true);
  });
});
