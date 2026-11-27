import { EventEmitter } from 'node:events';
import type { WebSocket } from 'ws';
import { expect, it } from 'vitest';
import { observeLiveSocket } from './live-observer.js';
import { MonitoringControl } from './monitoring-control.js';
import { ServerMetrics } from './server-metrics.js';

function fakeSocket() {
  const socket = new EventEmitter() as EventEmitter & { send: (data: unknown) => void };
  socket.send = () => undefined;
  return socket;
}

it('counts frames each way and the connection per client', () => {
  const metrics = new ServerMetrics();
  const socket = fakeSocket();
  observeLiveSocket(
    socket as unknown as WebSocket,
    { 'x-verity-client': 'ios/1.95.4' },
    metrics,
    new MonitoringControl(undefined),
  );
  socket.send('hello');
  socket.emit('message', Buffer.from('abc'));
  socket.emit('close');
  expect(metrics.live.get('ios/1.95.4')).toMatchObject({
    opened: 1,
    active: 0,
    framesOut: 1,
    bytesOut: 5,
    framesIn: 1,
    bytesIn: 3,
  });
});

// Switching measurement off and on starts a new period; a socket from before
// would otherwise put its traffic and full lifetime into the new one.
it('leaves a socket opened before a reset out of the new period', async () => {
  const metrics = new ServerMetrics();
  const control = new MonitoringControl(undefined, Date.now, () => metrics.reset());
  const socket = fakeSocket();
  observeLiveSocket(socket as unknown as WebSocket, {}, metrics, control);
  await control.setMeasurementEnabled(false);
  await control.setMeasurementEnabled(true);
  socket.send('late');
  socket.emit('close');
  expect(metrics.live.size).toBe(0);
});
