import { createServer, request as httpRequest, type Server } from 'node:http';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CLAUDE_EGRESS_PLACEHOLDER } from './claude-egress-policy.js';
import {
  closeServerBounded,
  createClaudeEgressGatewayHandler,
  DEFAULT_AGENT_GATEWAY_SHUTDOWN_GRACE_MS,
  type ClaudeEgressRequestEnd,
  type ClaudeEgressRequestObserver,
  type ClaudeEgressForward,
} from './claude-egress-gateway.js';

const PROJECT_ID = 'project-1';
const AUTHORITY = 'claude-proxy.project-1:9443';
/** Real timers throughout — these tests drive real sockets, so the deadline is
 *  scaled down rather than faked. */
const IDLE_MS = 150;
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

describe('Claude egress HTTPS gateway handler', () => {
  it('uses a turn-scale default shutdown grace', () => {
    expect(DEFAULT_AGENT_GATEWAY_SHUTDOWN_GRACE_MS).toBe(10 * 60 * 1_000);
  });

  it('streams the request and response while keeping the real token upstream-only', async () => {
    let seenBody = '';
    const forward: ClaudeEgressForward = async (request) => {
      for await (const chunk of request.body as AsyncIterable<Buffer>) {
        seenBody += chunk.toString('utf8');
      }
      expect(request.url.href).toBe('https://api.anthropic.com/v1/messages');
      expect(request.method).toBe('POST');
      expect(request.headers.get('authorization')).toBe('Bearer server-only-token');
      expect(request.redirect).toBe('manual');
      return {
        status: 200,
        headers: { 'content-type': 'application/json', connection: 'keep-alive' },
        body: Readable.from(['{"ok":', 'true}']),
      };
    };
    const accessToken = vi.fn(async () => 'server-only-token');
    const port = await serve(forward, accessToken);

    const result = await call(port, {
      path: '/v1/messages',
      method: 'POST',
      headers: {
        host: AUTHORITY,
        authorization: `Bearer ${CLAUDE_EGRESS_PLACEHOLDER}`,
        'content-type': 'application/json',
      },
      body: '{"prompt":"hello"}',
    });

    expect(result).toEqual({ status: 200, body: '{"ok":true}' });
    expect(seenBody).toBe('{"prompt":"hello"}');
    expect(accessToken).toHaveBeenCalledWith(PROJECT_ID);
    expect(JSON.stringify(result)).not.toContain('server-only-token');
  });

  it('answers the authenticated gateway probe without resolving a token or upstream', async () => {
    const accessToken = vi.fn(async () => 'server-only-token');
    const forward = vi.fn<ClaudeEgressForward>();
    const port = await serve(forward, accessToken);

    const result = await call(port, {
      path: '/__verity/gateway-ready',
      headers: { host: AUTHORITY },
    });

    expect(result).toEqual({ status: 200, body: '{"ready":true,"authenticated":true}' });
    expect(accessToken).not.toHaveBeenCalled();
    expect(forward).not.toHaveBeenCalled();
  });

  it('forwards the exact token-count inference endpoint', async () => {
    const forward = vi.fn<ClaudeEgressForward>(async (request) => {
      expect(request.url.href).toBe('https://api.anthropic.com/v1/messages/count_tokens');
      expect(request.method).toBe('POST');
      expect(request.headers.get('authorization')).toBe('Bearer server-only-token');
      return { status: 200, headers: {}, body: Readable.from(['{"input_tokens":42}']) };
    });
    const accessToken = vi.fn(async () => 'server-only-token');
    const port = await serve(forward, accessToken);

    await expect(
      call(port, {
        path: '/v1/messages/count_tokens',
        method: 'POST',
        headers: {
          host: AUTHORITY,
          authorization: `Bearer ${CLAUDE_EGRESS_PLACEHOLDER}`,
          'content-type': 'application/json',
        },
        body: '{}',
      }),
    ).resolves.toEqual({ status: 200, body: '{"input_tokens":42}' });
    expect(accessToken).toHaveBeenCalledWith(PROJECT_ID);
    expect(forward).toHaveBeenCalledOnce();
  });

  it('rejects the wrong listener authority before resolving a credential', async () => {
    const accessToken = vi.fn(async () => 'server-only-token');
    const forward = vi.fn<ClaudeEgressForward>();
    const port = await serve(forward, accessToken);

    const result = await call(port, {
      path: '/v1/messages',
      headers: {
        host: 'other-project-proxy:9443',
        authorization: `Bearer ${CLAUDE_EGRESS_PLACEHOLDER}`,
      },
    });

    expect(result.status).toBe(403);
    expect(accessToken).not.toHaveBeenCalled();
    expect(forward).not.toHaveBeenCalled();
  });

  it('rejects a cross-project peer before trusting Host or resolving a credential', async () => {
    const accessToken = vi.fn(async () => 'server-only-token');
    const forward = vi.fn<ClaudeEgressForward>();
    const port = await serve(forward, accessToken, () => 'project-evil');

    const result = await call(port, {
      path: '/v1/messages',
      headers: {
        host: AUTHORITY,
        authorization: `Bearer ${CLAUDE_EGRESS_PLACEHOLDER}`,
      },
    });

    expect(result.status).toBe(403);
    expect(result.body).toContain('peer identity does not match');
    expect(accessToken).not.toHaveBeenCalled();
    expect(forward).not.toHaveBeenCalled();
  });

  it('rejects duplicate headers instead of normalizing ambiguous credentials', async () => {
    const accessToken = vi.fn(async () => 'server-only-token');
    const forward = vi.fn<ClaudeEgressForward>();
    const port = await serve(forward, accessToken);

    const result = await call(port, {
      path: '/v1/messages',
      headers: {
        host: AUTHORITY,
        authorization: [`Bearer ${CLAUDE_EGRESS_PLACEHOLDER}`, 'Bearer attacker-controlled'],
      },
    });

    expect(result.status).toBe(403);
    expect(result.body).toContain('duplicate header');
    expect(accessToken).not.toHaveBeenCalled();
    expect(forward).not.toHaveBeenCalled();
  });

  it('does not expose or follow an upstream redirect', async () => {
    const forward = vi.fn<ClaudeEgressForward>(async () => ({
      status: 307,
      headers: { location: 'https://evil.example/collect' },
      body: Readable.from([]),
    }));
    const port = await serve(forward, async () => 'server-only-token');

    const result = await call(port, {
      path: '/v1/messages',
      method: 'POST',
      headers: {
        host: AUTHORITY,
        authorization: `Bearer ${CLAUDE_EGRESS_PLACEHOLDER}`,
      },
    });

    expect(result.status).toBe(403);
    expect(result.body).not.toContain('evil.example');
    expect(forward).toHaveBeenCalledOnce();
  });

  it('rejects absolute-form requests that try to select another upstream', async () => {
    const forward = vi.fn<ClaudeEgressForward>();
    const accessToken = vi.fn(async () => 'server-only-token');
    const port = await serve(forward, accessToken);

    const result = await call(port, {
      path: 'https://evil.example/collect',
      headers: {
        host: AUTHORITY,
        authorization: `Bearer ${CLAUDE_EGRESS_PLACEHOLDER}`,
      },
    });

    expect(result.status).toBe(403);
    expect(accessToken).not.toHaveBeenCalled();
    expect(forward).not.toHaveBeenCalled();
  });

  it.each([
    ['POST', '/v1/messages/batches'],
    ['GET', '/api/oauth/usage'],
    ['GET', '/v1/models'],
    ['POST', '/v1/messages?target=/admin'],
  ])('rejects non-inference endpoint %s %s before resolving a credential', async (method, path) => {
    const forward = vi.fn<ClaudeEgressForward>();
    const accessToken = vi.fn(async () => 'server-only-token');
    const port = await serve(forward, accessToken);

    const result = await call(port, {
      path,
      method,
      headers: {
        host: AUTHORITY,
        authorization: `Bearer ${CLAUDE_EGRESS_PLACEHOLDER}`,
      },
    });

    expect(result.status).toBe(403);
    expect(result.body).not.toContain('server-only-token');
    expect(accessToken).not.toHaveBeenCalled();
    expect(forward).not.toHaveBeenCalled();
  });

  it('redacts a forged Sandbox bearer before any credential or upstream access', async () => {
    const forward = vi.fn<ClaudeEgressForward>();
    const accessToken = vi.fn(async () => 'server-only-token');
    const port = await serve(forward, accessToken);

    const result = await call(port, {
      path: '/v1/messages',
      method: 'POST',
      headers: { host: AUTHORITY, authorization: 'Bearer sandbox-stolen-token' },
    });

    expect(result.status).toBe(403);
    expect(result.body).not.toContain('sandbox-stolen-token');
    expect(result.body).not.toContain('server-only-token');
    expect(accessToken).not.toHaveBeenCalled();
    expect(forward).not.toHaveBeenCalled();
  });

  it('fails closed without leaking credential-provider errors', async () => {
    const port = await serve(vi.fn<ClaudeEgressForward>(), async () => {
      throw new Error('refresh failed for secret server-only-token');
    });

    const result = await call(port, {
      path: '/v1/messages',
      method: 'POST',
      headers: {
        host: AUTHORITY,
        authorization: `Bearer ${CLAUDE_EGRESS_PLACEHOLDER}`,
      },
    });

    expect(result.status).toBe(502);
    expect(result.body).not.toContain('server-only-token');
  });

  it('forces active connections closed after the bounded shutdown grace', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200);
      response.write('stream remains active');
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (typeof address !== 'object' || address === null) throw new Error('server did not bind');
    const active = httpRequest({ host: '127.0.0.1', port: address.port });
    active.on('error', () => undefined);
    active.end();
    await new Promise<void>((resolve) => active.once('response', () => resolve()));

    await expect(closeServerBounded(server, 10)).resolves.toBeUndefined();
    servers.splice(servers.indexOf(server), 1);
  });

  it('lets an active stream finish during the shutdown grace', async () => {
    let finishStream: (() => void) | undefined;
    const server = createServer((_request, response) => {
      response.writeHead(200);
      response.write('first');
      finishStream = () => response.end('second');
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (typeof address !== 'object' || address === null) throw new Error('server did not bind');
    const body = new Promise<string>((resolve, reject) => {
      const request = httpRequest({ host: '127.0.0.1', port: address.port }, (response) => {
        let value = '';
        response.on('data', (chunk) => (value += String(chunk)));
        response.once('end', () => resolve(value));
      });
      request.once('error', reject);
      request.end();
    });
    await vi.waitFor(() => expect(finishStream).toBeTypeOf('function'));

    const closing = closeServerBounded(server, 1_000);
    finishStream?.();

    await expect(body).resolves.toBe('firstsecond');
    await expect(closing).resolves.toBeUndefined();
    servers.splice(servers.indexOf(server), 1);
  });

  it('multi-tenant (unpinned): scopes the credential to the authenticated peer', async () => {
    const forward = vi.fn<ClaudeEgressForward>(async (request) => {
      expect(request.headers.get('authorization')).toBe('Bearer token-for-project-42');
      return { status: 200, headers: {}, body: Readable.from(['ok']) };
    });
    const accessToken = vi.fn(async (projectId: string) => `token-for-${projectId}`);
    // No pinned projectId → the authenticated peer identity is the scope.
    const port = await serve(forward, accessToken, () => 'project-42', true);

    const result = await call(port, {
      path: '/v1/messages',
      method: 'POST',
      headers: { host: AUTHORITY, authorization: `Bearer ${CLAUDE_EGRESS_PLACEHOLDER}` },
      body: '{}',
    });

    expect(result.status).toBe(200);
    // The credential was minted for the PEER's project, not any fixed config.
    expect(accessToken).toHaveBeenCalledWith('project-42');
    expect(accessToken).not.toHaveBeenCalledWith(PROJECT_ID);
  });

  it('multi-tenant (unpinned): rejects an unauthenticated peer before any credential', async () => {
    const forward = vi.fn<ClaudeEgressForward>();
    const accessToken = vi.fn(async (projectId: string) => `token-for-${projectId}`);
    // The registry authenticates no one (unknown/foreign cert → undefined).
    const port = await serve(forward, accessToken, () => undefined, true);

    const result = await call(port, {
      path: '/v1/messages',
      headers: { host: AUTHORITY, authorization: `Bearer ${CLAUDE_EGRESS_PLACEHOLDER}` },
    });

    expect(result.status).toBe(403);
    expect(accessToken).not.toHaveBeenCalled();
    expect(forward).not.toHaveBeenCalled();
  });

  it('multi-tenant (unpinned): rejects an empty-string peer identity at the source', async () => {
    const forward = vi.fn<ClaudeEgressForward>();
    const accessToken = vi.fn(async (projectId: string) => `token-for-${projectId}`);
    // A malformed authenticator yielding '' must never mint a token for scope ''.
    const port = await serve(forward, accessToken, () => '', true);

    const result = await call(port, {
      path: '/v1/messages',
      headers: { host: AUTHORITY, authorization: `Bearer ${CLAUDE_EGRESS_PLACEHOLDER}` },
    });

    expect(result.status).toBe(403);
    expect(accessToken).not.toHaveBeenCalled();
    expect(forward).not.toHaveBeenCalled();
  });
});

