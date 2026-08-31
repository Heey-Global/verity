import type { ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  EgressStreamIdleError,
  forwardBody,
  isArmableStreamIdleTimeout,
  STREAM_IDLE_TIMEOUT_MS,
} from './egress-stream.js';

afterEach(() => {
  vi.useRealTimers();
});

/**
 * The socket-level behaviour is covered by the two gateway suites against real
 * HTTP servers. These tests are about the deadline itself, so they hold the
 * clock: what has to be pinned is WHEN the supervision fires, and against a real
 * timer that can only be approximated by making the window small enough to be
 * flaky.
 */
describe('egress stream forwarding', () => {
  it('ends a stream whose producer stops between chunks', async () => {
    vi.useFakeTimers();
    const body = new Readable({ read() {} });
    body.push('data: one\n\n');
    const response = fakeResponse();
    const forwarding = forwardBody(body, response.response, response.forwarded, 1_000);
    const settled = expect(forwarding).rejects.toBeInstanceOf(EgressStreamIdleError);

    await vi.advanceTimersByTimeAsync(999);
    expect(body.destroyed).toBe(false);
    await vi.advanceTimersByTimeAsync(2);

    await settled;
    // The upstream socket is released rather than left holding a dead stream.
    expect(body.destroyed).toBe(true);
    expect(response.written).toEqual(['data: one\n\n']);
    expect(response.ended).toBe(false);
  });

  it('arms the deadline before the first chunk has arrived', async () => {
    vi.useFakeTimers();
    const body = new Readable({ read() {} });
    const response = fakeResponse();
    const forwarding = forwardBody(body, response.response, response.forwarded, 1_000);
    const settled = expect(forwarding).rejects.toBeInstanceOf(EgressStreamIdleError);

    await vi.advanceTimersByTimeAsync(1_001);

    await settled;
    expect(response.written).toEqual([]);
  });

  it('never fires while chunks keep arriving, however slowly', async () => {
    vi.useFakeTimers();
    const body = new Readable({ read() {} });
    const response = fakeResponse();
    const forwarding = forwardBody(body, response.response, response.forwarded, 1_000);

    for (let index = 0; index < 20; index += 1) {
      await vi.advanceTimersByTimeAsync(900);
      body.push(`chunk-${index};`);
    }
    body.push(null);
    await forwarding;

    expect(response.written).toHaveLength(20);
    expect(response.ended).toBe(true);
    expect(response.bytes).toBe(response.written.join('').length);
  });

  it('never counts time spent writing downstream against the producer', async () => {
    vi.useFakeTimers();
    const body = new Readable({ read() {} });
    // A consumer applying backpressure: the write is accepted but not flushed
    // until well past the deadline. The producer is healthy — it is the sandbox
    // that is slow — so the stream must survive.
    const response = fakeResponse({ flushAfterMs: 5_000 });
    const forwarding = forwardBody(body, response.response, response.forwarded, 1_000);

    body.push('slow-to-drain');
    // Five times the deadline spent inside one write, and the producer is not
    // blamed for a second of it.
    await vi.advanceTimersByTimeAsync(4_900);
    expect(body.destroyed).toBe(false);
    expect(response.written).toEqual([]);
    // The write flushes at 5s; the deadline only starts counting from there.
    await vi.advanceTimersByTimeAsync(500);
    expect(response.written).toEqual(['slow-to-drain']);
    expect(body.destroyed).toBe(false);
    body.push(null);
    await vi.advanceTimersByTimeAsync(5_000);
    await forwarding;

    expect(response.ended).toBe(true);
  });

  it('releases the upstream body when the downstream write fails', async () => {
    const body = new Readable({ read() {} });
    body.push('doomed');
    const response = fakeResponse({ writeError: new Error('socket is gone') });

    await expect(forwardBody(body, response.response, response.forwarded, 1_000)).rejects.toThrow(
      'socket is gone',
    );
    expect(body.destroyed).toBe(true);
    expect(response.ended).toBe(false);
  });

  it('supervises with a two-minute default when no deadline is given', async () => {
    vi.useFakeTimers();
    expect(STREAM_IDLE_TIMEOUT_MS).toBe(120_000);
    const body = new Readable({ read() {} });
    const response = fakeResponse();
    const forwarding = forwardBody(body, response.response, response.forwarded);
    const settled = expect(forwarding).rejects.toBeInstanceOf(EgressStreamIdleError);

    await vi.advanceTimersByTimeAsync(STREAM_IDLE_TIMEOUT_MS - 1);
    expect(body.destroyed).toBe(false);
    await vi.advanceTimersByTimeAsync(2);

    await settled;
  });

  it.each([0, -1, 2_147_483_648, Number.NaN, Number.POSITIVE_INFINITY])(
    'arms nothing for a deadline of %s',
    async (idleTimeoutMs) => {
      expect(isArmableStreamIdleTimeout(idleTimeoutMs)).toBe(false);
      vi.useFakeTimers();
      const body = new Readable({ read() {} });
      const response = fakeResponse();
      const forwarding = forwardBody(body, response.response, response.forwarded, idleTimeoutMs);

      // A NaN reaching `setTimeout` would fire on the very next tick and abort
      // every stream — the opposite of the "no supervision" it looks like.
      await vi.advanceTimersByTimeAsync(10 * 60 * 1_000);
      expect(body.destroyed).toBe(false);
      body.push('late-but-fine');
      body.push(null);
      await forwarding;

      expect(response.written).toEqual(['late-but-fine']);
    },
  );
});

interface FakeResponse {
  response: ServerResponse;
  written: string[];
  ended: boolean;
  bytes: number;
  forwarded: (bytes: number) => void;
}

/** The two fields {@link forwardBody} touches, and nothing else: a real
 *  `ServerResponse` needs a socket, which would put this back on the clock. */
function fakeResponse(options: { flushAfterMs?: number; writeError?: Error } = {}): FakeResponse {
  const state: FakeResponse = {
    response: undefined as unknown as ServerResponse,
    written: [],
    ended: false,
    bytes: 0,
    forwarded: (bytes) => {
      state.bytes += bytes;
    },
  };
  state.response = {
    write(chunk: string | Buffer, callback: (error?: Error | null) => void): boolean {
      const settle = (): void => {
        if (options.writeError !== undefined) {
          callback(options.writeError);
          return;
        }
        state.written.push(chunk.toString());
        callback(null);
      };
      if (options.flushAfterMs === undefined) settle();
      else setTimeout(settle, options.flushAfterMs);
      return true;
    },
    end(): void {
      state.ended = true;
    },
  } as unknown as ServerResponse;
  return state;
}
