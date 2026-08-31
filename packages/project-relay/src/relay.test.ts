import { mkdtempSync, rmSync } from 'node:fs';
import {
  createServer as createHttpServer,
  request,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server as HttpServer,
} from 'node:http';
import { createConnection, createServer as createNetServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it } from 'vitest';

import {
  BROKER_DECISION_ROUTES,
  BROKER_RELAY_ROUTES,
  CLAUDE_RELAY_LIMITS,
  createBrokerRelayServer,
  createClaudeRelayServer,
  RELAY_LIMITS,
  startRelay,
} from './relay.js';

const servers: Array<Server | HttpServer> = [];
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          if ('closeAllConnections' in server) server.closeAllConnections();
        }),
    ),
  );
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('broker relay', () => {
  it('forwards only an allowlisted request to the fixed Unix socket', async () => {
    const seen: Array<{ method: string; url: string; authorization?: string; body: string }> = [];
    const socketPath = await fakeBroker(async (incoming) => {
      const body = await readBody(incoming);
      seen.push({
        method: incoming.method ?? '',
        url: incoming.url ?? '',
        ...(incoming.headers.authorization !== undefined
          ? { authorization: incoming.headers.authorization }
          : {}),
        body,
      });
      return { status: 200, body: '{"token":"scoped"}' };
    });
    const relay = createBrokerRelayServer({ socketPath });
    const port = await listenTcp(relay);

    const response = await httpCall(port, {
      method: 'POST',
      path: '/internal/github/token',
      headers: { authorization: 'Bearer project-cap', 'content-type': 'application/json' },
      body: '{"request":true}',
    });

    expect(response).toMatchObject({ status: 200, body: '{"token":"scoped"}' });
    expect(seen).toEqual([
      {
        method: 'POST',
        url: '/internal/github/token',
        authorization: 'Bearer project-cap',
        body: '{"request":true}',
      },
    ]);
  });

  // The MCP gateway (ADR 0014 D1) is the ACP transport's only route to the brokered
  // secret tools, and its per-turn bearer rides `authorization` — a relay that dropped
  // either the route or the header would leave an ACP session with no tools at all.
  it('forwards the MCP gateway route with the turn bearer intact', async () => {
    const seen: Array<{
      url: string;
      authorization?: string;
      protocolVersion?: string | string[];
      body: string;
    }> = [];
    const socketPath = await fakeBroker(async (incoming) => {
      seen.push({
        url: incoming.url ?? '',
        ...(incoming.headers.authorization !== undefined
          ? { authorization: incoming.headers.authorization }
          : {}),
        ...(incoming.headers['mcp-protocol-version'] !== undefined
          ? { protocolVersion: incoming.headers['mcp-protocol-version'] }
          : {}),
        body: await readBody(incoming),
      });
      return { status: 200, body: '{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}' };
    });
    const relay = createBrokerRelayServer({ socketPath });
    const port = await listenTcp(relay);

    const response = await httpCall(port, {
      method: 'POST',
      path: '/internal/mcp',
      headers: {
        authorization: 'Bearer turn-bearer',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        // Sent by the MCP client on every request once `initialize` has settled.
        'mcp-protocol-version': '2025-06-18',
      },
      body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
    });

    expect(response).toMatchObject({
      status: 200,
      body: '{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}',
    });
    expect(seen).toEqual([
      {
        url: '/internal/mcp',
        authorization: 'Bearer turn-bearer',
        protocolVersion: '2025-06-18',
        body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
      },
    ]);
  });

  // Every other test here writes the request by hand, which is how the gateway hop shipped
  // broken twice over: the route was missing, and then the header allowlist rejected what
  // `fetch` adds by itself. So drive the real MCP client and let it choose its own request
  // shape — this is the only test in which the relay carries traffic it did not author.
  it('carries a real MCP client through initialize and tools/list', async () => {
    const seen: Array<{ method: string; headers: string[] }> = [];
    const socketPath = await fakeBroker(async (incoming) => {
      const body = await readBody(incoming);
      seen.push({ method: incoming.method ?? '', headers: Object.keys(incoming.headers).sort() });
      // The gateway's answer to the server-message stream: it has none to send, and 405 is
      // how the transport is told so. It has to travel the relay to reach the client.
      if (incoming.method === 'GET') {
        return {
          status: 405,
          headers: { allow: 'POST' },
          body: JSON.stringify({ error: 'method_not_allowed' }),
        };
      }
      const message = JSON.parse(body) as { id?: number; method?: string };
      if (message.method === 'initialize') {
        return {
          status: 200,
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: message.id,
            result: {
              protocolVersion: '2025-06-18',
              capabilities: { tools: {} },
              serverInfo: { name: 'verity', version: '1' },
            },
          }),
        };
      }
      if (message.method === 'tools/list') {
        return {
          status: 200,
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: message.id,
            result: { tools: [{ name: 'verity_http_request', inputSchema: { type: 'object' } }] },
          }),
        };
      }
      return { status: 202, body: '' };
    });
    const relay = createBrokerRelayServer({ socketPath });
    const port = await listenTcp(relay);

    const client = new Client({ name: 'relay-test', version: '1' });
    let observeStreamStatus: (status: number) => void = () => {};
    const streamStatus = new Promise<number>((resolve) => {
      observeStreamStatus = resolve;
    });
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${port}/internal/mcp`),
      {
        requestInit: { headers: { authorization: 'Bearer turn-bearer' } },
        // The GET stream is opened without being awaited, so nothing else here is ordered
        // against it. Report its status through the transport's own `fetch` and await that,
        // rather than checking after the call below and racing it.
        fetch: async (input, init) => {
          const response = await fetch(input, init);
          if ((init?.method ?? 'GET') === 'GET') {
            // Reported a turn late, on purpose. Everything the transport does with this
            // response — read the status, cancel the body, route a failure to `onerror` —
            // is chained onto the `fetch` this line is returning from, so resolving inline
            // would hand the status over before the error it implies. A timer runs after
            // that chain has drained, which is what makes the assertion below meaningful.
            setTimeout(() => observeStreamStatus(response.status), 0);
          }
          return response;
        },
      },
    );
    // The client also opens a GET stream for server-initiated messages, and the only answer
    // it reads as "there is none" is the gateway's 405. Anything the relay decided on its
    // own — a 404 from the allowlist — arrives here instead, asynchronously, as a connection
    // error on every ACP turn.
    const transportErrors: unknown[] = [];
    transport.onerror = (error): void => {
      transportErrors.push(error);
    };
    try {
      // The SDK declares `sessionId` as optional-and-possibly-undefined, which this repo's
      // `exactOptionalPropertyTypes` reads as narrower than its own `Transport`. Runtime
      // shape is exactly what `connect` expects.
      await client.connect(transport as unknown as Parameters<Client['connect']>[0]);
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual(['verity_http_request']);
      // The gateway's 405 reached the client through the relay, so the transport dropped
      // the stream quietly instead of reporting it.
      expect(await streamStatus).toBe(405);
      expect(transportErrors).toEqual([]);
    } finally {
      await transport.close();
    }

    // Reached the socket at all, and never asked upstream to compress: a compressed answer
    // would be counted against the response cap in its compressed size. Sorted, because the
    // GET stream is opened without being awaited and races the call that follows it.
    expect(seen.map((entry) => entry.method).sort()).toEqual(['GET', 'POST', 'POST', 'POST']);
    expect(seen.flatMap((entry) => entry.headers)).not.toContain('accept-encoding');
  });

  // The one route that is allowlisted for two methods. The gateway refuses the GET itself,
  // and the refusal only means what it says if the `allow` header survives the hop.
  it('forwards the MCP server-message stream and the refusal it comes back with', async () => {
    const socketPath = await fakeBroker(async () => ({
      status: 405,
      headers: { allow: 'POST' },
      body: '{"error":"method_not_allowed"}',
    }));
    const relay = createBrokerRelayServer({ socketPath });
    const port = await listenTcp(relay);

    const response = await httpCall(port, {
      method: 'GET',
      path: '/internal/mcp',
      headers: { accept: 'text/event-stream', authorization: 'Bearer turn-bearer' },
    });
    expect(response.status).toBe(405);
    expect(response.headers.allow).toBe('POST');
  });

  it('rejects arbitrary targets, methods, queries, upgrades, and CONNECT without touching the socket', async () => {
    let calls = 0;
    const socketPath = await fakeBroker(async () => {
      calls += 1;
      return { status: 200, body: '{}' };
    });
    const relay = createBrokerRelayServer({ socketPath });
    const port = await listenTcp(relay);

    for (const candidate of [
      { method: 'GET', path: '/internal/github/token' },
      { method: 'POST', path: '/internal/github/token?target=other' },
      { method: 'POST', path: 'http://example.test/internal/github/token' },
      { method: 'DELETE', path: '/internal/mcp' },
      { method: 'POST', path: '/projects' },
    ]) {
      expect((await httpCall(port, candidate)).status).toBe(404);
    }
    expect(
      await rawCall(port, 'CONNECT example.test:443 HTTP/1.1\r\nHost: example.test\r\n\r\n'),
    ).toContain('405 Method Not Allowed');
    expect(
      await rawCall(
        port,
        'GET /internal/github/token HTTP/1.1\r\nHost: relay\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n',
      ),
    ).toContain('405 Method Not Allowed');
    expect(
      await rawCall(
        port,
        'POST /internal/github/token HTTP/1.1\r\nHost: relay\r\nConnection: authorization\r\nAuthorization: Bearer secret\r\nContent-Length: 0\r\n\r\n',
      ),
    ).toContain('400 Bad Request');
    expect(
      (
        await httpCall(port, {
          method: 'POST',
          path: '/internal/github/token',
          headers: { 'x-caller-selected-upstream': 'http://example.test' },
        })
      ).status,
    ).toBe(400);
    expect(calls).toBe(0);
  });

  it('buffers and rejects an oversized body before contacting Verity', async () => {
    let calls = 0;
    const socketPath = await fakeBroker(async () => {
      calls += 1;
      return { status: 200, body: '{}' };
    });
    const relay = createBrokerRelayServer({ socketPath, limits: { maxBodyBytes: 8 } });
    const port = await listenTcp(relay);

    const response = await httpCall(port, {
      method: 'POST',
      path: '/internal/git/sign',
      body: '123456789',
    });
    expect(response.status).toBe(413);
    expect(
      await rawCall(
        port,
        'POST /internal/git/sign HTTP/1.1\r\nHost: relay\r\nTransfer-Encoding: chunked\r\n\r\n9\r\n123456789\r\n0\r\n\r\n',
      ),
    ).toContain('413 Payload Too Large');
    expect(calls).toBe(0);
  });

  it('bounds pipelined requests independently of the TCP connection count', async () => {
    let calls = 0;
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const socketPath = await fakeBroker(async () => {
      calls += 1;
      await blocked;
      return { status: 200, body: '{}' };
    });
    const relay = createBrokerRelayServer({
      socketPath,
      limits: { maxConnections: 2, requestTimeoutMs: 1_000 },
    });
    const port = await listenTcp(relay);
    const requestText =
      'POST /internal/github/token HTTP/1.1\r\nHost: relay\r\nContent-Length: 0\r\n\r\n';
    const responses = rawCall(port, requestText.repeat(6));

    await waitFor(() => calls === 2);
    expect(calls).toBe(2);
    release();
    await responses;
  });

  // The relay answers 100-continue itself instead of forwarding the expectation, so a
  // caller cannot hold a broker request open by promising a body it never sends.
  it('refuses a 100-continue expectation without contacting the socket', async () => {
    let calls = 0;
    const socketPath = await fakeBroker(async () => {
      calls += 1;
      return { status: 200, body: '{}' };
    });
    const relay = createBrokerRelayServer({ socketPath });
    const port = await listenTcp(relay);

    const answer = await rawCall(
      port,
      'POST /internal/git/sign HTTP/1.1\r\nHost: relay\r\nExpect: 100-continue\r\nContent-Length: 2\r\n\r\n{}',
    );
    expect(answer).toContain('417 Expectation Failed');
    expect(answer).toContain('{"error":"expectation failed"}');
    expect(calls).toBe(0);
  });

  // Two ways of steering the hop that never reach the route allowlist: a header the
  // relay does not accept at all, and one accepted header sent twice — the shape a
  // request-smuggling attempt takes once the route itself is fixed.
  it.each([
    {
      name: 'an upgrade header the connection did not request',
      raw: 'POST /internal/git/sign HTTP/1.1\r\nHost: relay\r\nUpgrade: h2c\r\nContent-Length: 0\r\n\r\n',
    },
    {
      name: 'a duplicated accept header',
      raw: 'POST /internal/git/sign HTTP/1.1\r\nHost: relay\r\nAccept: application/json\r\nAccept: text/plain\r\nContent-Length: 0\r\n\r\n',
    },
  ])('rejects $name with 400 invalid headers', async ({ raw }) => {
    let calls = 0;
    const socketPath = await fakeBroker(async () => {
      calls += 1;
      return { status: 200, body: '{}' };
    });
    const relay = createBrokerRelayServer({ socketPath });
    const port = await listenTcp(relay);

    const answer = await rawCall(port, raw);
    expect(answer).toContain('400 Bad Request');
    expect(answer).toContain('{"error":"invalid headers"}');
    expect(calls).toBe(0);
  });

  // A content-length Node's own parser tolerates but that is not the one canonical
  // spelling of the number. Anything else would let two hops disagree on where the
  // body ends. (Values Node rejects itself, such as `1e3`, never get this far.)
  it.each(['007', '00'])(
    'rejects a non-canonical content-length %s before reading a body',
    async (declared) => {
      let calls = 0;
      const socketPath = await fakeBroker(async () => {
        calls += 1;
        return { status: 200, body: '{}' };
      });
      const relay = createBrokerRelayServer({ socketPath });
      const port = await listenTcp(relay);

      const answer = await rawCall(
        port,
        `POST /internal/git/sign HTTP/1.1\r\nHost: relay\r\nContent-Length: ${declared}\r\n\r\n`,
      );
      expect(answer).toContain('413 Payload Too Large');
      expect(answer).toContain('{"error":"request too large"}');
      expect(calls).toBe(0);
    },
  );

  // The cap bounds what a Sandbox can be handed back. The same broker answer crosses
  // whole under a cap that fits it, and is destroyed under one that does not.
  //
  // The bound is per-CHUNK-BOUNDARY, not per byte: `forwardBrokerRequest` counts as it
  // writes, so a body delivered in several under-cap chunks has its prefix already
  // downstream when a later chunk crosses. The answer here arrives in one chunk that is
  // over the cap by itself, which is the case the destroy actually covers — asserting a
  // stronger "not one byte, ever" contract here would be asserting something the relay
  // does not do.
  it('cuts a response that exceeds the cap instead of forwarding it', async () => {
    const payload = 'x'.repeat(200);
    let calls = 0;
    const socketPath = await fakeBroker(async () => {
      calls += 1;
      return { status: 200, body: payload };
    });
    const requestText =
      'POST /internal/git/sign HTTP/1.1\r\nHost: relay\r\nContent-Length: 0\r\n\r\n';

    const allowed = createBrokerRelayServer({ socketPath, limits: { maxResponseBytes: 1_024 } });
    const forwarded = await rawCallUntilClose(await listenTcp(allowed), requestText);
    expect(forwarded).toContain('200 OK');
    expect(forwarded).toContain(payload);
    expect(calls).toBe(1);

    const capped = createBrokerRelayServer({ socketPath, limits: { maxResponseBytes: 8 } });
    const cut = await rawCallUntilClose(await listenTcp(capped), requestText);
    // The broker WAS reached and DID answer — `calls` rules out the reading where the
    // capped relay simply failed before upstream, which would also produce no `x`.
    expect(calls).toBe(2);
    expect(cut).not.toContain('x');
    expect(cut).not.toContain('200 OK');
  });

  it('applies an absolute upstream deadline even while bytes keep arriving', async () => {
    const dir = temporaryDirectory();
    const socketPath = join(dir, 'trickle.sock');
    let upstreamClosed!: () => void;
    const closed = new Promise<void>((resolve) => {
      upstreamClosed = resolve;
    });
    const upstream = createHttpServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      const timer = setInterval(() => response.write('x'), 5);
      response.once('close', () => {
        clearInterval(timer);
        upstreamClosed();
      });
    });
    servers.push(upstream);
    await listenUnix(upstream, socketPath);
    const relay = createBrokerRelayServer({
      socketPath,
      limits: { requestTimeoutMs: 30, idleTimeoutMs: 1_000 },
    });
    const port = await listenTcp(relay);

    const response = await httpCall(port, {
      method: 'POST',
      path: '/internal/github/token',
    }).catch(() => undefined);

    await closed;
    if (response !== undefined) expect(response.status).toBe(502);
  });

  // The Server parks a brokered tool call on the operator's permission card, so this one
  // route is answered at human speed. Held to the broker profile, all three reapers — the
  // socket idle timer, the upstream timeout and the absolute deadline — fired long before
  // any card could be decided, and every brokered tool call reached the Sandbox as a relay
  // connection error instead of an answer.
  it('holds a decision route open past the broker request profile', async () => {
    let release!: () => void;
    const decided = new Promise<void>((resolve) => {
      release = resolve;
    });
    const socketPath = await fakeBroker(async () => {
      await decided;
      return { status: 200, body: '{"jsonrpc":"2.0","id":1}' };
    });
    const relay = createBrokerRelayServer({
      socketPath,
      limits: { requestTimeoutMs: 40, idleTimeoutMs: 40, decisionTimeoutMs: 10_000 },
    });
    const port = await listenTcp(relay);

    // This also pins the one assumption the split rests on: `server.requestTimeout` stays on
    // the short profile because Node bounds only the RECEIPT of a request with it, never the
    // wait for its response. Were that ever to change, this call comes back 408.
    const answered = httpCall(port, { method: 'POST', path: '/internal/mcp', body: '{}' });
    // Several broker profiles wide: on the old limits the socket is gone by now.
    await new Promise((resolve) => setTimeout(resolve, 250));
    release();

    const response = await answered;
    expect(response.status).toBe(200);
    expect(response.body).toContain('jsonrpc');
  });

  // A pending card must not cost the session its git-sign, which is what a shared in-flight
  // budget would do the moment a call started lasting minutes instead of milliseconds.
  it('budgets parked calls apart from the short broker routes', async () => {
    let parkedSeen = 0;
    let release!: () => void;
    const decided = new Promise<void>((resolve) => {
      release = resolve;
    });
    const socketPath = await fakeBroker(async (incoming) => {
      if (incoming.url !== '/internal/mcp') return { status: 200, body: '{"signed":true}' };
      parkedSeen += 1;
      await decided;
      return { status: 200, body: '{"jsonrpc":"2.0","id":1}' };
    });
    const relay = createBrokerRelayServer({
      socketPath,
      limits: { maxConnections: 1, maxDecisionRequests: 1, decisionTimeoutMs: 10_000 },
    });
    const port = await listenTcp(relay);

    const parked = httpCall(port, { method: 'POST', path: '/internal/mcp', body: '{}' });
    await waitFor(() => parkedSeen === 1);
    // The whole short budget is one request wide, and the parked call is not spending it.
    const signed = await httpCall(port, { method: 'POST', path: '/internal/git/sign', body: '{}' });
    expect(signed.status).toBe(200);

    release();
    expect((await parked).status).toBe(200);
  });

  // And the parked budget binds in its own right — it is a second bound, not an exemption.
  it('refuses a parked call once the decision budget is spent', async () => {
    let parkedSeen = 0;
    let release!: () => void;
    const decided = new Promise<void>((resolve) => {
      release = resolve;
    });
    const socketPath = await fakeBroker(async () => {
      parkedSeen += 1;
      await decided;
      return { status: 200, body: '{"jsonrpc":"2.0","id":1}' };
    });
    const relay = createBrokerRelayServer({
      socketPath,
      limits: { maxDecisionRequests: 1, decisionTimeoutMs: 10_000 },
    });
    const port = await listenTcp(relay);

    const parked = httpCall(port, { method: 'POST', path: '/internal/mcp', body: '{}' });
    await waitFor(() => parkedSeen === 1);
    const second = await httpCall(port, { method: 'POST', path: '/internal/mcp', body: '{}' });

    expect(second.status).toBe(503);
    expect(parkedSeen).toBe(1);

    release();
    expect((await parked).status).toBe(200);
  });

  // A parked call outlives most things, the Sandbox that made it included. Once the caller
  // is gone the answer has nowhere to go, so the upstream is dropped then rather than held
  // to a deadline minutes away — and the slot it was spending comes back with it.
  it('drops a parked call when its caller hangs up', async () => {
    let upstreamGone!: () => void;
    const dropped = new Promise<void>((resolve) => {
      upstreamGone = resolve;
    });
    let parkedSeen = 0;
    const socketPath = await fakeBroker(async (incoming) => {
      parkedSeen += 1;
      incoming.socket.once('close', upstreamGone);
      await new Promise(() => {}); // never decided
      return { status: 200, body: '{}' };
    });
    const relay = createBrokerRelayServer({
      socketPath,
      limits: { maxDecisionRequests: 1, decisionTimeoutMs: 10_000 },
    });
    const port = await listenTcp(relay);

    const abandoned = abandonableCall(port, '/internal/mcp');
    await waitFor(() => parkedSeen === 1);
    abandoned.hangUp();

    await dropped;
    // The budget is one request wide, so a second parked call only lands if the first
    // released its slot on the way out.
    const readmitted = abandonableCall(port, '/internal/mcp');
    await waitFor(() => parkedSeen === 2);
    readmitted.hangUp();
  });

  // The decision budget is generous, not unbounded: a card nobody ever answers still has to
  // release its slot, and the Sandbox has to hear about it as a failure rather than hang.
  it('gives up on a parked call once its own deadline passes', async () => {
    const socketPath = await fakeBroker(async () => {
      await new Promise(() => {}); // never decided
      return { status: 200, body: '{}' };
    });
    const relay = createBrokerRelayServer({ socketPath, limits: { decisionTimeoutMs: 60 } });
    const port = await listenTcp(relay);

    const response = await httpCall(port, { method: 'POST', path: '/internal/mcp', body: '{}' });
    expect(response.status).toBe(502);
  });

  // A decision route the allowlist does not carry is a 404 with a long timeout attached to
  // nothing — the split is only meaningful for routes the relay actually forwards.
  it('keeps every decision route inside the forwarding allowlist', () => {
    for (const route of BROKER_DECISION_ROUTES) expect(BROKER_RELAY_ROUTES.has(route)).toBe(true);
  });
});

describe('Claude relay', () => {
  it('byte-forwards only to its fixed Unix socket', async () => {
    const dir = temporaryDirectory();
    const socketPath = join(dir, 'claude.sock');
    const upstream = createNetServer((socket) => socket.pipe(socket));
    servers.push(upstream);
    await listenUnix(upstream, socketPath);
    const relay = createClaudeRelayServer(socketPath);
    const port = await listenTcp(relay);

    const echoed = await rawEcho(port, 'opaque-tls-record');
    expect(echoed).toBe('opaque-tls-record');
  });

  it('budgets for a full agent turn instead of inheriting the broker request profile', () => {
    expect(CLAUDE_RELAY_LIMITS.idleTimeoutMs).toBeGreaterThanOrEqual(5 * 60_000);
    expect(CLAUDE_RELAY_LIMITS.maxConnections).toBeGreaterThan(RELAY_LIMITS.maxConnections);
  });

  it('applies its own limits to the listening server', async () => {
    const dir = temporaryDirectory();
    const relay = createClaudeRelayServer(join(dir, 'claude.sock'));
    await listenTcp(relay);

    expect(relay.maxConnections).toBe(CLAUDE_RELAY_LIMITS.maxConnections);
  });

  // The relay is the only hop to the Claude socket, so a broker that is not there
  // must close the Sandbox's connection rather than leave it hanging open.
  it('closes the downstream connection when its Unix socket is absent', async () => {
    const dir = temporaryDirectory();
    const relay = createClaudeRelayServer(join(dir, 'missing.sock'));
    const port = await listenTcp(relay);

    const socket = createConnection({ port, host: '127.0.0.1' }, () => socket.write('hello'));
    const received: Buffer[] = [];
    socket.on('data', (chunk: Buffer) => received.push(chunk));
    socket.on('error', () => {});
    await new Promise<void>((resolve) => socket.once('close', () => resolve()));

    expect(Buffer.concat(received).toString()).toBe('');
    expect(socket.destroyed).toBe(true);
  }, 2_000);

  // Both legs are one tunnel: a Sandbox that resets its side must not strand the
  // upstream half against the Claude socket.
  it('tears down the upstream leg when the downstream connection resets', async () => {
    const dir = temporaryDirectory();
    const socketPath = join(dir, 'claude.sock');
    let upstreamClosed!: () => void;
    const closed = new Promise<void>((resolve) => {
      upstreamClosed = resolve;
    });
    const upstream = createNetServer((socket) => {
      socket.on('error', () => {});
      socket.pipe(socket);
      socket.once('close', () => upstreamClosed());
    });
    servers.push(upstream);
    await listenUnix(upstream, socketPath);
    const relay = createClaudeRelayServer(socketPath);
    const port = await listenTcp(relay);

    const socket = createConnection({ port, host: '127.0.0.1' }, () => socket.write('opaque'));
    socket.on('error', () => {});
    await new Promise<void>((resolve) => socket.once('data', () => resolve()));
    socket.resetAndDestroy();

    await closed;
  }, 2_000);

  it('still reaps a silent socket once its idle budget elapses', async () => {
    const dir = temporaryDirectory();
    const socketPath = join(dir, 'claude.sock');
    const upstream = createNetServer((socket) => socket.pipe(socket));
    servers.push(upstream);
    await listenUnix(upstream, socketPath);
    const relay = createClaudeRelayServer(socketPath, { maxConnections: 8, idleTimeoutMs: 60 });
    const port = await listenTcp(relay);

    const socket = createConnection({ port, host: '127.0.0.1' });
    socket.on('error', () => {});
    await new Promise<void>((resolve) => socket.once('close', () => resolve()));

    expect(socket.destroyed).toBe(true);
  }, 2_000);
});

describe('relay limits and lifecycle', () => {
  // Every limit is a bound on what a Sandbox can spend. A zero, negative or
  // fractional one silently disables the bound it names, so the server refuses to
  // exist rather than listen without it.
  it.each([
    { limits: { maxBodyBytes: 0 }, name: 'maxBodyBytes' },
    { limits: { maxResponseBytes: -1 }, name: 'maxResponseBytes' },
    { limits: { maxConnections: 1.5 }, name: 'maxConnections' },
    { limits: { requestTimeoutMs: Number.NaN }, name: 'requestTimeoutMs' },
    { limits: { maxDecisionRequests: 0 }, name: 'maxDecisionRequests' },
    { limits: { decisionTimeoutMs: 0 }, name: 'decisionTimeoutMs' },
  ])('refuses to build a broker relay with an invalid $name', ({ limits, name }) => {
    expect(() => createBrokerRelayServer({ limits })).toThrow(`invalid relay limit: ${name}`);
  });

  it('applies the shipped defaults when nothing is overridden', () => {
    const relay = createBrokerRelayServer();
    servers.push(relay);

    // The listener carries both budgets: parked calls hold TCP connections of their own.
    expect(relay.maxConnections).toBe(
      RELAY_LIMITS.maxConnections + RELAY_LIMITS.maxDecisionRequests,
    );
    expect(relay.requestTimeout).toBe(RELAY_LIMITS.requestTimeoutMs);
    expect(relay.headersTimeout).toBe(RELAY_LIMITS.headersTimeoutMs);
    expect(relay.keepAliveTimeout).toBe(
      Math.min(RELAY_LIMITS.idleTimeoutMs, RELAY_LIMITS.requestTimeoutMs),
    );
  });

  it('binds both listeners and reports the ports it actually got', async () => {
    const dir = temporaryDirectory();
    const started = await startRelay({
      host: '127.0.0.1',
      brokerPort: 0,
      claudePort: 0,
      brokerSocketPath: join(dir, 'broker.sock'),
      claudeSocketPath: join(dir, 'claude.sock'),
    });
    try {
      expect(started.brokerPort).toBeGreaterThan(0);
      expect(started.claudePort).toBeGreaterThan(0);
      expect(started.brokerPort).not.toBe(started.claudePort);
      // Bound and reachable, not merely reported.
      const answer = await rawCall(
        started.brokerPort,
        'POST /projects HTTP/1.1\r\nHost: relay\r\nContent-Length: 0\r\n\r\n',
      );
      expect(answer).toContain('404 Not Found');
    } finally {
      await started.close();
    }
    await expect(
      rawCall(started.brokerPort, 'GET / HTTP/1.1\r\nHost: relay\r\n\r\n'),
    ).rejects.toMatchObject({ code: 'ECONNREFUSED' });
  });

  // Half a relay is worse than none: the broker port would be open to the Sandbox
  // while the Claude tunnel is not, so a partial bind has to give both ports back.
  it('releases the port it did bind when the second listener cannot bind', async () => {
    const dir = temporaryDirectory();
    const occupied = createNetServer();
    servers.push(occupied);
    const claudePort = await listenTcp(occupied);

    // `freePort()` can only report a port that WAS free: anything else on this host
    // may claim it in the window before startRelay binds, and then the FIRST listener
    // is the one that loses — a different scenario with nothing to roll back. Detect
    // that by which port the EADDRINUSE names and take another port, rather than
    // reporting the ephemeral-port lottery as a rollback failure.
    let brokerPort = 0;
    for (let attempt = 0; ; attempt += 1) {
      brokerPort = await freePort();
      const failure: (NodeJS.ErrnoException & { port?: number }) | undefined = await startRelay({
        host: '127.0.0.1',
        brokerPort,
        claudePort,
        brokerSocketPath: join(dir, 'broker.sock'),
        claudeSocketPath: join(dir, 'claude.sock'),
      }).then(
        () => undefined,
        (error: NodeJS.ErrnoException & { port?: number }) => error,
      );
      expect(failure?.code).toBe('EADDRINUSE');
      if (failure?.port !== brokerPort) break;
      if (attempt === 4) throw new Error('could not hold a free broker port for this test');
    }

    // The broker listener bound first and must have been closed again.
    const rebound = createNetServer();
    servers.push(rebound);
    await new Promise<void>((resolve, reject) => {
      rebound.once('error', reject);
      rebound.listen(brokerPort, '127.0.0.1', resolve);
    });
    expect(rebound.listening).toBe(true);
  });
});

async function freePort(): Promise<number> {
  const probe = createNetServer();
  const port = await new Promise<number>((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (typeof address !== 'object' || address === null) reject(new Error('missing address'));
      else resolve(address.port);
    });
  });
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

describe('parallel agent gateway relays', () => {
  it('starts independent Claude and Codex raw tunnels', async () => {
    const dir = temporaryDirectory();
    const claudeSocketPath = join(dir, 'claude.sock');
    const codexSocketPath = join(dir, 'codex.sock');
    for (const socketPath of [claudeSocketPath, codexSocketPath]) {
      const upstream = createNetServer((socket) => socket.pipe(socket));
      servers.push(upstream);
      await listenUnix(upstream, socketPath);
    }

    const relay = await startRelay({
      host: '127.0.0.1',
      brokerPort: 0,
      claudePort: 0,
      codexPort: 0,
      brokerSocketPath: join(dir, 'broker.sock'),
      claudeSocketPath,
      codexSocketPath,
    });
    try {
      expect(await rawEcho(relay.claudePort, 'claude-record')).toBe('claude-record');
      expect(await rawEcho(relay.codexPort, 'codex-record')).toBe('codex-record');
      expect(relay.brokerPort).toBeGreaterThan(0);
    } finally {
      await relay.close();
    }
  });
});

async function fakeBroker(
  handler: (
    request: IncomingMessage,
  ) => Promise<{ status: number; body: string; headers?: Record<string, string> }>,
): Promise<string> {
  const dir = temporaryDirectory();
  const socketPath = join(dir, 'broker.sock');
  const server = createHttpServer((incoming, response) => {
    void handler(incoming).then(({ status, body, headers }) => {
      response.writeHead(status, { 'content-type': 'application/json', ...headers });
      response.end(body);
    });
  });
  servers.push(server);
  await listenUnix(server, socketPath);
  return socketPath;
}

function temporaryDirectory(): string {
  const dir = mkdtempSync(join(tmpdir(), 'verity-relay-test-'));
  dirs.push(dir);
  return dir;
}

function listenTcp(server: Server | HttpServer): Promise<number> {
  servers.push(server);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (typeof address !== 'object' || address === null) reject(new Error('missing address'));
      else resolve(address.port);
    });
  });
}

function listenUnix(server: Server | HttpServer, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
}

function httpCall(
  port: number,
  options: {
    method?: string;
    path: string;
    headers?: Record<string, string>;
    body?: string;
  },
): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const body = options.body ?? '';
    const outgoing = request(
      {
        host: '127.0.0.1',
        port,
        method: options.method ?? 'GET',
        path: options.path,
        headers: { ...options.headers, 'content-length': String(Buffer.byteLength(body)) },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.once('error', reject);
        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString(),
          }),
        );
      },
    );
    outgoing.once('error', reject);
    outgoing.end(body);
  });
}

/** A request the caller can walk away from mid-flight, as a Sandbox that dies does. */
function abandonableCall(port: number, path: string): { hangUp: () => void } {
  const socket = createConnection({ host: '127.0.0.1', port }, () => {
    socket.write(
      `POST ${path} HTTP/1.1\r\nhost: relay\r\ncontent-type: application/json\r\ncontent-length: 2\r\n\r\n{}`,
    );
  });
  socket.on('error', () => undefined);
  return { hangUp: () => socket.destroy() };
}

function rawCall(port: number, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port }, () => socket.end(payload));
    const chunks: Buffer[] = [];
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.once('end', () => resolve(Buffer.concat(chunks).toString()));
    socket.once('error', reject);
  });
}

/** Like `rawCall`, but for a response the relay is expected to cut short: it
 * resolves with whatever arrived before the connection died. */
function rawCallUntilClose(port: number, payload: string): Promise<string> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port }, () => socket.write(payload));
    const chunks: Buffer[] = [];
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.on('error', () => {});
    socket.once('close', () => resolve(Buffer.concat(chunks).toString()));
  });
}

function rawEcho(port: number, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port }, () => socket.write(payload));
    socket.once('data', (chunk: Buffer) => {
      resolve(chunk.toString());
      socket.destroy();
    });
    socket.once('error', reject);
  });
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.once('end', () => resolve(Buffer.concat(chunks).toString()));
    request.once('error', reject);
  });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('condition was not reached');
}
