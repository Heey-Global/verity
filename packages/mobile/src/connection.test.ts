import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

import { VerityApiError, VerityClient } from './api.js';
import {
  ConnectionMonitor,
  SERVER_MAINTENANCE_MESSAGE,
  connectionFailureKind,
} from './connection.js';

/**
 * The body the Gateway really sends while the server updates, read from its
 * source: if the server rewords it, the app would stop recognizing updates and
 * fall back to every screen showing its own error, with every test still green.
 */
function gatewayMaintenanceBody(): string {
  const source = readFileSync(
    new URL('../../server/src/self-update/managed-gateway.ts', import.meta.url),
    'utf8',
  );
  const unavailable = source.slice(source.indexOf('const unavailable ='));
  const body = /response\.end\('([^']+)'\)/u.exec(unavailable)?.[1];
  if (body === undefined) throw new Error('managed-gateway.ts no longer ends its 503 with a body');
  return body;
}

function fakeTimers() {
  let now = 1_000;
  const pending: { at: number; run: () => void; id: number }[] = [];
  let next = 0;
  return {
    timers: {
      now: () => now,
      setTimeout: (run: () => void, ms: number) => {
        const id = ++next;
        pending.push({ at: now + ms, run, id });
        return id;
      },
      clearTimeout: (id: unknown) => {
        const index = pending.findIndex((entry) => entry.id === id);
        if (index >= 0) pending.splice(index, 1);
      },
    },
    /** Moves time forward and runs every timer that became due. */
    advance(ms: number) {
      now += ms;
      for (;;) {
        const due = pending.filter((entry) => entry.at <= now).sort((a, b) => a.at - b.at)[0];
        if (due === undefined) return;
        pending.splice(pending.indexOf(due), 1);
        due.run();
      }
    },
    delays: () => pending.map((entry) => entry.at - now),
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('connectionFailureKind', () => {
  it('recognizes the Gateway answer during an update, also behind a screen prefix', () => {
    const body = JSON.parse(gatewayMaintenanceBody()) as { error: string };
    expect(body.error).toBe(SERVER_MAINTENANCE_MESSAGE);
    expect(connectionFailureKind(new VerityApiError(503, body.error))).toBe('maintenance');
    expect(connectionFailureKind(`Projects: ${body.error}`)).toBe('maintenance');
  });

  it('treats transport and Remote Control failures as unreachable', () => {
    expect(connectionFailureKind(new TypeError('Network request failed'))).toBe('unreachable');
    expect(connectionFailureKind(new TypeError('Failed to fetch'))).toBe('unreachable');
    expect(
      connectionFailureKind(
        'Uplink probe (Pinned TLS transport failed [NSURLErrorDomain:-1200:NO_AUTH_CHALLENGE]) and direct Core request failed: Pinned TLS transport failed',
      ),
    ).toBe('unreachable');
  });

  it('leaves real answers and cancellations to the screen', () => {
    expect(connectionFailureKind(new VerityApiError(404, 'session not found'))).toBeUndefined();
    // A sealed store also answers 503, but it is the server speaking.
    expect(
      connectionFailureKind(new VerityApiError(503, 'secret store is sealed')),
    ).toBeUndefined();
    expect(connectionFailureKind(new DOMException('aborted', 'AbortError'))).toBeUndefined();
    expect(connectionFailureKind('Could not save decision.')).toBeUndefined();
    expect(connectionFailureKind('Blocked by server maintenance window')).toBeUndefined();
    // Where DOMException is not an Error, a cancellation is still one.
    expect(connectionFailureKind({ name: 'AbortError', message: 'aborted' })).toBeUndefined();
    expect(
      connectionFailureKind(new VerityApiError(409, 'blocked by server maintenance window')),
    ).toBeUndefined();
    // The server's own words are an answer even when they read like a transport error.
    expect(
      connectionFailureKind(new VerityApiError(502, 'Failed to fetch upstream')),
    ).toBeUndefined();
  });
});

describe('ConnectionMonitor', () => {
  it('shows an update at once and checks again with backoff until it ends', async () => {
    const clock = fakeTimers();
    const probe = vi.fn((): Promise<unknown> =>
      Promise.reject(new VerityApiError(503, SERVER_MAINTENANCE_MESSAGE)),
    );
    const monitor = new ConnectionMonitor({ probe, timers: clock.timers });
    const recovered = vi.fn();
    monitor.onRecovered(recovered);

    monitor.reportFailure('maintenance', SERVER_MAINTENANCE_MESSAGE);
    expect(monitor.getState()).toMatchObject({ kind: 'maintenance', since: 1_000 });
    expect(clock.delays()).toEqual([2_000]);

    clock.advance(2_000);
    await flush();
    expect(probe).toHaveBeenCalledTimes(1);
    expect(clock.delays()).toEqual([4_000]);
    clock.advance(4_000);
    await flush();
    clock.advance(8_000);
    await flush();
    clock.advance(15_000);
    await flush();
    // Capped: a long update is not polled ever more rarely.
    expect(clock.delays()).toEqual([15_000]);

    probe.mockImplementation(() => {
      monitor.reportSuccess();
      return Promise.resolve();
    });
    clock.advance(15_000);
    await flush();
    expect(monitor.getState()).toMatchObject({
      kind: 'connected',
      recoveredAt: expect.any(Number),
    });
    expect(recovered).toHaveBeenCalledTimes(1);
    expect(clock.delays()).toEqual([]);
  });

  it('confirms a single transport failure before showing it', async () => {
    const clock = fakeTimers();
    let answer: 'ok' | 'down' = 'ok';
    const probe = vi.fn(() =>
      answer === 'ok' ? Promise.resolve() : Promise.reject(new TypeError('Network request failed')),
    );
    const monitor = new ConnectionMonitor({ probe, timers: clock.timers });
    const listener = vi.fn();
    monitor.subscribe(listener);

    monitor.reportFailure('unreachable', 'Network request failed');
    await flush();
    expect(probe).toHaveBeenCalledTimes(1);
    expect(monitor.getState().kind).toBe('connected');
    expect(listener).not.toHaveBeenCalled();

    answer = 'down';
    monitor.reportFailure('unreachable', 'Network request failed');
    await flush();
    expect(monitor.getState()).toMatchObject({
      kind: 'unreachable',
      details: 'Network request failed',
    });
  });

  it('retries at once on request and forgets everything on reset', async () => {
    const clock = fakeTimers();
    const probe = vi.fn(() => Promise.reject(new TypeError('Network request failed')));
    const monitor = new ConnectionMonitor({ probe, timers: clock.timers });
    monitor.reportFailure('maintenance', SERVER_MAINTENANCE_MESSAGE);
    monitor.retryNow();
    await flush();
    expect(probe).toHaveBeenCalledTimes(1);
    expect(monitor.getState().kind).toBe('unreachable');

    monitor.reset();
    expect(monitor.getState()).toEqual({
      kind: 'connected',
      recoveredAt: undefined,
      lastConnectedAt: undefined,
    });
    expect(clock.delays()).toEqual([]);
  });
});

describe('ConnectionMonitor robustness', () => {
  it('gives up on a check that hangs, so the outage is shown and retried', async () => {
    const clock = fakeTimers();
    const probe = vi.fn(() => new Promise<never>(() => undefined));
    const monitor = new ConnectionMonitor({ probe, timers: clock.timers, checkTimeoutMs: 10_000 });
    monitor.reportFailure('unreachable', 'Network request failed');
    expect(monitor.getState().kind).toBe('connected');
    clock.advance(10_000);
    await flush();
    expect(monitor.getState()).toMatchObject({ kind: 'unreachable' });
    expect(clock.delays()).toEqual([2_000]);
  });

  // While the Gateway drains, requests begun before the update still finish
  // with an answer. Taking that for a recovery would reload every screen into
  // the next 503 and flap the bar between "updating" and "Connected".
  it('lets only its own check end an outage, not a late answer', async () => {
    const clock = fakeTimers();
    let up = false;
    const probe = vi.fn(() =>
      up ? Promise.resolve() : Promise.reject(new VerityApiError(503, SERVER_MAINTENANCE_MESSAGE)),
    );
    const monitor = new ConnectionMonitor({ probe, timers: clock.timers });
    const recovered = vi.fn();
    monitor.onRecovered(recovered);
    monitor.reportFailure('maintenance', SERVER_MAINTENANCE_MESSAGE);
    monitor.reportSuccess();
    expect(monitor.getState().kind).toBe('maintenance');
    expect(recovered).not.toHaveBeenCalled();
    up = true;
    clock.advance(2_000);
    await flush();
    expect(monitor.getState().kind).toBe('connected');
    expect(recovered).toHaveBeenCalledTimes(1);
  });

  it('ignores a confirming check that fails after the server has answered', async () => {
    const clock = fakeTimers();
    const probe = vi.fn(() => new Promise<never>(() => undefined));
    const monitor = new ConnectionMonitor({ probe, timers: clock.timers, checkTimeoutMs: 10_000 });
    monitor.reportFailure('unreachable', 'Network request failed');
    monitor.reportSuccess();
    // The hanging check times out only now; it must not start an outage.
    clock.advance(10_000);
    await flush();
    expect(monitor.getState().kind).toBe('connected');
  });

  it('starts the backoff at its first step when the confirming check finds an update', async () => {
    const clock = fakeTimers();
    const monitor = new ConnectionMonitor({ timers: clock.timers });
    // Like the app's probe: its own request reports before it rejects.
    monitor.setProbe(() => {
      monitor.reportFailure('maintenance', SERVER_MAINTENANCE_MESSAGE);
      return Promise.reject(new VerityApiError(503, SERVER_MAINTENANCE_MESSAGE));
    });
    monitor.reportFailure('unreachable', 'Network request failed');
    await flush();
    expect(monitor.getState().kind).toBe('maintenance');
    expect(clock.delays()).toEqual([2_000]);
  });

  it('keeps counting down while no check is available yet', () => {
    const clock = fakeTimers();
    const monitor = new ConnectionMonitor({ timers: clock.timers });
    monitor.reportFailure('maintenance', SERVER_MAINTENANCE_MESSAGE);
    clock.advance(2_000);
    expect(monitor.getState()).toMatchObject({
      kind: 'maintenance',
      nextAttemptAt: expect.any(Number),
    });
    expect(clock.delays()).toEqual([4_000]);
    monitor.reset();
  });

  it('never runs two checks at once when an update starts during a confirming check', async () => {
    const clock = fakeTimers();
    let settle: (() => void) | undefined;
    const probe = vi.fn(
      () =>
        new Promise<never>((_, reject) => {
          settle = () => reject(new VerityApiError(503, SERVER_MAINTENANCE_MESSAGE));
        }),
    );
    const monitor = new ConnectionMonitor({ probe, timers: clock.timers });
    monitor.reportFailure('unreachable', 'Network request failed');
    // Another request meets the Gateway while the confirming check still runs.
    monitor.reportFailure('maintenance', SERVER_MAINTENANCE_MESSAGE);
    expect(monitor.getState().kind).toBe('maintenance');
    clock.advance(2_000);
    expect(probe).toHaveBeenCalledTimes(1);
    settle?.();
    await flush();
    expect(clock.delays()).toEqual([2_000]);
  });

  it('ignores late answers from clients of the previous server', () => {
    const monitor = new ConnectionMonitor();
    const previous = monitor.reporter();
    monitor.reset();
    previous.reportFailure('maintenance', SERVER_MAINTENANCE_MESSAGE);
    expect(monitor.getState().kind).toBe('connected');
    monitor.reporter().reportFailure('maintenance', SERVER_MAINTENANCE_MESSAGE);
    expect(monitor.getState().kind).toBe('maintenance');
    monitor.reset();
  });

  it('keeps reporting after a stale check was discarded', async () => {
    const clock = fakeTimers();
    const monitor = new ConnectionMonitor({
      probe: () => new Promise<never>(() => undefined),
      timers: clock.timers,
    });
    const reporter = monitor.reporter();
    reporter.reportFailure('unreachable', 'Network request failed');
    reporter.reportSuccess();
    reporter.reportFailure('maintenance', SERVER_MAINTENANCE_MESSAGE);
    expect(monitor.getState().kind).toBe('maintenance');
    monitor.reset();
  });

  it('treats a probe failure in unfamiliar words as the server still away', async () => {
    const clock = fakeTimers();
    const probe = vi.fn(() => Promise.reject(new Error('The request timed out.')));
    const monitor = new ConnectionMonitor({ probe, timers: clock.timers });
    const recovered = vi.fn();
    monitor.onRecovered(recovered);
    monitor.reportFailure('maintenance', SERVER_MAINTENANCE_MESSAGE);
    clock.advance(2_000);
    await flush();
    expect(monitor.getState().kind).toBe('unreachable');
    expect(recovered).not.toHaveBeenCalled();
    monitor.reset();
  });

  it('keeps the failure that names the routes when a later check times out', async () => {
    const clock = fakeTimers();
    const dump = 'Uplink probe (Pinned TLS transport failed) and direct Core request failed';
    const monitor = new ConnectionMonitor({
      probe: () => new Promise<never>(() => undefined),
      timers: clock.timers,
      checkTimeoutMs: 10_000,
    });
    monitor.reportFailure('unreachable', dump);
    clock.advance(10_000);
    await flush();
    expect(monitor.getState()).toMatchObject({ kind: 'unreachable', details: dump });
    clock.advance(2_000 + 10_000);
    await flush();
    expect(monitor.getState()).toMatchObject({ details: dump });
    monitor.reset();
  });

  it('keeps a throwing listener from stopping the others', async () => {
    const monitor = new ConnectionMonitor({ probe: () => Promise.resolve() });
    const after = vi.fn();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    monitor.onRecovered(() => {
      throw new Error('screen reload failed');
    });
    monitor.onRecovered(after);
    monitor.reportFailure('maintenance', SERVER_MAINTENANCE_MESSAGE);
    monitor.retryNow();
    await flush();
    expect(monitor.getState().kind).toBe('connected');
    expect(after).toHaveBeenCalledTimes(1);
    warn.mockRestore();
    monitor.reset();
  });
});

describe('VerityClient connection reporting', () => {
  const client = (fetch: typeof globalThis.fetch) => {
    const reporter = { reportSuccess: vi.fn(), reportFailure: vi.fn() };
    return {
      reporter,
      client: new VerityClient({ baseUrl: 'http://host', fetch, connection: reporter }),
    };
  };

  it('reports the Gateway maintenance answer', async () => {
    const body = gatewayMaintenanceBody();
    const { reporter, client: api } = client(
      vi.fn(
        async () =>
          new Response(body, { status: 503, headers: { 'content-type': 'application/json' } }),
      ),
    );
    await expect(api.getHealth()).rejects.toBeInstanceOf(VerityApiError);
    expect(reporter.reportFailure).toHaveBeenCalledWith('maintenance', SERVER_MAINTENANCE_MESSAGE);
    expect(reporter.reportSuccess).not.toHaveBeenCalled();
  });

  it('reports transport failures but not cancellations', async () => {
    const { reporter, client: api } = client(
      vi.fn(async () => {
        throw new TypeError('Network request failed');
      }),
    );
    await expect(api.getHealth()).rejects.toThrow('Network request failed');
    expect(reporter.reportFailure).toHaveBeenCalledWith('unreachable', 'Network request failed');

    const aborted = client(
      vi.fn(async () => {
        throw new DOMException('aborted', 'AbortError');
      }),
    );
    await expect(aborted.client.getHealth()).rejects.toThrow();
    expect(aborted.reporter.reportFailure).not.toHaveBeenCalled();
  });

  it('counts any other answer, including an error, as the server being there', async () => {
    const { reporter, client: api } = client(
      vi.fn(
        async () =>
          new Response('{"error":"secret store is sealed"}', {
            status: 503,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );
    await expect(api.getHealth()).rejects.toBeInstanceOf(VerityApiError);
    expect(reporter.reportSuccess).toHaveBeenCalledTimes(1);
    expect(reporter.reportFailure).not.toHaveBeenCalled();
  });
});
