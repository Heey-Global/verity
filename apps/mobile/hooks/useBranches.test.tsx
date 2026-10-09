import type { BranchList, SessionSummary, VerityClient } from '@verity/mobile';
import { act, renderHook } from '@testing-library/react-native';
import { AppState, type AppStateStatus } from 'react-native';
import { useBranches } from './useBranches';
import { cachedBranches, rememberBranches, seedSessionBranches } from '../lib/branchesPrefetch';

const mockLive = new Set<() => void | Promise<unknown>>();
jest.mock('../lib/liveConnection', () => ({
  subscribeLiveRefresh: (_client: unknown, refresh: () => void | Promise<unknown>) => {
    mockLive.add(refresh);
    return () => mockLive.delete(refresh);
  },
}));
const changed = async () => {
  await act(async () => {
    for (const refresh of mockLive) void refresh();
  });
};

let mockFocused = true;
jest.mock('expo-router', () => ({
  useFocusEffect: (callback: () => (() => void) | undefined) => {
    const React = require('react') as typeof import('react');
    React.useEffect(() => (mockFocused ? callback() : undefined), [callback, mockFocused]);
  },
}));

function branches(phase: 'open' | 'merged' | 'closed' = 'open', pipeline = 'running'): BranchList {
  return {
    current: 'fix/status',
    switchable: [],
    currentPr: 42,
    pullRequest: {
      number: 42,
      title: 'Status',
      url: 'https://github.com/example/repo/pull/42',
      phase,
      headSha: 'abc',
      pipeline: pipeline as NonNullable<BranchList['pullRequest']>['pipeline'],
      checks: { completed: 0, total: 1, successful: 0, failed: 0, pending: 1 },
      mergeable: false,
    },
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const advance = async (ms: number) => {
  await act(async () => jest.advanceTimersByTimeAsync(ms));
};

describe('useBranches live updates', () => {
  let listeners: Set<(state: AppStateStatus) => void>;
  let previousState: AppStateStatus;
  beforeEach(() => {
    mockLive.clear();
    jest.useFakeTimers();
    mockFocused = true;
    previousState = AppState.currentState;
    AppState.currentState = 'active';
    listeners = new Set();
    jest.spyOn(AppState, 'addEventListener').mockImplementation((_, listener) => {
      listeners.add(listener);
      return {
        remove: () => {
          listeners.delete(listener);
        },
      };
    });
  });
  afterEach(() => {
    jest.restoreAllMocks();
    AppState.currentState = previousState;
    jest.useRealTimers();
  });

  it('paints a known PR synchronously and revalidates without hiding it', async () => {
    const slow = deferred<BranchList>();
    const getBranches = jest.fn().mockReturnValue(slow.promise);
    const client = { getBranches } as unknown as VerityClient;
    rememberBranches(client, 's', branches());
    const hook = renderHook(() => useBranches(client, 's'));
    expect(hook.result.current.pullRequest?.number).toBe(42);
    expect(hook.result.current.loading).toBe(false);
    await act(async () => slow.resolve(branches('closed', 'success')));
    expect(hook.result.current.pullRequest?.phase).toBe('closed');
  });

  it('paints a PR carried by the overview before a slow opening request resolves', async () => {
    const slow = deferred<BranchList>();
    const client = {
      getBranches: jest.fn().mockReturnValue(slow.promise),
    } as unknown as VerityClient;
    const known = branches();
    seedSessionBranches(client, {
      sessionId: 's',
      branch: known.current,
      pullRequest: known.pullRequest,
    } as SessionSummary);
    const hook = renderHook(() => useBranches(client, 's'));
    expect(hook.result.current.pullRequest).toEqual(known.pullRequest);
    await act(async () => slow.resolve(branches('merged', 'success')));
    expect(hook.result.current.pullRequest?.phase).toBe('merged');
    hook.unmount();
    const reopened = renderHook(() => useBranches(client, 's'));
    expect(reopened.result.current.pullRequest?.phase).toBe('merged');
    reopened.unmount();
  });

  it('never carries cached PR state into a different session or client', async () => {
    const slow = deferred<BranchList>();
    const client = {
      getBranches: jest.fn().mockReturnValue(slow.promise),
    } as unknown as VerityClient;
    rememberBranches(client, 's', branches());
    const hook = renderHook<ReturnType<typeof useBranches>, { id: string; api: VerityClient }>(
      ({ id, api }) => useBranches(api, id),
      {
        initialProps: { id: 's', api: client },
      },
    );
    expect(hook.result.current.currentPr).toBe(42);
    hook.rerender({ id: 'other', api: client });
    expect(hook.result.current.currentPr).toBeNull();
    const other = {
      getBranches: jest.fn().mockReturnValue(slow.promise),
    } as unknown as VerityClient;
    hook.rerender({ id: 's', api: other });
    expect(hook.result.current.currentPr).toBeNull();
    hook.unmount();
    await act(async () => slow.resolve(branches()));
  });

  it('updates cached merge state immediately while revalidation is pending', async () => {
    const slow = deferred<BranchList>();
    const client = {
      getBranches: jest.fn().mockReturnValue(slow.promise),
      mergePullRequest: jest.fn().mockResolvedValue(undefined),
    } as unknown as VerityClient;
    rememberBranches(client, 's', branches());
    const hook = renderHook(() => useBranches(client, 's'));
    let merged!: ReturnType<typeof hook.result.current.mergePullRequest>;
    act(() => {
      merged = hook.result.current.mergePullRequest(42);
    });
    await advance(0);
    expect(cachedBranches(client, 's')?.pullRequest?.phase).toBe('merged');
    await act(async () => {
      slow.resolve(branches('merged', 'success'));
      await merged;
    });
  });

  it('makes live refreshes silent and preserves an in-flight response', async () => {
    const slow = deferred<BranchList>();
    const getBranches = jest.fn().mockImplementation(() => Promise.resolve(branches()));
    const client = { getBranches } as unknown as VerityClient;
    const hook = renderHook(() => useBranches(client, 's'));
    await advance(0);
    await advance(3_000);
    await act(async () => hook.result.current.refresh());
    getBranches.mockReturnValueOnce(slow.promise);
    await changed();
    expect(getBranches).toHaveBeenCalledTimes(3);
    expect(hook.result.current.loading).toBe(false);
    await advance(15_000);
    expect(getBranches).toHaveBeenCalledTimes(3);
    await act(async () => slow.resolve(branches()));
  });

  it('queues only one explicit followup behind an in-flight poll', async () => {
    const slow = deferred<BranchList>();
    const getBranches = jest.fn().mockResolvedValue(branches()).mockReturnValueOnce(slow.promise);
    const client = { getBranches } as unknown as VerityClient;
    const hook = renderHook(() => useBranches(client, 's'));
    act(() => {
      hook.result.current.refresh();
      hook.result.current.refresh();
    });
    await advance(10_000);
    expect(getBranches).toHaveBeenCalledTimes(1);
    await act(async () => slow.resolve(branches()));
    expect(getBranches).toHaveBeenCalledTimes(2);
  });

  it('reads again after a branch mutation even when an older poll is pending', async () => {
    const old = deferred<BranchList>();
    const getBranches = jest.fn().mockResolvedValue(branches());
    const switchBranch = jest.fn().mockResolvedValue(undefined);
    const client = { getBranches, switchBranch } as unknown as VerityClient;
    const hook = renderHook(() => useBranches(client, 's'));
    await advance(0);
    getBranches.mockReturnValueOnce(old.promise);
    await changed();
    let switched!: ReturnType<typeof hook.result.current.switchTo>;
    act(() => {
      switched = hook.result.current.switchTo({ branch: 'fix/new' });
    });
    await advance(0);
    getBranches.mockResolvedValue({ ...branches(), current: 'fix/new' });
    await act(async () => {
      old.resolve(branches());
      await switched;
    });
    expect(getBranches).toHaveBeenCalledTimes(3);
    expect(hook.result.current.current).toBe('fix/new');
  });

  it.each(['open', 'merged', 'closed'] as const)(
    'refreshes %s PRs on hints without periodic HTTP requests',
    async (phase) => {
      const getBranches = jest.fn().mockResolvedValue(branches(phase));
      const client = { getBranches } as unknown as VerityClient;
      renderHook(() => useBranches(client, 's'));
      await advance(0);
      await advance(60_000);
      expect(getBranches).toHaveBeenCalledTimes(1);
      await changed();
      expect(getBranches).toHaveBeenCalledTimes(2);
    },
  );

  it('ignores an in-flight background response and pauses until foreground', async () => {
    const slow = deferred<BranchList>();
    const getBranches = jest.fn().mockResolvedValue(branches()).mockReturnValueOnce(slow.promise);
    const client = { getBranches } as unknown as VerityClient;
    const hook = renderHook(() => useBranches(client, 's'));
    act(() => listeners.forEach((listener) => listener('background')));
    await act(async () => slow.resolve(branches()));
    expect(hook.result.current.current).toBeUndefined();
    await advance(60_000);
    expect(getBranches).toHaveBeenCalledTimes(1);
    act(() => listeners.forEach((listener) => listener('active')));
    await advance(0);
    expect(getBranches).toHaveBeenCalledTimes(2);
    mockFocused = false;
    hook.rerender({});
    await advance(60_000);
    expect(getBranches).toHaveBeenCalledTimes(2);
  });
});
