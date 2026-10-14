import type WebSocket from 'ws';

/** Pause only the producing stream; other streams and heartbeats share the connector. */
export function connectorBackpressure(
  source: WebSocket,
  connector: WebSocket,
  limit: number,
): () => void {
  let paused = false;
  let disposed = false;
  let poll: NodeJS.Timeout | undefined;
  const clearPoll = (): void => {
    if (poll) clearInterval(poll);
    poll = undefined;
  };
  const dispose = (): void => {
    disposed = true;
    clearPoll();
    source.off('close', dispose);
    connector.off('close', dispose);
  };
  const settle = (): void => {
    if (disposed) return;
    const congested = connector.bufferedAmount > limit;
    if (congested === paused) return;
    paused = congested;
    if (congested) {
      source.pause();
      // This source's last callback can precede another stream's queued writes.
      // Without a later check it stays paused after those writes drain.
      poll = setInterval(settle, 25);
      poll.unref();
    } else {
      clearPoll();
      source.resume();
    }
  };
  source.once('close', dispose);
  connector.once('close', dispose);
  return settle;
}
