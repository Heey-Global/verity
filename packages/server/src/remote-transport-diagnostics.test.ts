import type WebSocket from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RemoteTransportDiagnostics } from './remote-transport-diagnostics.js';

function socketView(bufferedAmount = 0): WebSocket {
  return {
    readyState: 1,
    bufferedAmount,
    _socket: {
      bytesRead: 500,
      bytesWritten: 700,
      writableLength: 19,
      writableNeedDrain: true,
      destroyed: false,
      readable: true,
      writable: true,
      localAddress: '127.0.0.1',
      localPort: 1234,
      remoteAddress: '192.0.2.1',
      remotePort: 443,
    },
  } as unknown as WebSocket;
}

afterEach(() => vi.useRealTimers());

describe('remote transport diagnostics', () => {
  it('distinguishes pending writes from callbacks without treating callbacks as peer delivery', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const diagnostics = new RemoteTransportDiagnostics('session_one');
    const first = diagnostics.enqueue(100)!;
    diagnostics.frame('out', { type: 'stream.data', streamId: 'stream_one', seq: 0 }, first);
    vi.setSystemTime(1_050);
    const second = diagnostics.enqueue(200)!;
    vi.setSystemTime(1_100);
    expect(diagnostics.snapshot(socketView())).toMatchObject({
      enqueuedFrames: 2,
      enqueuedBytes: 300,
      completedFrames: 0,
      pendingFrames: 2,
      pendingBytes: 300,
      oldestPendingMs: 100,
      bufferedBytes: 0,
    });
    diagnostics.complete(first, false);
    expect(diagnostics.snapshot(undefined)).toMatchObject({
      completedFrames: 1,
      completedBytes: 100,
      lastEnqueueAt: 1_050,
      lastCallbackAt: 1_100,
      trace: [
        {
          writeId: first,
          callbackAt: 1_100,
          callbackMs: 100,
          outcome: 'accepted',
          encodedBytes: 100,
        },
      ],
      pendingFrames: 1,
      pendingBytes: 200,
      oldestPendingMs: 50,
    });
    diagnostics.complete(second, true);
    diagnostics.complete(second, false);
    diagnostics.complete(999, false);
    expect(diagnostics.snapshot(undefined)).toMatchObject({
      enqueuedFrames: 2,
      completedFrames: 1,
      completedBytes: 100,
      errorFrames: 1,
      pendingFrames: 0,
      pendingBytes: 0,
      oldestPendingMs: 0,
    });
  });

  it('bounds pending callbacks and resumes admitting writes when one settles', () => {
    const diagnostics = new RemoteTransportDiagnostics('session_one');
    const first = diagnostics.enqueue(1)!;
    let admitted = 1;
    while (diagnostics.enqueue(1) !== null && admitted < 20_000) admitted++;
    expect(admitted).toBeLessThan(20_000);
    expect(diagnostics.enqueue(1)).toBeNull();
    expect(diagnostics.snapshot(undefined)).toMatchObject({
      pendingFrames: admitted,
      enqueuedFrames: admitted,
      pendingBytes: admitted,
    });
    diagnostics.complete(first, false);
    expect(diagnostics.enqueue(1)).not.toBeNull();
    expect(diagnostics.snapshot(undefined)).toMatchObject({ pendingFrames: admitted });
  });

  it('retains only bounded safe frame metadata even for malformed frames', () => {
    const diagnostics = new RemoteTransportDiagnostics('session_one');
    for (let seq = 0; seq < 100; seq++)
      diagnostics.frame('out', {
        type: 'stream.data',
        streamId: 'stream_safe',
        seq,
        payload: 'private-payload',
        ticket: 'private-ticket',
      });
    diagnostics.frame('in', {
      type: 'ticket=private-type',
      streamId: 'ticket=private-stream',
      seq: -1,
      payload: 'private-payload',
    });
    const snapshot = diagnostics.snapshot(undefined);
    const trace = snapshot.trace as Record<string, unknown>[];
    expect(trace.length).toBeLessThan(100);
    expect(trace.at(-2)).toMatchObject({ type: 'stream.data', streamId: 'stream_safe', seq: 99 });
    expect(trace.at(-1)).toEqual({ at: expect.any(Number), direction: 'in', type: 'unknown' });
    expect(JSON.stringify(snapshot)).not.toContain('private');
  });

  it('keeps socket byte progress separate from complete WebSocket messages and heartbeats', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const diagnostics = new RemoteTransportDiagnostics('session_one');
    diagnostics.receive(30);
    diagnostics.heartbeat('ping');
    vi.setSystemTime(2_000);
    diagnostics.heartbeat('pong');
    const snapshot = diagnostics.snapshot(socketView(40));
    expect(snapshot).toMatchObject({
      sessionId: 'session_one',
      rawMessages: 1,
      rawBytes: 30,
      lastRawAt: 1_000,
      pings: 1,
      pongs: 1,
      lastPongAt: 2_000,
      socket: { bytesRead: 500, bytesWritten: 700, writableLength: 19, writableNeedDrain: true },
      bufferedMax: 40,
    });
    expect(diagnostics.snapshot(socketView(0))).toMatchObject({
      bufferedBytes: 0,
      bufferedMax: 40,
    });
    expect(diagnostics.snapshot(undefined)).toMatchObject({
      socket: null,
      wsState: null,
      bufferedBytes: null,
    });
  });

  it('returns detached snapshots so callers cannot mutate retained evidence', () => {
    const diagnostics = new RemoteTransportDiagnostics('session_one');
    diagnostics.frame('in', { type: 'stream.open', streamId: 'stream_safe' });
    const snapshot = diagnostics.snapshot(socketView());
    (snapshot.trace as Record<string, unknown>[])[0]!.streamId = 'changed';
    (snapshot.trace as Record<string, unknown>[]).push({ type: 'changed' });
    (snapshot.socket as Record<string, unknown>).bytesRead = 0;
    expect(diagnostics.snapshot(socketView())).toMatchObject({
      trace: [{ streamId: 'stream_safe', type: 'stream.open' }],
      socket: { bytesRead: 500 },
    });
  });
});
