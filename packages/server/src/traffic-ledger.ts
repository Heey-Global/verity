import type { FastifyInstance, FastifyRequest } from 'fastify';

const DEFAULT_REPORT_INTERVAL_MS = 5 * 60_000;
const REPORTED_ENTRIES = 15;
/** Route patterns are bounded by the route table, frame kinds by the protocol;
 * the cap only guards against an unexpected key explosion. */
const MAX_KEYS = 512;

interface Tally {
  count: number;
  bodyBytes: number;
  wireBytes: number;
  notModified: number;
}

/**
 * Counts what the server sends to apps, per route pattern and per live frame
 * kind, and logs the largest totals at a fixed interval. It answers "which
 * reads move the bytes" without recording URLs, identities or content.
 *
 * `bodyBytes` is the serialized body before compression. `wireBytes` is what
 * left the socket for the response, measured from the socket's own counter and
 * therefore including headers and compression. It is approximate where
 * responses overlap on one socket (HTTP/2) and 0 where the transport has no
 * socket of its own.
 */
export class TrafficLedger {
  private readonly tallies = new Map<string, Tally>();
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly log: (summary: object, message: string) => void,
    private readonly intervalMs = DEFAULT_REPORT_INTERVAL_MS,
  ) {}

  start(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => this.report(), this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  record(
    key: string,
    sample: { bodyBytes: number; wireBytes?: number; notModified?: boolean },
  ): void {
    let tally = this.tallies.get(key);
    if (tally === undefined) {
      if (this.tallies.size >= MAX_KEYS) return;
      tally = { count: 0, bodyBytes: 0, wireBytes: 0, notModified: 0 };
      this.tallies.set(key, tally);
    }
    tally.count += 1;
    tally.bodyBytes += sample.bodyBytes;
    tally.wireBytes += sample.wireBytes ?? 0;
    if (sample.notModified === true) tally.notModified += 1;
  }

  /** The current totals, largest first; resets the window. */
  drain(): { key: string; tally: Tally }[] {
    const entries = [...this.tallies].map(([key, tally]) => ({ key, tally }));
    this.tallies.clear();
    return entries.sort(
      (a, b) =>
        Math.max(b.tally.wireBytes, b.tally.bodyBytes) -
        Math.max(a.tally.wireBytes, a.tally.bodyBytes),
    );
  }

  report(): void {
    const entries = this.drain();
    if (entries.length === 0) return;
    const total = entries.reduce(
      (sum, { tally }) => ({
        bodyBytes: sum.bodyBytes + tally.bodyBytes,
        wireBytes: sum.wireBytes + tally.wireBytes,
      }),
      { bodyBytes: 0, wireBytes: 0 },
    );
    this.log(
      {
        windowMs: this.intervalMs,
        ...total,
        top: entries.slice(0, REPORTED_ENTRIES).map(({ key, tally }) => ({ key, ...tally })),
      },
      'outbound traffic summary',
    );
  }
}

function byteLength(payload: unknown): number {
  if (typeof payload === 'string') return Buffer.byteLength(payload);
  if (Buffer.isBuffer(payload)) return payload.length;
  return 0;
}

/** Attach the ledger to every HTTP response. */
export function registerTrafficLedger(app: FastifyInstance, ledger: TrafficLedger): void {
  const started = new WeakMap<FastifyRequest, { socketBytes: number; bodyBytes: number }>();
  app.addHook('onRequest', (request, _reply, done) => {
    started.set(request, { socketBytes: request.raw.socket?.bytesWritten ?? 0, bodyBytes: 0 });
    done();
  });
  // Global onSend hooks run before route-level ones such as compression, so
  // this sees the serialized body; the socket counter below sees the wire.
  app.addHook('onSend', (request, _reply, payload, done) => {
    const entry = started.get(request);
    if (entry !== undefined) entry.bodyBytes = byteLength(payload);
    done(null, payload);
  });
  app.addHook('onResponse', (request, reply, done) => {
    const entry = started.get(request);
    const route = request.routeOptions.url;
    if (entry !== undefined && route !== undefined) {
      const socketBytes = request.raw.socket?.bytesWritten;
      const notModified = reply.statusCode === 304;
      ledger.record(`${request.method} ${route}`, {
        // A route-level hook can still turn the serialized body into a bodiless
        // 304 after the global onSend saw it; those bytes were never sent.
        bodyBytes: notModified ? 0 : entry.bodyBytes,
        wireBytes: socketBytes === undefined ? 0 : Math.max(0, socketBytes - entry.socketBytes),
        notModified,
      });
    }
    done();
  });
  app.addHook('onClose', (_instance, done) => {
    ledger.stop();
    done();
  });
  ledger.start();
}
