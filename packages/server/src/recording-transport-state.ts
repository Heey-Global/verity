import { Socket } from 'node:net';
import type WebSocket from 'ws';

const object = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
const read = (source: Record<string, unknown>, key: string): unknown => {
  try {
    return source[key];
  } catch {
    return undefined;
  }
};
const count = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
const boolean = (value: unknown): boolean | null => (typeof value === 'boolean' ? value : null);
const bounded = (value: unknown, max: number): number | null => {
  const result = count(value);
  return result !== null && result <= max ? result : null;
};

/**
 * Read-only ws internals, projected onto fixed metadata fields. Socket counters are
 * lifetime API observations, not TCP acknowledgments or encrypted wire-byte counts.
 * Missing or changed internals remain unknown; never inspect buffers or addresses.
 */
export function recordingTransportState(ws: WebSocket | undefined) {
  const source = object(ws);
  const socket = object(read(source, '_socket'));
  const receiver = object(read(source, '_receiver'));
  let paused: boolean | null = null;
  try {
    const isPaused = read(socket, 'isPaused');
    if (typeof isPaused === 'function') paused = boolean(isPaused.call(socket));
  } catch {
    // A diagnostic accessor must not interrupt transport teardown.
  }
  return {
    schemaVersion: 1 as const,
    wsState: bounded(read(source, 'readyState'), 3),
    bufferedBytes: count(read(source, 'bufferedAmount')),
    socketEncrypted:
      'encrypted' in socket
        ? boolean(read(socket, 'encrypted'))
        : read(source, '_socket') instanceof Socket
          ? false
          : null,
    socketBytesRead: count(read(socket, 'bytesRead')),
    socketBytesWritten: count(read(socket, 'bytesWritten')),
    socketReadableLength: count(read(socket, 'readableLength')),
    socketWritableLength: count(read(socket, 'writableLength')),
    socketPaused: paused,
    socketNeedDrain: boolean(read(socket, 'writableNeedDrain')),
    socketDestroyed: boolean(read(socket, 'destroyed')),
    receiverState: bounded(read(receiver, '_state'), 6),
    receiverBufferedBytes: count(read(receiver, '_bufferedBytes')),
    receiverPayloadLength: count(read(receiver, '_payloadLength')),
    receiverTotalPayloadLength: count(read(receiver, '_totalPayloadLength')),
    receiverMessageLength: count(read(receiver, '_messageLength')),
    receiverFragmented: bounded(read(receiver, '_fragmented'), 2),
    receiverFin: boolean(read(receiver, '_fin')),
    receiverNeedDrain: boolean(read(receiver, 'writableNeedDrain')),
    closeFrameSent: boolean(read(source, '_closeFrameSent')),
    closeFrameReceived: boolean(read(source, '_closeFrameReceived')),
  };
}
