import { EventEmitter } from 'node:events';
import { Writable } from 'node:stream';
import type WebSocket from 'ws';
import { afterEach, expect, it, vi } from 'vitest';
import { connectorBackpressure } from './connector-backpressure.js';

afterEach(() => vi.useRealTimers());

function fixture() {
  const source = Object.assign(new EventEmitter(), { pause: vi.fn(), resume: vi.fn() });
  const completions: Array<() => void> = [];
  const writer = new Writable({
    write(_chunk, _encoding, done) {
      completions.push(done);
    },
  });
  const connector = new EventEmitter();
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
    await vi.advanceTimersByTimeAsync(25);
    expect(f.source.resume).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    f.source.emit('close');
    f.writer.destroy();
  }
});

it.each(['source', 'connector'] as const)('cleans up pressure polling on %s close', (side) => {
  vi.useFakeTimers();
  const f = fixture();
  f.writer.write(Buffer.alloc(8));
  f.settle();
  expect(vi.getTimerCount()).toBe(1);
  f[side].emit('close');
  f.settle();
  expect(vi.getTimerCount()).toBe(0);
  expect(f.source.listenerCount('close')).toBe(0);
  expect(f.connector.listenerCount('close')).toBe(0);
  f.writer.destroy();
});
