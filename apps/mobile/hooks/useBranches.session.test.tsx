import { act, renderHook, waitFor } from '@testing-library/react-native';
import { AppState } from 'react-native';
import type { BranchList, LiveTopicSink, VerityClient } from '@verity/mobile';
import { useBranches } from './useBranches';

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

const list = (current: string): BranchList => ({
  current,
  switchable: [],
  currentPr: null,
  pullRequest: null,
});
const row = (branch: string | undefined, rev: number) => ({
  t: 'session.summary' as const,
  sessionId: 's1',
  rev,
  patch: { status: 'running', ...(branch === undefined ? {} : { branch }) },
});

beforeEach(() => {
  jest.spyOn(AppState, 'addEventListener').mockReturnValue({ remove: jest.fn() });
  Object.defineProperty(AppState, 'currentState', { configurable: true, value: 'active' });
  mockSinks.clear();
});
afterEach(() => jest.restoreAllMocks());

describe('useBranches on the session topic', () => {
  // The server reads the branch of open sessions only while their topic is
  // followed; without it a checkout in the terminal never reaches the header.
  it('follows the session while it is shown, and stops after', async () => {
    const getBranches = jest.fn().mockResolvedValue(list('main'));
    const client = { getBranches } as unknown as VerityClient;
    const { result, unmount } = renderHook(() => useBranches(client, 's1'));
    await waitFor(() => expect(result.current.current).toBe('main'));
    expect(mockSinks.has('session:s1')).toBe(true);
    unmount();
    expect(mockSinks.has('session:s1')).toBe(false);
  });

  it('reads the branches again when the session row names another branch, once', async () => {
    const getBranches = jest
      .fn()
      .mockResolvedValueOnce(list('main'))
      .mockResolvedValue(list('feat/terminal'));
    const client = { getBranches } as unknown as VerityClient;
    const { result, unmount } = renderHook(() => useBranches(client, 's1'));
    await waitFor(() => expect(result.current.current).toBe('main'));
    const sink = mockSinks.get('session:s1')!;

    // Rows for other changes, and those naming the shown branch, read nothing.
    act(() => sink.event(row(undefined, 1)));
    act(() => sink.event(row('main', 2)));
    expect(getBranches).toHaveBeenCalledTimes(1);

    act(() => sink.event(row('feat/terminal', 3)));
    await waitFor(() => expect(result.current.current).toBe('feat/terminal'));
    expect(getBranches).toHaveBeenCalledTimes(2);
    unmount();
  });

  // Rows come with every status change while the agent works. A row that
  // spells the branch unlike the branch read must not cost a read each time.
  it('reads once per announced branch, even when the read shows it otherwise', async () => {
    const getBranches = jest.fn().mockResolvedValue(list('main'));
    const client = { getBranches } as unknown as VerityClient;
    const { result, unmount } = renderHook(() => useBranches(client, 's1'));
    await waitFor(() => expect(result.current.current).toBe('main'));
    const sink = mockSinks.get('session:s1')!;
    act(() => sink.event(row('origin/preview', 1)));
    await waitFor(() => expect(getBranches).toHaveBeenCalledTimes(2));
    act(() => sink.event(row('origin/preview', 2)));
    act(() => sink.event(row('origin/preview', 3)));
    await act(async () => undefined);
    expect(getBranches).toHaveBeenCalledTimes(2);
    unmount();
  });

  it('reads again after missed rows', async () => {
    const getBranches = jest.fn().mockResolvedValue(list('main'));
    const client = { getBranches } as unknown as VerityClient;
    const { result, unmount } = renderHook(() => useBranches(client, 's1'));
    await waitFor(() => expect(result.current.current).toBe('main'));
    act(() => mockSinks.get('session:s1')!.resync());
    await waitFor(() => expect(getBranches).toHaveBeenCalledTimes(2));
    unmount();
  });
});
