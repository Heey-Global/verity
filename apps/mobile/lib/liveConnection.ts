import { LiveConnection, type LiveHint } from '@verity/mobile';
import { useEffect } from 'react';
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
