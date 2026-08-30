import { createServer, request as httpRequest, type Server } from 'node:http';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CodexCredentialUnavailableError } from './codex-sign-in-error.js';
import {
  createCodexEgressGatewayHandler,
  type CodexEgressForward,
  type CodexEgressRequestEnd,
  type CodexEgressRequestObserver,
} from './codex-egress-gateway.js';

const AUTHORITY = 'codex-proxy:9444';
/** Real timers throughout — these tests drive real sockets, so the deadline is
 *  scaled down rather than faked. */
const IDLE_MS = 150;
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

describe('Codex egress gateway handler', () => {
  it('streams request and response while keeping real credentials upstream-only', async () => {
    let seenBody = '';
    const forward: CodexEgressForward = async (request) => {
      for await (const chunk of request.body as AsyncIterable<Buffer>) {
        seenBody += chunk.toString('utf8');
      }
      expect(request.url.href).toBe('https://chatgpt.com/backend-api/codex/responses');
      expect(request.headers.get('authorization')).toBe('Bearer server-only-token');
      expect(request.headers.get('chatgpt-account-id')).toBe('account-1');
      return {
        status: 200,
        headers: {
          'content-type': 'text/event-stream',
          'x-codex-primary-used-percent': '12',
          connection: 'keep-alive',
        },
        body: Readable.from(['data: one\n\n', 'data: two\n\n']),
      };
    };
    const credential = vi.fn(async () => ({
      accessToken: 'server-only-token',
      accountId: 'account-1',
    }));
    const port = await serve(forward, credential);

    const result = await call(port, {
      path: '/codex/responses',
      method: 'POST',
      headers: {
        host: AUTHORITY,
        authorization: 'Bearer verity-codex-gateway-placeholder-v1',
        'content-type': 'application/json',
      },
      body: '{"input":"hello"}',
    });

    expect(result).toEqual({
      status: 200,
      body: 'data: one\n\ndata: two\n\n',
      quota: '12',
    });
    expect(seenBody).toBe('{"input":"hello"}');
    expect(JSON.stringify(result)).not.toContain('server-only-token');
  });

  it('rejects caller-controlled credentials before resolving the gateway login', async () => {
    const credential = vi.fn(async () => ({
      accessToken: 'server-only-token',
      accountId: 'account-1',
    }));
    const forward = vi.fn<CodexEgressForward>();
    const port = await serve(forward, credential);

    const result = await call(port, {
      path: '/codex/models',
      headers: {
        host: AUTHORITY,
        authorization: 'Bearer verity-codex-gateway-placeholder-v1',
        'chatgpt-account-id': 'attacker-account',
      },
    });

    expect(result.status).toBe(403);
    expect(credential).not.toHaveBeenCalled();
    expect(forward).not.toHaveBeenCalled();
  });

  it('preserves an upstream 401 and asks the single authority to rotate for the next request', async () => {
    const refresh = vi.fn(async () => undefined);
    const port = await serve(
      async () => ({ status: 401, headers: {}, body: Readable.from(['unauthorized']) }),
      async () => ({ accessToken: 'stale-token', accountId: 'account-1' }),
      refresh,
    );

    await expect(
      call(port, {
        path: '/codex/models',
        headers: {
          host: AUTHORITY,
          authorization: 'Bearer verity-codex-gateway-placeholder-v1',
        },
      }),
    ).resolves.toEqual({ status: 401, body: 'unauthorized', quota: undefined });
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
  });

  it('records a completed request without credentials or content', async () => {
    const events: CodexEgressRequestEnd[] = [];
    const port = await serve(
      async () => ({ status: 200, headers: {}, body: Readable.from(['data: one\n\n']) }),
      async () => ({ accessToken: 'server-only-token', accountId: 'account-1' }),
      undefined,
      (event) => events.push(event),
    );

    await call(port, {
      path: '/codex/models',
      headers: { host: AUTHORITY, authorization: 'Bearer verity-codex-gateway-placeholder-v1' },
    });
    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(events[0]).toMatchObject({
      outcome: 'completed',
      reason: 'ok',
      status: 200,
      method: 'GET',
      path: '/codex/models',
      bytesForwarded: 'data: one\n\n'.length,
      projectId: 'project-1',
    });
    expect(JSON.stringify(events)).not.toContain('server-only-token');
  });

  it('records a consumer close after a successful partial response as neutral', async () => {
    const events: CodexEgressRequestEnd[] = [];
    const port = await serve(
      async (request) => {
        const body = new Readable({ read() {} });
        body.push('data: result\n\n');
        request.signal.addEventListener('abort', () => body.destroy(), { once: true });
        return { status: 200, headers: { 'content-type': 'text/event-stream' }, body };
      },
      async () => ({ accessToken: 'server-only-token', accountId: 'account-1' }),
      undefined,
      (event) => events.push(event),
    );
    const request = httpRequest({
      host: '127.0.0.1',
      port,
      path: '/codex/responses',
      method: 'POST',
      headers: { host: AUTHORITY, authorization: 'Bearer verity-codex-gateway-placeholder-v1' },
    });
    request.once('error', () => undefined);
    request.once('response', (response) => {
      response.once('data', () => response.destroy());
      response.once('error', () => undefined);
    });
    request.end();

    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(events[0]).toMatchObject({
      outcome: 'consumer-closed',
      reason: 'downstream-closed',
      status: 200,
      bytesForwarded: 'data: result\n\n'.length,
    });
  });

  it('records a policy rejection with fixed labels and no unauthenticated project', async () => {
    const events: CodexEgressRequestEnd[] = [];
    const port = await serve(
      vi.fn<CodexEgressForward>(),
      vi.fn(async () => ({ accessToken: 'unused', accountId: 'unused' })),
      undefined,
      (event) => events.push(event),
      () => undefined,
    );
    await call(port, {
      path: '/codex/models?token=attacker-value',
      headers: { host: AUTHORITY, authorization: 'Bearer attacker-value' },
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      outcome: 'rejected',
      reason: 'policy-rejected',
      status: 403,
      path: '/codex/models',
      bytesForwarded: 0,
    });
    expect(events[0]).not.toHaveProperty('projectId');
    expect(JSON.stringify(events)).not.toContain('attacker-value');
  });

  it.each([
    {
      name: 'credential failure',
      credential: () =>
        Promise.reject(new CodexCredentialUnavailableError('sensitive credential detail')),
      reason: 'credential-unavailable',
      status: 503,
    },
    {
      name: 'upstream failure',
      credential: () =>
        Promise.resolve({ accessToken: 'server-only-token', accountId: 'account-1' }),
      reason: 'Error/ETIMEDOUT',
      status: 502,
    },
  ])('classifies $name without logging raw error text', async ({ credential, reason, status }) => {
    const events: CodexEgressRequestEnd[] = [];
    const forward = vi.fn<CodexEgressForward>(() =>
      Promise.reject(
        Object.assign(new Error('sensitive provider response'), { code: 'ETIMEDOUT' }),
      ),
    );
    const port = await serve(forward, credential, undefined, (event) => events.push(event));

    await call(port, {
      path: '/codex/models',
      headers: { host: AUTHORITY, authorization: 'Bearer verity-codex-gateway-placeholder-v1' },
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ outcome: 'rejected', reason, status, bytesForwarded: 0 });
    expect(JSON.stringify(events)).not.toContain('sensitive');
  });

  it('records a classified mid-response failure exactly once', async () => {
    const events: CodexEgressRequestEnd[] = [];
    const port = await serve(
      async () => {
        const body = new Readable({ read() {} });
        body.push('partial');
        setTimeout(
          () =>
            body.destroy(
              Object.assign(new Error('sensitive upstream text'), { code: 'ECONNRESET' }),
            ),
          5,
        );
        return { status: 200, headers: {}, body };
      },
      async () => ({ accessToken: 'server-only-token', accountId: 'account-1' }),
      undefined,
      (event) => events.push(event),
    );
    const aborted = httpRequest({
      host: '127.0.0.1',
      port,
      path: '/codex/responses',
      method: 'POST',
      headers: { host: AUTHORITY, authorization: 'Bearer verity-codex-gateway-placeholder-v1' },
    });
    aborted.once('error', () => undefined);
    aborted.once('response', (response) => {
      response.on('data', () => undefined);
      response.once('error', () => undefined);
    });
    aborted.end();

    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(events[0]).toMatchObject({
      outcome: 'aborted',
      reason: 'Error/ECONNRESET',
      status: 200,
      bytesForwarded: 'partial'.length,
    });
    expect(JSON.stringify(events)).not.toContain('sensitive upstream text');
  });

  it('refuses a malformed stream deadline at startup', () => {
    // `setTimeout(fn, NaN)` fires on the next tick, so a misparsed configuration
    // value would abort every stream instead of supervising none.
    expect(() =>
      createCodexEgressGatewayHandler({
        listenerAuthority: AUTHORITY,
        authenticatePeer: () => 'project-1',
        credential: async () => ({ accessToken: 'unused', accountId: 'unused' }),
        streamIdleTimeoutMs: Number.NaN,
      }),
    ).toThrow('must be zero or a supported positive delay');
  });

  it('ends a response stream whose upstream stops producing', async () => {
    const events: CodexEgressRequestEnd[] = [];
    const silent = new Readable({ read() {} });
    silent.push('data: one\n\n');
    const port = await serve(
      async () => ({ status: 200, headers: {}, body: silent }),
      async () => ({ accessToken: 'server-only-token', accountId: 'account-1' }),
      undefined,
      (event) => events.push(event),
      undefined,
      IDLE_MS,
    );
    const stalled = stream(port);

    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(events[0]).toMatchObject({
      outcome: 'aborted',
      reason: 'upstream-idle',
      status: 200,
      bytesForwarded: 'data: one\n\n'.length,
    });
    // The sandbox is told, rather than left holding a response that never ends.
    await expect(stalled.ended).resolves.toBe('broken');
  });

  it('leaves a slow but progressing stream alone', async () => {
    const events: CodexEgressRequestEnd[] = [];
    const slow = new Readable({ read() {} });
    void (async () => {
      for (let index = 0; index < 5; index += 1) {
        // A quarter of the deadline, not most of it: this asserts that a slow
        // producer survives, so a loaded runner must not be able to turn it into
        // "the gateway killed a healthy stream".
        await new Promise((resolve) => setTimeout(resolve, IDLE_MS * 0.25));
        slow.push(`data: ${index}\n\n`);
      }
      slow.push(null);
    })();
    const port = await serve(
      async () => ({ status: 200, headers: {}, body: slow }),
      async () => ({ accessToken: 'server-only-token', accountId: 'account-1' }),
      undefined,
      (event) => events.push(event),
      undefined,
      IDLE_MS,
    );

    const result = await call(port, {
      path: '/codex/responses',
      method: 'POST',
      headers: { host: AUTHORITY, authorization: 'Bearer verity-codex-gateway-placeholder-v1' },
    });

    expect(result.body).toBe('data: 0\n\ndata: 1\n\ndata: 2\n\ndata: 3\n\ndata: 4\n\n');
    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(events[0]).toMatchObject({ outcome: 'completed', reason: 'ok' });
  });

  it('never arms the deadline when the supervision is disabled', async () => {
    const events: CodexEgressRequestEnd[] = [];
    const silent = new Readable({ read() {} });
    silent.push('data: one\n\n');
    const port = await serve(
      async () => ({ status: 200, headers: {}, body: silent }),
      async () => ({ accessToken: 'server-only-token', accountId: 'account-1' }),
      undefined,
      (event) => events.push(event),
      undefined,
      0,
    );
    const held = stream(port);

    await new Promise((resolve) => setTimeout(resolve, IDLE_MS * 4));
    expect(events).toHaveLength(0);
    // End it the way the network would have, which also pins that a REAL
    // transport failure keeps its own label rather than the idle one.
    silent.destroy(Object.assign(new Error('upstream reset'), { code: 'ECONNRESET' }));
    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(events[0]).toMatchObject({ outcome: 'aborted', reason: 'Error/ECONNRESET' });
    await expect(held.ended).resolves.toBe('broken');
  });

  it('records one cancellation before response headers', async () => {
    const events: CodexEgressRequestEnd[] = [];
    let forwardStarted!: () => void;
    const started = new Promise<void>((resolve) => (forwardStarted = resolve));
    const port = await serve(
      (request) => {
        forwardStarted();
        return new Promise((_, reject) =>
          request.signal.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          }),
        );
      },
      async () => ({ accessToken: 'server-only-token', accountId: 'account-1' }),
      undefined,
      (event) => events.push(event),
    );
    const cancelled = httpRequest({
      host: '127.0.0.1',
      port,
      path: '/codex/responses',
      method: 'POST',
      headers: { host: AUTHORITY, authorization: 'Bearer verity-codex-gateway-placeholder-v1' },
    });
    cancelled.once('error', () => undefined);
    cancelled.end();
    await started;
    cancelled.destroy();

    await vi.waitFor(() => expect(events).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      outcome: 'cancelled',
      reason: 'sandbox-closed',
      status: 0,
      bytesForwarded: 0,
    });
  });

  it('keeps the response intact when the observer throws', async () => {
    const port = await serve(
      async () => ({ status: 200, headers: {}, body: Readable.from(['ok']) }),
      async () => ({ accessToken: 'server-only-token', accountId: 'account-1' }),
      undefined,
      () => {
        throw new Error('observer failed');
      },
    );
    await expect(
      call(port, {
        path: '/codex/models',
        headers: {
          host: AUTHORITY,
          authorization: 'Bearer verity-codex-gateway-placeholder-v1',
        },
      }),
    ).resolves.toEqual({ status: 200, body: 'ok', quota: undefined });
  });

  it('collapses attacker-controlled route, method, and project strings', async () => {
    const events: CodexEgressRequestEnd[] = [];
    const port = await serve(
      vi.fn<CodexEgressForward>(),
      vi.fn(async () => ({ accessToken: 'unused', accountId: 'unused' })),
      undefined,
      (event) => events.push(event),
      () => 'project\nforged-secret',
    );
    await call(port, {
      path: '/codex/secret-value?value=secret',
      method: 'PURGE',
      headers: { host: AUTHORITY, authorization: 'Bearer verity-codex-gateway-placeholder-v1' },
    });

    expect(events[0]).toMatchObject({ method: '<other>', path: '<other>', projectId: '<other>' });
    expect(JSON.stringify(events)).not.toContain('secret');
    expect(JSON.stringify(events)).not.toContain('forged');
  });
});

