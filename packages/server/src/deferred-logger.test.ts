import { describe, expect, it, vi } from 'vitest';
import { createDeferredLogger, type LogSink } from './deferred-logger.js';

function recordingSink(): LogSink & { calls: unknown[][]; self: unknown[] } {
  return {
    calls: [] as unknown[][],
    self: [] as unknown[],
    info(...args: unknown[]) {
      // Recorded through `this`, not through the closure: a forwarder that
      // pulled the method off the sink would still push here if it also kept a
      // reference, but a pino logger's methods read `this`, so losing the
      // receiver is the failure this records.
      this.calls.push(args);
      this.self.push(this);
    },
    warn(...args: unknown[]) {
      this.calls.push(args);
      this.self.push(this);
    },
    error(...args: unknown[]) {
      this.calls.push(args);
      this.self.push(this);
    },
  };
}

describe('createDeferredLogger', () => {
  it('writes to the fallback before anything is bound', () => {
    const fallback = recordingSink();
    const log = createDeferredLogger(fallback);

    log.warn({ code: 4003 }, 'Uplink refused the control connection');

    // Not "it does nothing until bound": the boot window is when a client that
    // cannot reach its service first says so, and a dropped line there is the
    // whole reason this exists.
    expect(fallback.calls).toEqual([[{ code: 4003 }, 'Uplink refused the control connection']]);
  });

  it('routes to the bound sink for a holder that took the logger before the bind', () => {
    const fallback = recordingSink();
    const app = recordingSink();
    const log = createDeferredLogger(fallback);
    // The component under real conditions: constructed roughly a thousand lines
    // before `app.log` exists, holding this object across the bind. If the
    // forwarder resolved its sink once, at creation, this holder would keep
    // writing to the fallback forever - the production bug in another costume.
    const holder = { log } as { log: LogSink };

    log.bind(app);
    holder.log.info({ installationId: 'installation-1' }, 'Uplink admitted this installation');

    expect(app.calls).toEqual([
      [{ installationId: 'installation-1' }, 'Uplink admitted this installation'],
    ]);
    expect(fallback.calls).toEqual([]);
  });

  it('calls the bound sink as a method of that sink', () => {
    const app = recordingSink();
    const log = createDeferredLogger(recordingSink());

    log.bind(app);
    log.error({ err: new Error('boom') }, 'Uplink connection error');

    // `app.log` is pino, whose level methods are prototype methods reading
    // `this`. A forwarder that destructured them would throw here instead of
    // logging, and it would do it only in production - a recording double that
    // closes over its own array would not notice.
    expect(app.self).toEqual([app]);
  });

  it('forwards every level the client actually uses', () => {
    const app = recordingSink();
    const log = createDeferredLogger(recordingSink());
    log.bind(app);

    log.info('a');
    log.warn('b');
    log.error('c');

    expect(app.calls).toEqual([['a'], ['b'], ['c']]);
  });

  it('follows a rebind rather than pinning the first sink', () => {
    const first = recordingSink();
    const second = recordingSink();
    const log = createDeferredLogger(recordingSink());

    log.bind(first);
    log.bind(second);
    log.warn('after');

    expect(first.calls).toEqual([]);
    expect(second.calls).toEqual([['after']]);
  });

  it('defaults to writing every level to stderr', () => {
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const stdout = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    try {
      const log = createDeferredLogger();
      log.info('handshake');
      log.warn('refused');

      // A default of "discard" would make an omitted fallback silent, and a
      // default of `console` would put the info line on stdout - the stream
      // carrying pino's JSON, where an unstructured line is a parse error for
      // whatever reads it.
      expect(stderr.mock.calls).toEqual([['handshake'], ['refused']]);
      expect(stdout).not.toHaveBeenCalled();
    } finally {
      stderr.mockRestore();
      stdout.mockRestore();
    }
  });
});