describe('Claude egress request reporting', () => {
  const PROMPT = 'my-private-prompt';
  const SECRET_VALUE = 'my-secret-value';

  it('records the route and the query parameter NAMES, never their values', async () => {
    const denied: ClaudeEgressRequestEnd[] = [];
    const port = await serve(
      vi.fn<ClaudeEgressForward>(),
      vi.fn(async () => 'server-only-token'),
      () => PROJECT_ID,
      false,
      (denial) => denied.push(denial),
    );

    const result = await call(port, {
      path: `/v1/messages?beta=true&trace=${SECRET_VALUE}`,
      method: 'POST',
      headers: {
        host: AUTHORITY,
        authorization: `Bearer ${CLAUDE_EGRESS_PLACEHOLDER}`,
        'x-note': SECRET_VALUE,
      },
      body: `{"prompt":"${PROMPT}"}`,
    });

    expect(result.status).toBe(403);
    expect(denied).toEqual([
      {
        outcome: 'rejected',
        reason: 'policy-rejected',
        status: 403,
        method: 'POST',
        path: '/v1/messages',
        queryParams: ['<other>', 'beta'],
        bytesForwarded: 0,
        durationMs: expect.any(Number),
        projectId: PROJECT_ID,
      },
    ]);
    // The privacy contract, asserted on the serialised record: no prompt, no
    // header value, no query value, no placeholder or real credential.
    const serialised = JSON.stringify(denied);
    expect(serialised).not.toContain(PROMPT);
    expect(serialised).not.toContain(SECRET_VALUE);
    expect(serialised).not.toContain(CLAUDE_EGRESS_PLACEHOLDER);
    expect(serialised).not.toContain('server-only-token');
  });

  it('collapses an unusual path instead of echoing sandbox-chosen text', async () => {
    const denied: ClaudeEgressRequestEnd[] = [];
    const port = await serve(
      vi.fn<ClaudeEgressForward>(),
      vi.fn(async () => 'server-only-token'),
      () => PROJECT_ID,
      false,
      (denial) => denied.push(denial),
    );

    await call(port, {
      path: `/v1/messages;${SECRET_VALUE}`,
      method: 'POST',
      headers: { host: AUTHORITY, authorization: `Bearer ${CLAUDE_EGRESS_PLACEHOLDER}` },
    });

    expect(denied[0]).toMatchObject({ method: 'POST', path: '<other>', queryParams: [] });
    expect(JSON.stringify(denied)).not.toContain(SECRET_VALUE);
  });

  // PURGE is parseable by Node's HTTP server but is not a verb this gateway
  // ever expects, so it exercises the method placeholder end to end.
  it('collapses a method outside the known verbs', async () => {
    const denied: ClaudeEgressRequestEnd[] = [];
    const port = await serve(
      vi.fn<ClaudeEgressForward>(),
      vi.fn(async () => 'server-only-token'),
      () => PROJECT_ID,
      false,
      (denial) => denied.push(denial),
    );

    await call(port, {
      path: '/v1/messages',
      method: 'PURGE',
      headers: { host: AUTHORITY, authorization: `Bearer ${CLAUDE_EGRESS_PLACEHOLDER}` },
    });

    expect(denied[0]).toMatchObject({ method: '<other>', path: '/v1/messages' });
  });

  it('omits the project when the peer never authenticated', async () => {
    const denied: ClaudeEgressRequestEnd[] = [];
    const port = await serve(
      vi.fn<ClaudeEgressForward>(),
      vi.fn(async () => 'server-only-token'),
      () => undefined,
      false,
      (denial) => denied.push(denial),
    );

    await call(port, {
      path: '/v1/messages',
      method: 'POST',
      headers: { host: AUTHORITY, authorization: `Bearer ${CLAUDE_EGRESS_PLACEHOLDER}` },
    });

    expect(denied[0]?.reason).toBe('policy-rejected');
    expect(denied[0]).not.toHaveProperty('projectId');
  });

  it('records a completed request with the bytes it forwarded', async () => {
    const events: ClaudeEgressRequestEnd[] = [];
    const forward: ClaudeEgressForward = () =>
      Promise.resolve({ status: 200, headers: {}, body: Readable.from(['{"ok":', 'true}']) });
    const port = await serve(
      forward,
      vi.fn(async () => 'server-only-token'),
      () => PROJECT_ID,
      false,
      (event) => events.push(event),
    );

    const result = await call(port, {
      path: '/v1/messages',
      method: 'POST',
      headers: { host: AUTHORITY, authorization: `Bearer ${CLAUDE_EGRESS_PLACEHOLDER}` },
    });

    expect(result.status).toBe(200);
    await waitFor(() => events.length === 1);
    expect(events[0]).toMatchObject({
      outcome: 'completed',
      reason: 'ok',
      status: 200,
      path: '/v1/messages',
      bytesForwarded: '{"ok":true}'.length,
    });
  });

  it('does not count an upstream body suppressed by HTTP response semantics', async () => {
    const events: ClaudeEgressRequestEnd[] = [];
    const port = await serve(
      async () => ({ status: 204, headers: {}, body: Readable.from(['not-transmitted']) }),
      vi.fn(async () => 'server-only-token'),
      () => PROJECT_ID,
      false,
      (event) => events.push(event),
    );

    await call(port, {
      path: '/v1/messages',
      method: 'POST',
      headers: { host: AUTHORITY, authorization: `Bearer ${CLAUDE_EGRESS_PLACEHOLDER}` },
    });
    await waitFor(() => events.length === 1);
    expect(events[0]).toMatchObject({ outcome: 'completed', status: 204, bytesForwarded: 0 });
  });

  // The exact failure the agent CLI reports as "Connection closed mid-response":
  // headers were already written, so the sandbox only sees a dead socket. Without
  // this record the break leaves no trace anywhere.
  it('records a mid-response break with the classified error and byte count', async () => {
    const events: ClaudeEgressRequestEnd[] = [];
    const forward: ClaudeEgressForward = () => {
      const body = new Readable({ read() {} });
      body.push('event: partial\n');
      setTimeout(() => {
        body.destroy(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }));
      }, 5);
      return Promise.resolve({ status: 200, headers: {}, body });
    };
    const port = await serve(
      forward,
      vi.fn(async () => 'server-only-token'),
      () => PROJECT_ID,
      false,
      (event) => events.push(event),
    );

    // Fire and forget: a socket torn down mid-body gives the client no orderly
    // end, and what this test asserts is the server-side record, not the client.
    const aborted = httpRequest({
      host: '127.0.0.1',
      port,
      path: '/v1/messages',
      method: 'POST',
      headers: { host: AUTHORITY, authorization: `Bearer ${CLAUDE_EGRESS_PLACEHOLDER}` },
    });
    aborted.once('error', () => undefined);
    aborted.once('response', (response) => {
      response.on('data', () => undefined);
      response.once('error', () => undefined);
    });
    aborted.end();

    await waitFor(() => events.length === 1);
    expect(events[0]).toMatchObject({
      outcome: 'aborted',
      reason: 'Error/ECONNRESET',
      status: 200,
      path: '/v1/messages',
      bytesForwarded: 'event: partial\n'.length,
    });
    // The upstream message is never quoted — only name and code.
    expect(JSON.stringify(events)).not.toContain('socket hang up');
  });

  it('records one cancellation when the sandbox disconnects before response headers', async () => {
    const events: ClaudeEgressRequestEnd[] = [];
    let forwardStarted!: () => void;
    const started = new Promise<void>((resolve) => (forwardStarted = resolve));
    const forward: ClaudeEgressForward = (request) => {
      forwardStarted();
      return new Promise((_, reject) =>
        request.signal.addEventListener('abort', () => reject(new Error('aborted')), {
          once: true,
        }),
      );
    };
    const port = await serve(
      forward,
      vi.fn(async () => 'server-only-token'),
      () => PROJECT_ID,
      false,
      (event) => events.push(event),
    );
    const cancelled = httpRequest({
      host: '127.0.0.1',
      port,
      path: '/v1/messages',
      method: 'POST',
      headers: { host: AUTHORITY, authorization: `Bearer ${CLAUDE_EGRESS_PLACEHOLDER}` },
    });
    cancelled.once('error', () => undefined);
    cancelled.end();
    await started;
    cancelled.destroy();

    await waitFor(() => events.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      outcome: 'cancelled',
      reason: 'sandbox-closed',
      status: 0,
      bytesForwarded: 0,
    });
  });

  it('refuses a malformed stream deadline at startup', () => {
    // `setTimeout(fn, NaN)` fires on the next tick, so a misparsed configuration
    // value would abort every stream instead of supervising none.
    expect(() =>
      createClaudeEgressGatewayHandler({
        projectId: PROJECT_ID,
        listenerAuthority: AUTHORITY,
        authenticatePeer: () => PROJECT_ID,
        accessToken: async () => 'server-only-token',
        streamIdleTimeoutMs: Number.NaN,
      }),
    ).toThrow('must be zero or a supported positive delay');
  });

  it('ends a response stream whose upstream stops producing', async () => {
    const events: ClaudeEgressRequestEnd[] = [];
    const silent = new Readable({ read() {} });
    silent.push('event: message_start\n\n');
    const port = await serve(
      async () => ({ status: 200, headers: {}, body: silent }),
      async () => 'server-only-token',
      () => PROJECT_ID,
      false,
      (event) => events.push(event),
      IDLE_MS,
    );
    const stalled = stream(port);

    await waitFor(() => events.length === 1);
    expect(events[0]).toMatchObject({
      outcome: 'aborted',
      reason: 'upstream-idle',
      status: 200,
      bytesForwarded: 'event: message_start\n\n'.length,
    });
    // The sandbox is told, rather than left holding a response that never ends.
    await expect(stalled.ended).resolves.toBe('broken');
  });

  it('leaves a slow but progressing stream alone', async () => {
    const events: ClaudeEgressRequestEnd[] = [];
    const slow = new Readable({ read() {} });
    void (async () => {
      for (let index = 0; index < 5; index += 1) {
        // A quarter of the deadline, not most of it: this asserts that a slow
        // producer survives, so a loaded runner must not be able to turn it into
        // "the gateway killed a healthy stream".
        await new Promise((resolve) => setTimeout(resolve, IDLE_MS * 0.25));
        slow.push(`chunk-${index};`);
      }
      slow.push(null);
    })();
    const port = await serve(
      async () => ({ status: 200, headers: {}, body: slow }),
      async () => 'server-only-token',
      () => PROJECT_ID,
      false,
      (event) => events.push(event),
      IDLE_MS,
    );

    const result = await call(port, {
      path: '/v1/messages',
      method: 'POST',
      headers: {
        host: AUTHORITY,
        authorization: `Bearer ${CLAUDE_EGRESS_PLACEHOLDER}`,
        'content-type': 'application/json',
      },
      body: '{"prompt":"hello"}',
    });

    expect(result).toEqual({
      status: 200,
      body: 'chunk-0;chunk-1;chunk-2;chunk-3;chunk-4;',
    });
    await waitFor(() => events.length === 1);
    expect(events[0]).toMatchObject({ outcome: 'completed', reason: 'ok' });
  });

  it('never arms the deadline when the supervision is disabled', async () => {
    const events: ClaudeEgressRequestEnd[] = [];
    const silent = new Readable({ read() {} });
    silent.push('event: message_start\n\n');
    const port = await serve(
      async () => ({ status: 200, headers: {}, body: silent }),
      async () => 'server-only-token',
      () => PROJECT_ID,
      false,
      (event) => events.push(event),
      0,
    );
    const held = stream(port);

    await new Promise((resolve) => setTimeout(resolve, IDLE_MS * 4));
    expect(events).toHaveLength(0);
    // End it the way the network would have, which also pins that a REAL
    // transport failure keeps its own label rather than the idle one.
    silent.destroy(Object.assign(new Error('upstream reset'), { code: 'ECONNRESET' }));
    await waitFor(() => events.length === 1);
    expect(events[0]).toMatchObject({ outcome: 'aborted', reason: 'Error/ECONNRESET' });
    await expect(held.ended).resolves.toBe('broken');
  });

  it('keeps the sandbox response intact when the observer throws', async () => {
    const port = await serve(
      vi.fn<ClaudeEgressForward>(),
      vi.fn(async () => 'server-only-token'),
      () => PROJECT_ID,
      false,
      () => {
        throw new Error('observer is broken');
      },
    );

    const result = await call(port, {
      path: '/v1/models',
      method: 'POST',
      headers: { host: AUTHORITY, authorization: `Bearer ${CLAUDE_EGRESS_PLACEHOLDER}` },
    });

    expect(result).toEqual({
      status: 403,
      body: 'Claude egress denied: Claude egress inference endpoint is not allowed',
    });
  });

  it('collapses an unsafe authenticated project id in the log record', async () => {
    const events: ClaudeEgressRequestEnd[] = [];
    const port = await serve(
      vi.fn<ClaudeEgressForward>(),
      vi.fn(async () => 'server-only-token'),
      () => `project-${SECRET_VALUE}\nforged`,
      true,
      (event) => events.push(event),
    );

    await call(port, {
      path: '/v1/models',
      method: 'POST',
      headers: { host: AUTHORITY, authorization: `Bearer ${CLAUDE_EGRESS_PLACEHOLDER}` },
    });

    expect(events[0]?.projectId).toBe('<other>');
    expect(JSON.stringify(events)).not.toContain(SECRET_VALUE);
  });
});

