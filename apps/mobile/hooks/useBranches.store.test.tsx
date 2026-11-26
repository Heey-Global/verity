import { act, renderHook, waitFor } from '@testing-library/react-native';
import { AppState } from 'react-native';
import type { BranchList, LiveTopicSink, SessionSummary, VerityClient } from '@verity/mobile';
import { useBranches } from './useBranches';
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
});
