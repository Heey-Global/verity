import { AppState } from 'react-native';
import type { LiveResource, LiveServerFrame, VerityClient } from '@verity/mobile';
import { liveConnectionFor, stopLiveConnection, subscribeLiveRefresh } from './liveConnection';
import { createWebSocket } from './socket';

jest.mock('./socket', () => ({ createWebSocket: jest.fn() }));
jest.mock('./client', () => ({
  createVerityClient: () => ({ createLiveTicket: async () => ({ ticket: 'ticket' }) }),
}));
const baseUrl = 'https://core.test';
let deliver: (frame: LiveServerFrame) => void;
let readListeners: Set<(resource: LiveResource) => void>;
let sent: Array<{ k: string; resource?: LiveResource }>;
let client: VerityClient;
let previousAppState: typeof AppState.currentState;

beforeEach(async () => {
  previousAppState = AppState.currentState;
  AppState.currentState = 'active';
  jest.useFakeTimers();
  sent = [];
  readListeners = new Set();
  (createWebSocket as jest.Mock).mockImplementation(() => {
    const listeners = new Map<string, (event: { data?: string }) => void>();
    deliver = (frame) => listeners.get('message')?.({ data: JSON.stringify(frame) });
    return {
      addEventListener: (type: string, listener: (event: { data?: string }) => void) =>
        listeners.set(type, listener),
      send: (data: string) => sent.push(JSON.parse(data) as { k: string }),
      close: () => {},
    };
  });
  client = {
    liveBaseUrl: () => baseUrl,
    observeReads: (listener: (resource: LiveResource) => void) => {
      readListeners.add(listener);
      return () => readListeners.delete(listener);
    },
  } as unknown as VerityClient;
  liveConnectionFor(baseUrl).start();
  await Promise.resolve();
  await Promise.resolve();
  deliver({ k: 'ready', v: 1, maxSessions: 8, resources: true });
});
afterEach(() => {
  stopLiveConnection(baseUrl);
  AppState.currentState = previousAppState;
  jest.useRealTimers();
});
const advance = async () => {
  await jest.advanceTimersByTimeAsync(50);
};
const read = (resource: LiveResource) => {
  for (const listener of readListeners) listener(resource);
};

it('loads initially without live-read support and cancels an unmounted initial read', async () => {
  const lightweight = {} as VerityClient;
  const refresh = jest.fn().mockResolvedValue(undefined);
  const detach = subscribeLiveRefresh(lightweight, refresh, undefined, [], { initial: true });
  await advance();
  expect(refresh).toHaveBeenCalledTimes(1);
  detach();
  const cancel = subscribeLiveRefresh(lightweight, refresh, undefined, [], { initial: true });
  cancel();
  await advance();
  expect(refresh).toHaveBeenCalledTimes(1);
});

it('refreshes on hints rather than a clock, filters resources and detaches on unmount', async () => {
  const refresh = jest.fn();
  const detach = subscribeLiveRefresh(client, refresh, (path) => path === '/projects');
  read({ path: '/projects' });
  read({ path: '/server/updates' });
  expect(sent.filter((frame) => frame.k === 'watch')).toEqual([
    { k: 'watch', resource: { path: '/projects' } },
  ]);
  await jest.advanceTimersByTimeAsync(30_000);
  deliver({ k: 'pong', n: 1 });
  await jest.advanceTimersByTimeAsync(30_000);
  expect(refresh).not.toHaveBeenCalled();
  deliver({ k: 'invalidate', path: '/projects' });
  await advance();
  expect(refresh).toHaveBeenCalledTimes(1);
  detach();
  deliver({ k: 'invalidate', path: '/projects' });
  await advance();
  expect(refresh).toHaveBeenCalledTimes(1);
});

