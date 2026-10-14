import WebSocket from 'ws';

/**
 * Holds one `ws` source to the pace of the tunnel it feeds.
 *
 * The connector socket carries every stream at once, so a peer that produces
 * faster than the tunnel drains cannot be answered by pausing the connector —
 * that would stall every other stream with it, and letting the queue grow
 * instead is how one loud socket exhausts the process. The source is paused
 * instead, which stops reading exactly the connection running ahead and lets
 * TCP carry the pressure back to it, and resumes once the backlog has drained.
 *
 * The returned function is called from this source's own write callbacks. That
 * callback alone cannot be trusted to resume: it can run while another
 * stream's writes are still queued on the shared connector, after which no
 * callback of this source's own will ever come. While paused, the backlog is
 * therefore polled as well. The connector is never subscribed to, since it is
 * shared by every stream and would accumulate a listener per stream; its state
 * is read instead, and the connector's close tears every source down anyway.
 */
export function connectorBackpressure(
  source: WebSocket,
  connector: WebSocket,
  limit: number,
): () => void {
  if (source.readyState >= WebSocket.CLOSING) return () => undefined;
  let paused = false;
  let disposed = false;
  let poll: NodeJS.Timeout | undefined;
  const clearPoll = (): void => {
    if (poll) clearInterval(poll);
    poll = undefined;
  };
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    clearPoll();
    source.off('close', dispose);
    // A source left paused could neither drain nor notice the end.
    if (paused) source.resume();
  };
  const settle = (): void => {
    if (disposed) return;
    if (connector.readyState !== WebSocket.OPEN) {
      dispose();
      return;
    }
    const congested = connector.bufferedAmount > limit;
    if (congested === paused) return;
    paused = congested;
    if (congested) {
      source.pause();
      poll = setInterval(settle, 25);
      poll.unref();
    } else {
      clearPoll();
      source.resume();
    }
  };
  source.once('close', dispose);
  return settle;
}
