import { act, renderHook, waitFor } from '@testing-library/react-native';
import { AppState } from 'react-native';
import type { BranchList, LiveTopicSink, SessionSummary, VerityClient } from '@verity/mobile';
import { useBranches } from './useBranches';
import { prefetchBranches } from '../lib/branchesPrefetch';
import { useOverviewStore } from '../lib/overviewTopics';

const BASE = 'https://core.example';
const mockSinks = new Map<string, LiveTopicSink>();
jest.mock('../lib/client', () => ({ getVerityBaseUrl: () => 'https://core.example' }));
jest.mock('../lib/liveConnection', () => ({
  subscribeLiveRefresh: () => () => undefined,
  liveConnectionFor: () => ({
    subscribeTopic: (topic: string, sink: LiveTopicSink) => {
      mockSinks.set(topic, sink);
      return () => mockSinks.delete(topic);
    },
  }),
}));
jest.mock('expo-router', () => ({
  useFocusEffect: (callback: () => (() => void) | undefined) =>
    require('react').useEffect(() => callback(), [callback]),
}));

type Pr = NonNullable<BranchList['pullRequest']>;
function pr(number: number, pipeline: Pr['pipeline'] = 'running'): Pr {
  return {
    number,
    title: 'Status',
    url: `https://github.com/example/repo/pull/${number}`,
    phase: 'open',
    pipeline,
    checks: { completed: 0, total: 1, successful: 0, failed: 0, pending: 1 },
    mergeable: null,
  };
}
const branches = (pullRequest: Pr | null): BranchList => ({
  current: 'fix/status',
  switchable: [],
  currentPr: pullRequest?.number ?? null,
  pullRequest,
});
const session = { sessionId: 's1', projectId: 'p1' } as SessionSummary;

beforeEach(() => {
  jest.spyOn(AppState, 'addEventListener').mockReturnValue({ remove: jest.fn() });
  Object.defineProperty(AppState, 'currentState', { configurable: true, value: 'active' });
  mockSinks.clear();
});
afterEach(() => jest.restoreAllMocks());

/** Home's list holds the session, as when a session is opened from it. */
function withListedSession() {
  const view = renderHook(() => useOverviewStore(BASE));
  act(() => {
    view.result.current.applySessions(view.result.current.beginRead(), [session], {
      covers: () => true,
    });
  });
  return view;
}