async function serve(
  forward: CodexEgressForward,
  credential: () => Promise<{ accessToken: string; accountId: string }>,
  refreshAfterUnauthorized?: (previousAccessToken: string) => Promise<unknown>,
  onRequestEnd?: CodexEgressRequestObserver,
  authenticatePeer: () => string | undefined = () => 'project-1',
  streamIdleTimeoutMs?: number,
): Promise<number> {
  const server = createServer(
    createCodexEgressGatewayHandler({
      listenerAuthority: AUTHORITY,
      authenticatePeer,
      credential,
      ...(refreshAfterUnauthorized === undefined ? {} : { refreshAfterUnauthorized }),
      ...(onRequestEnd === undefined ? {} : { onRequestEnd }),
      ...(streamIdleTimeoutMs === undefined ? {} : { streamIdleTimeoutMs }),
      forward,
    }),
  );
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (typeof address !== 'object' || address === null) throw new Error('server did not listen');
  return address.port;
}

/** Start a streaming request and answer how its response ENDED — `broken` for a
 *  response the gateway tore down mid-stream, which is what the sandbox needs to
 *  see instead of waiting forever on a silent upstream. */
function stream(port: number): {
  request: ReturnType<typeof httpRequest>;
  ended: Promise<'broken' | 'complete'>;
} {
  const request = httpRequest({
    host: '127.0.0.1',
    port,
    path: '/codex/responses',
    method: 'POST',
    headers: { host: AUTHORITY, authorization: 'Bearer verity-codex-gateway-placeholder-v1' },
  });
  const ended = new Promise<'broken' | 'complete'>((resolve) => {
    request.once('error', () => resolve('broken'));
    request.once('response', (response) => {
      response.on('data', () => undefined);
      response.once('error', () => resolve('broken'));
      response.once('aborted', () => resolve('broken'));
      response.once('end', () => resolve('complete'));
    });
  });
  request.end();
  return { request, ended };
}

function call(
  port: number,
  input: {
    path: string;
    method?: string;
    headers: Record<string, string>;
    body?: string;
  },
): Promise<{ status: number; body: string; quota: string | undefined }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path: input.path,
        method: input.method ?? 'GET',
        headers: input.headers,
      },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => (body += chunk));
        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            body,
            quota:
              typeof response.headers['x-codex-primary-used-percent'] === 'string'
                ? response.headers['x-codex-primary-used-percent']
                : undefined,
          }),
        );
      },
    );
    request.once('error', reject);
    request.end(input.body);
  });
}
