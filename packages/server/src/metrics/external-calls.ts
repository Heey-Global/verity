import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import diagnostics from 'node:diagnostics_channel';
import { isIP } from 'node:net';

/**
 * Outbound calls of the server process (ADR 0032): every request made with
 * `fetch` (undici) or `node:http`/`node:https`, observed through Node's
 * diagnostics channels, so no call site has to remember to count itself.
 *
 * Calls are labelled by a closed set of targets and by their cause: the route
 * template of the HTTP request that triggered them, a named background reader
 * (`github:session-status`), or `background`. URLs, query strings and host
 * names of unknown services are never kept; identical reads are recognised by
 * a hash that lives only in memory for a few seconds.
 *
 * Not seen: calls made by child processes (git, gh, docker CLIs), by agents in
 * their sandboxes, and connections that fail before a request is sent.
 */

const EXTERNAL_TARGETS = [
  'github',
  'google',
  'anthropic',
  'openai',
  'doppler',
  'apple',
  'expo',
  'registry',
  'verity',
  'internal',
  'other',
] as const;
export type ExternalTarget = (typeof EXTERNAL_TARGETS)[number];

const DOMAINS: readonly (readonly [ExternalTarget, readonly string[]])[] = [
  ['github', ['github.com', 'githubusercontent.com']],
  ['registry', ['ghcr.io', 'docker.io', 'npmjs.org', 'quay.io', 'pkg.dev']],
  ['google', ['googleapis.com', 'google.com']],
  ['anthropic', ['anthropic.com', 'claude.com', 'claude.ai']],
  ['openai', ['openai.com', 'chatgpt.com']],
  ['doppler', ['doppler.com']],
  ['apple', ['apple.com']],
  ['expo', ['expo.dev', 'exp.host', 'expo.io']],
  ['verity', ['verity.build']],
];