describe('useBranches with the shared overview store', () => {
  it('shows a pull request status from an event without reading', async () => {
    const shared = withListedSession();
    const getBranches = jest.fn().mockResolvedValue(branches(pr(42)));
    const client = { getBranches } as unknown as VerityClient;
    const { result, unmount } = renderHook(() => useBranches(client, 's1'));
    await waitFor(() => expect(result.current.pullRequest?.number).toBe(42));
    await waitFor(() => expect(mockSinks.has('project:p1')).toBe(true));
    const reads = getBranches.mock.calls.length;
    act(() =>
      mockSinks.get('project:p1')!.event({
        t: 'pr.status',
        sessionId: 's1',
        rev: 1,
        pr: { ...pr(42, 'success'), checks: { ...pr(42).checks, completed: 1, successful: 1 } },
      }),
    );
    expect(result.current.pullRequest?.pipeline).toBe('success');
    expect(getBranches).toHaveBeenCalledTimes(reads);
    unmount();
    shared.unmount();
  });

  // Home's markers read the store; the branch read is the freshest status.
  it('puts its read status in the store for the other views', async () => {
    const shared = withListedSession();
    const getBranches = jest.fn().mockResolvedValue(branches(pr(42, 'failure')));
    const client = { getBranches } as unknown as VerityClient;
    const { unmount } = renderHook(() => useBranches(client, 's1'));
    await waitFor(() => expect(shared.result.current.session('s1')?.pr?.pipeline).toBe('failure'));
    unmount();
    shared.unmount();
  });

  it('reads its branches again when the store names another pull request', async () => {
    const shared = withListedSession();
    const getBranches = jest
      .fn()
      .mockResolvedValueOnce(branches(pr(42)))
      .mockResolvedValue(branches(pr(43)));
    const client = { getBranches } as unknown as VerityClient;
    const { result, unmount } = renderHook(() => useBranches(client, 's1'));
    await waitFor(() => expect(result.current.pullRequest?.number).toBe(42));
    await waitFor(() => expect(mockSinks.has('project:p1')).toBe(true));
    act(() =>
      mockSinks.get('project:p1')!.event({ t: 'pr.status', sessionId: 's1', rev: 1, pr: pr(43) }),
    );
    await waitFor(() => expect(result.current.currentPr).toBe(43));
    expect(getBranches).toHaveBeenCalledTimes(2);
    unmount();
    shared.unmount();
  });

  // Opening a session from Home prefetches its branches. Neither the prefetch
  // nor the store's copy is known to be newer, so a read of its own decides.
  it('reads again when a prefetch and the store disagree, and once when they agree', async () => {
    const shared = withListedSession();
    const store = shared.result.current;
    act(() => {
      store.applySessions(store.beginRead(), [{ ...session, pullRequest: pr(42, 'success') }], {
        covers: (s) => s.sessionId === 's1',
      });
    });
    const getBranches = jest
      .fn()
      .mockResolvedValueOnce(branches(pr(42, 'running')))
      .mockResolvedValue(branches(pr(42, 'failure')));
    const client = { getBranches } as unknown as VerityClient;
    prefetchBranches(client, 's1');
    const { result, unmount } = renderHook(() => useBranches(client, 's1'));
    await waitFor(() => expect(getBranches).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.pullRequest?.pipeline).toBe('failure'));
    expect(store.session('s1')?.pullRequest?.pipeline).toBe('failure');
    unmount();

    // Agreeing: the store speaks, without another read.
    const agreeing = jest.fn().mockResolvedValue(branches(pr(42, 'failure')));
    const other = { getBranches: agreeing } as unknown as VerityClient;
    prefetchBranches(other, 's1');
    const second = renderHook(() => useBranches(other, 's1'));
    await waitFor(() => expect(second.result.current.loading).toBe(false));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(agreeing).toHaveBeenCalledTimes(1);
    second.unmount();
    shared.unmount();
  });

  it('reads once for another pull request, however often its status changes', async () => {
    const shared = withListedSession();
    // The branch read keeps naming PR 42 while events name PR 43.
    const getBranches = jest.fn().mockResolvedValue(branches(pr(42)));
    const client = { getBranches } as unknown as VerityClient;
    const { unmount } = renderHook(() => useBranches(client, 's1'));
    await waitFor(() => expect(mockSinks.has('project:p1')).toBe(true));
    await waitFor(() => expect(getBranches).toHaveBeenCalledTimes(1));
    for (const [rev, pipeline] of [
      [1, 'running'],
      [2, 'success'],
      [3, 'failure'],
    ] as const)
      act(() =>
        mockSinks
          .get('project:p1')!
          .event({ t: 'pr.status', sessionId: 's1', rev, pr: pr(43, pipeline) }),
      );
    await waitFor(() => expect(getBranches).toHaveBeenCalledTimes(2));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(getBranches).toHaveBeenCalledTimes(2);
    unmount();
    shared.unmount();
  });

  // The session screen embeds the transcript; it must not render for every
  // event of the overview, only for its own pull request.
  it('renders again only when its own pull request changes', async () => {
    const shared = withListedSession();
    const getBranches = jest.fn().mockResolvedValue(branches(pr(42)));
    const client = { getBranches } as unknown as VerityClient;
    let renders = 0;
    const { unmount } = renderHook(() => {
      renders += 1;
      return useBranches(client, 's1');
    });
    await waitFor(() => expect(getBranches).toHaveBeenCalledTimes(1));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
    const before = renders;
    act(() => {
      const store = shared.result.current;
      store.applySessions(
        store.beginRead(),
        [{ sessionId: 'other', projectId: 'p1' } as SessionSummary],
        {
          covers: (s) => s.sessionId === 'other',
        },
      );
    });
    expect(renders).toBe(before);
    unmount();
    shared.unmount();
  });

  // Rows the server could not observe stay masked as unknown, whichever copy
  // of the status is shown.
  it('keeps unobserved repository rows masked when the store status is shown', async () => {
    const shared = withListedSession();
    const getBranches = jest.fn().mockResolvedValue({ ...branches(pr(42)), pullRequests: null });
    const client = { getBranches } as unknown as VerityClient;
    const { result, unmount } = renderHook(() => useBranches(client, 's1'));
    await waitFor(() => expect(mockSinks.has('project:p1')).toBe(true));
    act(() =>
      mockSinks
        .get('project:p1')!
        .event({ t: 'pr.status', sessionId: 's1', rev: 1, pr: pr(42, 'success') }),
    );
    expect(result.current.pullRequest?.pipeline).toBe('success');
    expect(result.current.pullRequests[0]).toMatchObject({ pipeline: 'unknown', mergeable: null });
    unmount();
    shared.unmount();
  });

  it("updates only the default repository's row, which keeps its repository", async () => {
    const shared = withListedSession();
    const repository = (id: string, isDefault: boolean) => ({
      id,
      name: id,
      owner: 'example',
      repo: id,
      isDefault,
    });
    const rows = [
      { ...pr(42), headSha: 'old', viewerCanMerge: true, repository: repository('main', true) },
      {
        ...pr(42),
        url: 'https://github.com/example/other/pull/42',
        repository: repository('other', false),
      },
    ];
    const getBranches = jest.fn().mockResolvedValue({ ...branches(pr(42)), pullRequests: rows });
    const client = { getBranches } as unknown as VerityClient;
    const { result, unmount } = renderHook(() => useBranches(client, 's1'));
    await waitFor(() => expect(mockSinks.has('project:p1')).toBe(true));
    await waitFor(() => expect(result.current.pullRequests).toHaveLength(2));
    act(() =>
      mockSinks
        .get('project:p1')!
        .event({ t: 'pr.status', sessionId: 's1', rev: 1, pr: pr(42, 'success') }),
    );
    const [main, other] = result.current.pullRequests;
    expect(main).toMatchObject({ pipeline: 'success', repository: repository('main', true) });
    // Fields the status leaves out are unknown now, not the row's older values.
    expect(main).not.toHaveProperty('headSha');
    expect(main).not.toHaveProperty('viewerCanMerge');
    expect(other).toMatchObject({ pipeline: 'running', repository: repository('other', false) });
    unmount();
    shared.unmount();
  });

  it('reads once more when the store lists the session only after its read', async () => {
    const shared = renderHook(() => useOverviewStore(BASE));
    const getBranches = jest.fn().mockResolvedValue(branches(pr(42)));
    const client = { getBranches } as unknown as VerityClient;
    const { result, unmount } = renderHook(() => useBranches(client, 's1'));
    await waitFor(() => expect(getBranches).toHaveBeenCalledTimes(1));
    // Home's list loads after the session was opened by a link.
    act(() => {
      const store = shared.result.current;
      store.applySessions(store.beginRead(), [{ ...session, pullRequest: pr(42) }], {
        covers: () => true,
      });
    });
    await waitFor(() => expect(getBranches).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(mockSinks.has('project:p1')).toBe(true));
    act(() =>
      mockSinks
        .get('project:p1')!
        .event({ t: 'pr.status', sessionId: 's1', rev: 1, pr: pr(42, 'success') }),
    );
    await waitFor(() => expect(result.current.pullRequest?.pipeline).toBe('success'));
    expect(getBranches).toHaveBeenCalledTimes(2);
    unmount();
    shared.unmount();
  });

  // The chip shows the store's copy; a merge must show at once there, before
  // the read that follows it answers.
  it('shows a merge at once and puts it in the store', async () => {
    const shared = withListedSession();
    const getBranches = jest
      .fn()
      .mockResolvedValueOnce(branches(pr(42)))
      .mockImplementation(() => new Promise(() => undefined));
    const mergePullRequest = jest.fn().mockResolvedValue(undefined);
    const client = { getBranches, mergePullRequest } as unknown as VerityClient;
    const { result, unmount } = renderHook(() => useBranches(client, 's1'));
    await waitFor(() => expect(shared.result.current.session('s1')?.pullRequest?.number).toBe(42));
    act(() => void result.current.mergePullRequest(42));
    await waitFor(() => expect(result.current.pullRequest?.phase).toBe('merged'));
    expect(shared.result.current.session('s1')?.pullRequest?.phase).toBe('merged');
    unmount();
    shared.unmount();
  });
});
