import { EventEmitter } from 'node:events';
import { Writable } from 'node:stream';
import WebSocket from 'ws';
import { afterEach, expect, it, vi } from 'vitest';
import { connectorBackpressure } from './connector-backpressure.js';

afterEach(() => vi.useRealTimers());

function fixture(connectorState: { readyState: number } = { readyState: WebSocket.OPEN }) {
  const source = Object.assign(new EventEmitter(), {
    pause: vi.fn(),
    resume: vi.fn(),
    readyState: WebSocket.OPEN,
  });
  const completions: Array<() => void> = [];
  const writer = new Writable({
    write(_chunk, _encoding, done) {
      completions.push(done);
    },
  });
  const connector = new EventEmitter();
  Object.defineProperty(connector, 'readyState', { get: () => connectorState.readyState });
  Object.defineProperty(connector, 'bufferedAmount', { get: () => writer.writableLength });
  const settle = connectorBackpressure(
    source as unknown as WebSocket,
    connector as unknown as WebSocket,
    4,
  );
  return { source, connector, writer, completions, settle };
}

it('resumes a source after later writes from another stream drain', async () => {
  vi.useFakeTimers();
  const f = fixture();
  try {
    f.writer.write(Buffer.alloc(8), f.settle);
    f.writer.write(Buffer.alloc(8));
    f.settle();
    expect(f.source.pause).toHaveBeenCalledTimes(1);
    f.completions.shift()!();
    expect(f.writer.writableLength).toBe(8);
    expect(f.source.resume).not.toHaveBeenCalled();
    f.completions.shift()!();
    expect(f.writer.writableLength).toBe(0);
    // This source's own callback has already run; without the poll it stays
    // paused for good once the other stream's bytes have drained.
    await vi.advanceTimersByTimeAsync(25);
    expect(f.source.resume).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    f.source.emit('close');
    f.writer.destroy();
  }
});

it('cleans up pressure polling when the source closes', () => {
  vi.useFakeTimers();
  const f = fixture();
  f.writer.write(Buffer.alloc(8));
  f.settle();
  expect(vi.getTimerCount()).toBe(1);
  f.source.emit('close');
  f.settle();
  expect(vi.getTimerCount()).toBe(0);
  expect(f.source.listenerCount('close')).toBe(0);
  f.writer.destroy();
});

it('stops polling and releases the source once the connector is no longer open', () => {
  vi.useFakeTimers();
  const connector: { readyState: number } = { readyState: WebSocket.OPEN };
  const f = fixture(connector);
  f.writer.write(Buffer.alloc(8));
  f.settle();
  expect(vi.getTimerCount()).toBe(1);
  connector.readyState = WebSocket.CLOSING;
  vi.advanceTimersByTime(25);
  // Left paused, a source could neither drain nor notice the end.
  expect(f.source.resume).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
  expect(f.source.listenerCount('close')).toBe(0);
  f.writer.destroy();
});

it('never subscribes to the shared connector, however many sources it carries', () => {
  const connector = Object.assign(new EventEmitter(), { readyState: WebSocket.OPEN });
  Object.defineProperty(connector, 'bufferedAmount', { get: () => 0 });
  // One listener per stream would pass Node's default cap at the eleventh.
  for (let index = 0; index < 12; index += 1) {
    const source = Object.assign(new EventEmitter(), {
      pause: vi.fn(),
      resume: vi.fn(),
      readyState: WebSocket.OPEN,
    });
    connectorBackpressure(source as unknown as WebSocket, connector as unknown as WebSocket, 4)();
  }
  expect(connector.listenerCount('close')).toBe(0);
});

it('does nothing for a source that has already closed', () => {
  const source = Object.assign(new EventEmitter(), {
    pause: vi.fn(),
    resume: vi.fn(),
    readyState: WebSocket.CLOSED,
  });
  const connector = Object.assign(new EventEmitter(), { readyState: WebSocket.OPEN });
  Object.defineProperty(connector, 'bufferedAmount', { get: () => 8 });
  connectorBackpressure(source as unknown as WebSocket, connector as unknown as WebSocket, 4)();
  expect(source.pause).not.toHaveBeenCalled();
  expect(source.listenerCount('close')).toBe(0);
});
