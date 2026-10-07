import { act, renderHook } from '@testing-library/react-native';
import { VerityClient, type BranchList, type LiveServerFrame } from '@verity/mobile';
import { AppState } from 'react-native';
import { prefetchBranches, registerBranchesClientScope } from '../lib/branchesPrefetch';
import { liveConnectionFor, stopLiveConnection } from '../lib/liveConnection';
import { createWebSocket } from '../lib/socket';
import { useBranches } from './useBranches';

jest.mock('../lib/socket', () => ({ createWebSocket: jest.fn() }));
jest.mock('../lib/client', () => ({
  createVerityClient: () => ({ createLiveTicket: async () => ({ ticket: 'ticket' }) }),
}));
jest.mock('expo-router', () => ({
  useFocusEffect: (callback: () => (() => void) | undefined) => {
    const React = require('react') as typeof import('react');
    React.useEffect(callback, [callback]);
  },
}));

const baseUrl = 'https://branches-live.test';

it('subscribes and updates the PR after consuming another client’s prefetch', async () => {
  const previousAppState = AppState.currentState;
  AppState.currentState = 'active';
  jest.useFakeTimers();
  let hook: ReturnType<typeof renderHook<ReturnType<typeof useBranches>, unknown>> | undefined;
  try {
    const sent: Array<{ k: string; resource?: { path: string } }> = [];
    let deliver!: (frame: LiveServerFrame) => void;
    (createWebSocket as jest.Mock).mockImplementation(() => {
      const listeners = new Map<string, (event: { data: string }) => void>();
      deliver = (frame) => listeners.get('message')?.({ data: JSON.stringify(frame) });
      return {
        addEventListener: (type: string, listener: (event: { data: string }) => void) =>
          listeners.set(type, listener),
        send: (data: string) => sent.push(JSON.parse(data) as { k: string }),
        close: () => {},
      };
    });
    liveConnectionFor(baseUrl).start();
    await Promise.resolve();
    await Promise.resolve();
    deliver({ k: 'ready', v: 1, maxSessions: 8, resources: true });

    let response: BranchList = {
      current: 'fix/status',
      switchable: [],
      currentPr: 42,
      pullRequest: {
        number: 42,
        title: 'Status',
        url: 'https://github.com/example/repo/pull/42',
        phase: 'open',
        headSha: 'abc',
        pipeline: 'success',
        checks: { completed: 1, total: 1, successful: 1, failed: 0, pending: 0 },
        mergeable: true,
      },
    };
    const fetch = jest.fn(async () => new Response(JSON.stringify(response)));
    const opener = new VerityClient({ baseUrl, fetch });
    const screen = new VerityClient({ baseUrl, fetch });
    for (const client of [opener, screen]) registerBranchesClientScope(client, () => baseUrl);
    prefetchBranches(opener, 's');
    hook = renderHook(() => useBranches(screen, 's'));
    await act(async () => jest.advanceTimersByTimeAsync(0));
    expect(hook.result.current.pullRequest?.phase).toBe('open');
    expect(fetch).toHaveBeenCalledTimes(1);

    // Shared prefetched data must not silently skip the screen's live subscription.
    expect(sent.filter(({ k }) => k === 'watch')).toContainEqual({
      k: 'watch',
      resource: { path: '/sessions/s/branches' },
    });
    response = {
      ...response,
      pullRequest: { ...response.pullRequest!, phase: 'merged', mergeable: false },
    };
    await act(async () => {
      deliver({ k: 'invalidate', path: '/sessions/s/branches' });
      await jest.advanceTimersByTimeAsync(50);
    });
    expect(hook.result.current.pullRequest?.phase).toBe('merged');
    expect(fetch).toHaveBeenCalledTimes(2);
    hook.unmount();
    expect(sent).toContainEqual({ k: 'unwatch', resource: { path: '/sessions/s/branches' } });
  } finally {
    hook?.unmount();
    stopLiveConnection(baseUrl);
    AppState.currentState = previousAppState;
    jest.useRealTimers();
  }
});
