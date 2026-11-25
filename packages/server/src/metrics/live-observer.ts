import type { WebSocket } from 'ws';
import { clientLabel, identifyClient } from './client-identity.js';
import type { MonitoringControl } from './monitoring-control.js';
import type { ServerMetrics } from './server-metrics.js';

function frameBytes(data: unknown): number {
  if (typeof data === 'string') return Buffer.byteLength(data);
  if (data instanceof Uint8Array) return data.byteLength;
  if (data instanceof ArrayBuffer) return data.byteLength;
  if (Array.isArray(data)) return data.reduce((total: number, part) => total + frameBytes(part), 0);
  return 0;
}

/**
 * Counts one live WebSocket: how long it stays open and the frames and bytes
 * it carries each way. A reconnect shows up as another opened connection, so a
 * client that keeps reconnecting stands out by `opened` against `active`.
 */
export function observeLiveSocket(
  socket: WebSocket,
  headers: Record<string, string | string[] | undefined>,
  metrics: ServerMetrics,
  control: MonitoringControl,
): void {
  if (!control.measuring) return;
  const client = clientLabel(identifyClient(headers));
  const openedAt = Date.now();
  metrics.liveOpened(client);
  const send = socket.send;
  socket.send = function (this: WebSocket, ...args: Parameters<WebSocket['send']>) {
    if (control.measuring) metrics.liveFrame(client, 'out', frameBytes(args[0]));
    return send.apply(this, args);
  } as WebSocket['send'];
  socket.on('message', (data) => {
    if (control.measuring) metrics.liveFrame(client, 'in', frameBytes(data));
  });
  socket.once('close', () => metrics.liveClosed(client, Date.now() - openedAt));
}
