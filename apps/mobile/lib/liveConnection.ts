import {
  LiveConnection,
  type LiveHint,
  type VerityClient,
  type LiveResource,
} from '@verity/mobile';
import { useEffect } from 'react';
import { AppState } from 'react-native';
import { createVerityClient } from './client';
import { createWebSocket } from './socket';

// One live connection per server. The app talks to one server at a time today;
// keying by base URL keeps a second profile (ADR 0023 §7) from sharing, or
// inheriting, another server's socket.
const connections = new Map<string, LiveConnection>();

/** The live connection to `baseUrl`, created on first use. Its lifecycle —
 * when it opens, pauses and reports the foreground — belongs to
 * `LiveConnectionLifecycle`; screens only subscribe. */
export function liveConnectionFor(baseUrl: string): LiveConnection {
  let connection = connections.get(baseUrl);
  if (connection === undefined) {
    connection = new LiveConnection({
      baseUrl,
      connect: createWebSocket,
      getTicket: async () => {
        const client = createVerityClient();
        if (client === null) throw new Error('No server is configured.');
        return (await client.createLiveTicket()).ticket;
      },
    });
    connections.set(baseUrl, connection);
  }
  return connection;
}

/** Stop and forget the connection to `baseUrl` — after a server switch it
 * must not stay authenticated as this device. Only that one: a screen of the
 * new server may already hold its own. */
export function stopLiveConnection(baseUrl: string): void {
  connections.get(baseUrl)?.stop();
  connections.delete(baseUrl);
}

/** Call `listener` with the live hints about `sessionId` (or about every
 * session when omitted) while the component is mounted. */
export function useLiveHints(
  baseUrl: string | null,
  listener: (hints: LiveHint[]) => void,
  sessionId?: string,
): void {
  useEffect(() => {
    if (baseUrl === null) return undefined;
    return liveConnectionFor(baseUrl).onHints((hints) => {
      const relevant =
        sessionId === undefined ? hints : hints.filter((hint) => hint.sessionId === sessionId);
      if (relevant.length > 0) listener(relevant);
    });
  }, [baseUrl, listener, sessionId]);
}

/** Refresh mounted data on changes and reconnect. Read observations track the
 * exact resources (including meeting cursors) requested by this client. */
export function subscribeLiveRefresh(
  client: VerityClient,
  refresh: () => void | Promise<unknown>,
  filter: (path: string) => boolean = () => true,
  resources: readonly LiveResource[] = [],
  options: { initial?: boolean } = {},
): () => void {
  // Lightweight test/demo clients may implement only the API calls they use.
  if (typeof client.observeReads !== 'function') {
    const initial = options.initial
      ? setTimeout(() => {
          void Promise.resolve()
            .then(refresh)
            .catch(() => undefined);
        }, 50)
      : undefined;
    return () => clearTimeout(initial);
  }
  const connection = liveConnectionFor(client.liveBaseUrl());
  const subscriptions = new Map<string, { key: string; detach: () => void }>();
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let refreshing = false;
  let pending = false;
  const run = async (): Promise<void> => {
    if (disposed) return;
    if (refreshing) {
      pending = true;
      return;
    }
    refreshing = true;
    try {
      await refresh();
    } catch {
      /* Existing screens own error presentation. */
    } finally {
      refreshing = false;
      if (pending && !disposed) {
        pending = false;
        invalidate();
      }
    }
  };
  const invalidate = (): void => {
    if (disposed || timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (!disposed) void run();
    }, 50);
  };
  const observe = (resource: LiveResource): void => {
    if (!filter(resource.path)) return;
    const path = resource.path.split('?')[0]!;
    const key = JSON.stringify(resource);
    const previous = subscriptions.get(path);
    if (previous?.key === key) return;
    previous?.detach();
    subscriptions.set(path, { key, detach: connection.watchResource(resource, invalidate) });
  };
  for (const resource of resources) observe(resource);
  const detachReads = client.observeReads(observe);
  const detachHints = connection.onHints((hints) => {
    if (
      hints.some(({ sessionId, topics }) => {
        const prefix = `/sessions/${encodeURIComponent(sessionId)}/`;
        return [...subscriptions.keys()].some(
          (path) =>
            path === `${prefix}live-meetings` ||
            (path === `${prefix}activity` &&
              topics.some(
                (topic) => topic === 'activity' || topic === 'status' || topic === 'permission',
              )),
        );
      })
    )
      invalidate();
  });
  let fallback: ReturnType<typeof setInterval> | undefined;
  const syncFallback = (): void => {
    clearInterval(fallback);
    fallback = undefined;
    // A disconnected or older server cannot deliver resource invalidations.
    const state = connection.connectionState;
    const preAuth = resources.some(
      ({ path }) => path === '/onboarding/status' || path === '/secret/status',
    );
    if (
      AppState.currentState === 'active' &&
      (state !== 'paused' || preAuth) &&
      (state !== 'unauthorized' || preAuth) &&
      (state !== 'connected' || !connection.resourceWatching)
    )
      fallback = setInterval(invalidate, 15_000);
  };
  syncFallback();
  const detachState = connection.onStateChange((state) => {
    syncFallback();
    if (state === 'connected') invalidate();
  });
  if (options.initial) invalidate();
  return () => {
    disposed = true;
    clearTimeout(timer);
    clearInterval(fallback);
    detachReads();
    detachHints();
    detachState();
    for (const subscription of subscriptions.values()) subscription.detach();
  };
}