function isPrivateAddress(host: string): boolean {
  const version = isIP(host);
  if (version === 4) {
    const [a = 0, b = 0] = host.split('.').map(Number);
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  if (version === 6) return host === '::1' || /^f[cd]/i.test(host) || /^fe80/i.test(host);
  return false;
}

/** The target a host belongs to; unknown public hosts are `other`, never named. */
export function classifyTarget(host: string | undefined): ExternalTarget {
  const name = (host ?? '')
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
  if (
    name === '' ||
    name === 'localhost' ||
    isPrivateAddress(name) ||
    !name.includes('.') ||
    /\.(local|internal|lan|home\.arpa|ts\.net)$/.test(name)
  )
    return 'internal';
  for (const [target, domains] of DOMAINS)
    if (domains.some((domain) => name === domain || name.endsWith(`.${domain}`))) return target;
  return 'other';
}

/** What a call is made for. One object per HTTP request; counts for detail mode. */
export interface ExternalCause {
  readonly cause: string;
  calls: number;
  durationMs: number;
}

const causes = new AsyncLocalStorage<ExternalCause>();

/** Runs `fn` with `cause` as the reason for every outbound call it makes. */
export function withExternalCause<T>(cause: string, fn: () => T): T {
  return causes.run(createCause(cause), fn);
}

/** A cause whose calls are collected in the object itself (one HTTP request). */
export function createCause(cause: string): ExternalCause {
  return { cause, calls: 0, durationMs: 0 };
}

/** Runs `fn` inside `context`, so every outbound call it makes counts there. */
export function runInCause<T>(context: ExternalCause, fn: () => T): T {
  return causes.run(context, fn);
}

export interface ExternalObservation {
  target: ExternalTarget;
  cause: string;
  method: string;
  /** HTTP status, or 0 when the request failed without a response. */
  status: number;
  durationMs: number;
  duplicate: boolean;
  rateLimit: { remaining: number; limit: number | null } | null;
}

const text = (value: unknown, fallback: string): string =>
  typeof value === 'string' ? value : fallback;

const DUPLICATE_WINDOW_MS = 2_000;
const MAX_RECENT_READS = 5_000;

type Header = string | string[] | undefined;

function headerOf(headers: unknown, wanted: string): string | undefined {
  // undici: a flat array of name/value buffers; node:http: an object.
  if (Array.isArray(headers)) {
    for (let index = 0; index + 1 < headers.length; index += 2) {
      if (String(headers[index]).toLowerCase() === wanted) return String(headers[index + 1]);
    }
    return undefined;
  }
  if (headers !== null && typeof headers === 'object') {
    const value = (headers as Record<string, Header>)[wanted];
    return Array.isArray(value) ? value[0] : value;
  }
  return undefined;
}

const REMAINING = [
  ['x-ratelimit-remaining', 'x-ratelimit-limit'],
  ['anthropic-ratelimit-requests-remaining', 'anthropic-ratelimit-requests-limit'],
  ['x-ratelimit-remaining-requests', 'x-ratelimit-limit-requests'],
] as const;

function rateLimitOf(headers: unknown): ExternalObservation['rateLimit'] {
  for (const [remainingName, limitName] of REMAINING) {
    const remaining = Number(headerOf(headers, remainingName));
    if (headerOf(headers, remainingName) !== undefined && Number.isFinite(remaining)) {
      const limit = Number(headerOf(headers, limitName));
      return { remaining, limit: Number.isFinite(limit) && limit > 0 ? limit : null };
    }
  }
  return null;
}

interface Pending {
  target: ExternalTarget;
  cause: ExternalCause | undefined;
  method: string;
  startedAt: bigint;
  duplicate: boolean;
}

/**
 * Subscribes to the undici and `node:http` client channels while active. The
 * subscription costs nothing for calls while inactive: unsubscribed channels
 * are not published to.
 */
export class ExternalCallObserver {
  private readonly pending = new WeakMap<object, Pending>();
  private readonly recentReads = new Map<string, number>();
  private active = false;

  constructor(
    private readonly record: (observation: ExternalObservation) => void,
    private readonly now: () => number = Date.now,
  ) {}

  setActive(active: boolean): void {
    if (active === this.active) return;
    this.active = active;
    const change = active ? diagnostics.subscribe : diagnostics.unsubscribe;
    change('undici:request:create', this.onUndiciCreate);
    change('undici:request:headers', this.onUndiciHeaders);
    change('undici:request:error', this.onUndiciError);
    change('http.client.request.start', this.onHttpStart);
    change('http.client.response.finish', this.onHttpFinish);
    change('http.client.request.error', this.onHttpError);
    if (!active) this.recentReads.clear();
  }

  private start(request: object, host: string | undefined, method: string, path: string): void {
    const target = classifyTarget(host);
    const context = causes.getStore();
    this.pending.set(request, {
      target,
      cause: context,
      method: method.toUpperCase(),
      startedAt: process.hrtime.bigint(),
      duplicate: this.isDuplicateRead(method, host, path),
    });
  }

  /** The same read of the same resource within a moment of the last one. */
  private isDuplicateRead(method: string, host: string | undefined, path: string): boolean {
    if (method.toUpperCase() !== 'GET' && method.toUpperCase() !== 'HEAD') return false;
    const key = createHash('sha256')
      .update(`${method} ${host ?? ''} ${path}`)
      .digest('base64url');
    const now = this.now();
    const last = this.recentReads.get(key);
    this.recentReads.delete(key);
    this.recentReads.set(key, now);
    if (this.recentReads.size > MAX_RECENT_READS) {
      const oldest = this.recentReads.keys().next().value;
      if (oldest !== undefined) this.recentReads.delete(oldest);
    }
    return last !== undefined && now - last <= DUPLICATE_WINDOW_MS;
  }

  private finish(request: object, status: number, headers: unknown): void {
    const pending = this.pending.get(request);
    if (pending === undefined) return;
    this.pending.delete(request);
    const durationMs = Number(process.hrtime.bigint() - pending.startedAt) / 1e6;
    if (pending.cause !== undefined) {
      pending.cause.calls += 1;
      pending.cause.durationMs += durationMs;
    }
    this.record({
      target: pending.target,
      cause: pending.cause?.cause ?? 'background',
      method: pending.method,
      status,
      durationMs,
      duplicate: pending.duplicate,
      rateLimit: status === 0 ? null : rateLimitOf(headers),
    });
  }

  private readonly onUndiciCreate = (message: unknown): void => {
    const request = (
      message as { request?: { origin?: unknown; method?: unknown; path?: unknown } }
    ).request;
    if (request === undefined) return;
    let host: string | undefined;
    try {
      host = new URL(text(request.origin, '')).hostname;
    } catch {
      host = undefined;
    }
    this.start(request, host, text(request.method, 'GET'), text(request.path, ''));
  };

  private readonly onUndiciHeaders = (message: unknown): void => {
    const { request, response } = message as {
      request?: object;
      response?: { statusCode?: number; headers?: unknown };
    };
    if (request !== undefined) this.finish(request, response?.statusCode ?? 0, response?.headers);
  };

  private readonly onUndiciError = (message: unknown): void => {
    const { request } = message as { request?: object };
    if (request !== undefined) this.finish(request, 0, undefined);
  };

  private readonly onHttpStart = (message: unknown): void => {
    const request = (
      message as {
        request?: {
          host?: string;
          method?: string;
          path?: string;
          socketPath?: string;
          getHeader?: (name: string) => unknown;
        };
      }
    ).request;
    if (request === undefined) return;
    // A unix socket (the Docker API) is local, whatever host the request names.
    const host =
      request.socketPath !== undefined && request.socketPath !== null
        ? 'localhost'
        : (request.host ?? text(request.getHeader?.('host'), ''));
    this.start(request, host, request.method ?? 'GET', request.path ?? '');
  };

  private readonly onHttpFinish = (message: unknown): void => {
    const { request, response } = message as {
      request?: object;
      response?: { statusCode?: number; headers?: unknown };
    };
    if (request !== undefined) this.finish(request, response?.statusCode ?? 0, response?.headers);
  };

  private readonly onHttpError = (message: unknown): void => {
    const { request } = message as { request?: object };
    if (request !== undefined) this.finish(request, 0, undefined);
  };
}
