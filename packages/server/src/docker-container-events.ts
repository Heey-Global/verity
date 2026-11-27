import { createUnixSocketFetch, isUnixBaseUrl, parseUnixBaseUrl } from './docker.js';
import type { HttpFetch } from './github.js';

/** The label every project sandbox carries (see the provisioner). */
const PROJECT_LABEL = 'verity.project-id';

/** Container actions after which a sandbox may have started, stopped or died. */
const ACTIONS = [
  'start',
  'die',
  'stop',
  'kill',
  'oom',
  'restart',
  'pause',
  'unpause',
  'destroy',
] as const;

const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
/** A stream must stay open this long before the reconnect delay starts over:
 * one that a proxy cuts right after opening would otherwise be reopened, and
 * the whole fleet compared, every second. */
const STABLE_MS = 60_000;

export interface ContainerEventHandlers {
  /** A project's sandbox container changed. */
  onEvent(projectId: string, action: string): void;
  /** The stream is open; events missed before it are not replayed. */
  onConnected(): void;
  /** The stream ended or could not open; it is reopened after a delay. */
  onDisconnected(error: unknown): void;
}

/** Docker's event stream for project sandboxes, followed until stopped. */
export interface ContainerEventSource {
  followContainerEvents: (handlers: ContainerEventHandlers) => () => Promise<void>;
}

/**
 * Follows `GET /events` on the Docker API for project sandbox containers: one
 * long-lived request for the whole fleet instead of an inspect per project and
 * read. The stream reopens with a growing delay after it ends or fails, and
 * reports each (re)connect so the caller can catch up on what it missed.
 */
export function createContainerEventSource(options: {
  baseUrl: string;
  fetch?: HttpFetch;
  /** Delays between reconnects, for tests. */
  reconnectMs?: { min: number; max: number; stable?: number };
}): ContainerEventSource {
  // Built on first use: a client that is never followed opens nothing.
  let transport: HttpFetch | undefined;
  const doFetch: HttpFetch = (url, init) => {
    transport ??=
      options.fetch ??
      (isUnixBaseUrl(options.baseUrl)
        ? createUnixSocketFetch(parseUnixBaseUrl(options.baseUrl))
        : (target, request) => fetch(target, request));
    return transport(url, init);
  };
  const base = options.baseUrl.endsWith('/') ? options.baseUrl.slice(0, -1) : options.baseUrl;
  const filters = JSON.stringify({
    type: ['container'],
    label: [PROJECT_LABEL],
    event: ACTIONS,
  });
  const url = `${base}/events?${new URLSearchParams({ filters }).toString()}`;
  const minMs = options.reconnectMs?.min ?? RECONNECT_MIN_MS;
  const maxMs = options.reconnectMs?.max ?? RECONNECT_MAX_MS;
  const stableMs = options.reconnectMs?.stable ?? STABLE_MS;

  return {
    followContainerEvents(handlers) {
      const controller = new AbortController();
      let delay = minMs;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let wake: (() => void) | undefined;
      let openedAt: number | undefined;

      const readOnce = async (): Promise<void> => {
        // Raced against the stop: a daemon that took the connection and never
        // answers must not hold the server's close. The listener goes with the
        // race, or every reconnect of a long outage would leave one behind.
        let onAbort: (() => void) | undefined;
        const stopped = new Promise<never>((_, reject) => {
          onAbort = () => reject(new Error('stopped'));
          if (controller.signal.aborted) onAbort();
          else controller.signal.addEventListener('abort', onAbort, { once: true });
        });
        stopped.catch(() => undefined);
        let res: Awaited<ReturnType<HttpFetch>>;
        try {
          res = await Promise.race([
            doFetch(url, { method: 'GET', signal: controller.signal, stream: true }),
            stopped,
          ]);
        } finally {
          if (onAbort !== undefined) controller.signal.removeEventListener('abort', onAbort);
        }
        // A transport that ignores the signal can answer after the stop.
        if (controller.signal.aborted) {
          await res.body?.cancel().catch(() => undefined);
          return;
        }
        if (!res.ok || !res.body) {
          await res.body?.cancel().catch(() => undefined);
          throw new Error(`docker events responded ${String(res.status)}`);
        }
        openedAt = Date.now();
        try {
          handlers.onConnected();
        } catch {
          // The stream is open whatever its listener made of that.
        }
        const reader = res.body.getReader();
        // Not every transport ties the body to the request's signal; without
        // this, stopping would wait for an event that may never come.
        const cancel = (): void => void reader.cancel().catch(() => undefined);
        controller.signal.addEventListener('abort', cancel, { once: true });
        if (controller.signal.aborted) cancel();
        const decoder = new TextDecoder();
        let pending = '';
        try {
          for (let next = await reader.read(); !next.done; next = await reader.read()) {
            pending += decoder.decode(next.value, { stream: true });
            const lines = pending.split('\n');
            pending = lines.pop() ?? '';
            for (const line of lines) dispatch(line, handlers);
          }
        } finally {
          controller.signal.removeEventListener('abort', cancel);
          await reader.cancel().catch(() => undefined);
        }
        throw new Error('docker events stream ended');
      };

      const done = (async () => {
        while (!controller.signal.aborted) {
          try {
            await readOnce();
          } catch (error) {
            if (controller.signal.aborted) return;
            if (openedAt !== undefined && Date.now() - openedAt >= stableMs) delay = minMs;
            openedAt = undefined;
            try {
              handlers.onDisconnected(error);
            } catch {
              // Following goes on whatever its listener made of the end.
            }
          }
          // A request answered after the stop returns without an error; its
          // delay would hold the server's close for up to half a minute.
          if (controller.signal.aborted) return;
          await new Promise<void>((resolve) => {
            wake = resolve;
            timer = setTimeout(resolve, delay);
            timer.unref?.();
          });
          delay = Math.min(maxMs, delay * 2);
        }
      })();

      return async () => {
        controller.abort();
        clearTimeout(timer);
        wake?.();
        await done;
      };
    },
  };
}

function dispatch(line: string, handlers: ContainerEventHandlers): void {
  if (line.trim() === '') return;
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    return;
  }
  if (event === null || typeof event !== 'object') return;
  const { Action, status, Actor } = event as {
    Action?: unknown;
    status?: unknown;
    Actor?: { Attributes?: Record<string, unknown> };
  };
  const projectId = Actor?.Attributes?.[PROJECT_LABEL];
  const action = typeof Action === 'string' ? Action : status;
  if (typeof projectId !== 'string' || projectId === '' || typeof action !== 'string') return;
  try {
    handlers.onEvent(projectId, action);
  } catch {
    // One listener's failure is not the stream's: the next event still comes.
  }
}

/** Give a Docker client the event stream of the API it talks to. */
export function withContainerEvents<T extends object>(
  client: T,
  baseUrl: string,
): T & ContainerEventSource {
  const source = createContainerEventSource({ baseUrl });
  return Object.assign(client, { followContainerEvents: source.followContainerEvents });
}