/** Reports land on stream events, so they can trail the client's own view. */
async function waitFor(ready: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for a report');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function serve(
  forward: ClaudeEgressForward,
  accessToken: (projectId: string) => Promise<string>,
  authenticatePeer: () => string | undefined = () => PROJECT_ID,
  multiTenant = false,
  onRequestEnd?: ClaudeEgressRequestObserver,
  streamIdleTimeoutMs?: number,
): Promise<number> {
  const server = createServer(
    createClaudeEgressGatewayHandler({
      // Pinned (single-project) by default; multi-tenant omits the pin so the
      // authenticated peer identity is the scope.
      ...(multiTenant ? {} : { projectId: PROJECT_ID }),
      listenerAuthority: AUTHORITY,
      authenticatePeer,
      accessToken,
      forward,
      ...(onRequestEnd === undefined ? {} : { onRequestEnd }),
      ...(streamIdleTimeoutMs === undefined ? {} : { streamIdleTimeoutMs }),
    }),
  );
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (typeof address !== 'object' || address === null) throw new Error('test server did not bind');
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
    path: '/v1/messages',
    method: 'POST',
    headers: {
      host: AUTHORITY,
      authorization: `Bearer ${CLAUDE_EGRESS_PLACEHOLDER}`,
      'content-type': 'application/json',
    },
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
  request.end('{"prompt":"hello"}');
  return { request, ended };
}

function call(
  port: number,
  options: {
    path: string;
    method?: string;
    headers: Record<string, string | string[]>;
    body?: string;
  },
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path: options.path,
        method: options.method ?? 'GET',
        headers: options.headers,
        joinDuplicateHeaders: false,
      },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => (body += chunk));
        response.once('end', () => resolve({ status: response.statusCode ?? 0, body }));
      },
    );
    request.once('error', reject);
    request.end(options.body);
  });
}