it('keeps one refresh pending when changes arrive during a slow request', async () => {
  let resolve!: () => void;
  const refresh = jest.fn(
    () =>
      new Promise<void>((done) => {
        resolve = done;
      }),
  );
  const detach = subscribeLiveRefresh(client, refresh, () => true, [{ path: '/projects' }]);
  deliver({ k: 'invalidate', path: '/projects' });
  await advance();
  deliver({ k: 'invalidate', path: '/projects' });
  await advance();
  deliver({ k: 'invalidate', path: '/projects' });
  await advance();
  expect(refresh).toHaveBeenCalledTimes(1);
  resolve();
  await advance();
  expect(refresh).toHaveBeenCalledTimes(2);
  detach();
  resolve();
});

it('reloads after reconnect and uses periodic fallback only for older servers', async () => {
  const refresh = jest.fn();
  const detach = subscribeLiveRefresh(client, refresh, () => true, [{ path: '/projects' }]);
  liveConnectionFor(baseUrl).reconnect();
  await Promise.resolve();
  await Promise.resolve();
  deliver({ k: 'ready', v: 1, maxSessions: 8 });
  await advance();
  expect(refresh).toHaveBeenCalledTimes(1);
  await jest.advanceTimersByTimeAsync(15_050);
  expect(refresh).toHaveBeenCalledTimes(2);
  liveConnectionFor(baseUrl).reconnect();
  await Promise.resolve();
  await Promise.resolve();
  deliver({ k: 'ready', v: 1, maxSessions: 8, resources: true });
  await advance();
  expect(refresh).toHaveBeenCalledTimes(3);
  await jest.advanceTimersByTimeAsync(30_000);
  expect(refresh).toHaveBeenCalledTimes(3);
  detach();
});

it('falls back when the server cannot accept all resource subscriptions', async () => {
  const refresh = jest.fn();
  const detach = subscribeLiveRefresh(client, refresh, () => true, [{ path: '/projects' }]);
  deliver({ k: 'error', message: 'resource limit' });
  await advance();
  expect(refresh).toHaveBeenCalledTimes(1);
  await jest.advanceTimersByTimeAsync(15_050);
  expect(refresh).toHaveBeenCalledTimes(2);
  detach();
});

it('refreshes meeting answers when session events change', async () => {
  const refresh = jest.fn();
  const detach = subscribeLiveRefresh(client, refresh, () => true, [
    { path: '/sessions/s/live-meetings' },
  ]);
  deliver({ k: 'hint', hints: [{ sessionId: 'other', topics: ['events'] }] });
  await advance();
  expect(refresh).not.toHaveBeenCalled();
  deliver({ k: 'hint', hints: [{ sessionId: 's', topics: ['events'] }] });
  await advance();
  expect(refresh).toHaveBeenCalledTimes(1);
  detach();
});

it('coalesces activity hints and invalidations while ignoring unrelated event hints', async () => {
  const refresh = jest.fn();
  const detach = subscribeLiveRefresh(client, refresh, () => true, [
    { path: '/sessions/s/activity' },
  ]);
  deliver({ k: 'hint', hints: [{ sessionId: 's', topics: ['events'] }] });
  deliver({ k: 'hint', hints: [{ sessionId: 'other', topics: ['activity'] }] });
  await advance();
  expect(refresh).not.toHaveBeenCalled();
  deliver({ k: 'hint', hints: [{ sessionId: 's', topics: ['activity', 'status'] }] });
  deliver({ k: 'invalidate', path: '/sessions/s/activity' });
  await advance();
  expect(refresh).toHaveBeenCalledTimes(1);
  detach();
});

it('coordinates the initial load with changes and cancels a queued follow-up on disposal', async () => {
  let resolve!: () => void;
  const refresh = jest.fn(
    () =>
      new Promise<void>((done) => {
        resolve = done;
      }),
  );
  const detach = subscribeLiveRefresh(
    client,
    refresh,
    () => true,
    [{ path: '/sessions/s/links' }],
    { initial: true },
  );
  deliver({ k: 'invalidate', path: '/sessions/s/links' });
  await advance();
  expect(refresh).toHaveBeenCalledTimes(1);
  deliver({ k: 'invalidate', path: '/sessions/s/links' });
  await advance();
  expect(refresh).toHaveBeenCalledTimes(1);
  detach();
  resolve();
  await advance();
  expect(refresh).toHaveBeenCalledTimes(1);
});
