import { request as httpRequest } from 'node:http';
import { createConnection } from 'node:net';
import { PassThrough, Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CONNECTOR_HOST,
  runEgressConnector,
  validateEgressConnectorOptions,
  type EgressConnectorOptions,
} from '../../../features/verity-sandbox-toolkit/bin/verity-egress-connector.mjs';
import { CLAUDE_EGRESS_PLACEHOLDER } from './claude-egress-policy.js';

const LOCAL_AUTHORITY = '127.0.0.1:43123';
const EGRESS_URL = 'https://claude-gateway.internal:9443';
const connectors: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(connectors.splice(0).map((connector) => connector.close()));
});

describe('Sandbox-local Claude egress connector', () => {
  it('binds only loopback and streams the placeholder request to the fixed gateway', async () => {
    let requestBody = '';
    const forward = vi.fn<NonNullable<EgressConnectorOptions['forward']>>(async (request) => {
      for await (const chunk of request.body as AsyncIterable<Buffer>) {
        requestBody += chunk.toString('utf8');
      }
      expect(request.url.href).toBe(`${EGRESS_URL}/v1/messages`);
      expect(request.headers.authorization).toBe(`Bearer ${CLAUDE_EGRESS_PLACEHOLDER}`);
      expect(request.headers.host).toBe('claude-gateway.internal:9443');
      expect(request.headers['x-secret-hop']).toBeUndefined();
      expect(request.tls).toMatchObject({
        ca: 'public-ca',
        cert: 'project-cert',
        key: 'project-key',
        servername: 'claude-gateway.internal',
      });
      return {
        status: 200,
        headers: { 'content-type': 'application/json', connection: 'keep-alive' },
        body: Readable.from(['{"ok":true}']),
      };
    });
    const connector = await start(forward);

    expect(connector.host).toBe(CONNECTOR_HOST);
    await expect(
      call(
        connector.port,
        '/v1/messages',
        {
          host: LOCAL_AUTHORITY,
          authorization: `Bearer ${CLAUDE_EGRESS_PLACEHOLDER}`,
          'content-type': 'application/json',
          connection: 'keep-alive, x-secret-hop',
          'x-secret-hop': 'must-not-forward',
        },
        '{"prompt":"hello"}',
      ),
    ).resolves.toEqual({ status: 200, body: '{"ok":true}' });
    expect(requestBody).toBe('{"prompt":"hello"}');
  });

  it('answers readiness locally without contacting the credential gateway', async () => {
    const forward = vi.fn<NonNullable<EgressConnectorOptions['forward']>>();
    const connector = await start(forward);

    const response = await call(connector.port, '/__verity/ready', { host: LOCAL_AUTHORITY });
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({ protocolVersion: 1, ready: true });
    expect(forward).not.toHaveBeenCalled();
  });

  it('derives the local authority atomically for an ephemeral port', async () => {
    const forward = vi.fn<NonNullable<EgressConnectorOptions['forward']>>(async () => ({
      status: 200,
      headers: {},
      body: Readable.from(['ok']),
    }));
    const connector = await runEgressConnector({
      ...options(),
      localAuthority: `${CONNECTOR_HOST}:0`,
      forward,
    });
    connectors.push(connector);

    await expect(
      call(connector.port, '/v1/messages', { host: `${CONNECTOR_HOST}:${connector.port}` }),
    ).resolves.toEqual({ status: 200, body: 'ok' });
    expect(forward).toHaveBeenCalledOnce();
  });

  it('keeps the gateway authority when the transport URL addresses a relay', async () => {
    const forward = vi.fn<NonNullable<EgressConnectorOptions['forward']>>(async (request) => {
      expect(request.url.href).toBe('https://relay.internal:8443/v1/messages');
      expect(request.headers.host).toBe('claude-gateway.internal:9443');
      expect(request.tls.servername).toBe('claude-gateway.internal');
      return { status: 200, headers: {}, body: Readable.from(['ok']) };
    });
    const connector = await runEgressConnector({
      ...options('https://relay.internal:8443'),
      servername: 'claude-gateway.internal',
      forward,
    });
    connectors.push(connector);

    await expect(call(connector.port, '/v1/messages', { host: LOCAL_AUTHORITY })).resolves.toEqual({
      status: 200,
      body: 'ok',
    });
    expect(forward).toHaveBeenCalledOnce();
  });

  it('routes only the Codex prefix through the parallel fixed gateway', async () => {
    const forward = vi.fn<NonNullable<EgressConnectorOptions['forward']>>(async (request) => {
      expect(request.url.href).toBe('https://relay.internal:8444/codex/responses');
      expect(request.headers.host).toBe('codex-gateway.internal:9444');
      expect(request.tls.servername).toBe('codex-gateway.internal');
      return { status: 200, headers: {}, body: Readable.from(['ok']) };
    });
    const connector = await runEgressConnector({
      ...options('https://relay.internal:8443'),
      servername: 'gateway.internal',
      codexEgressUrl: 'https://relay.internal:8444',
      codexEgressAuthority: 'codex-gateway.internal:9444',
      forward,
    });
    connectors.push(connector);

    await expect(
      call(connector.port, '/codex/responses', {
        host: LOCAL_AUTHORITY,
        authorization: 'Bearer verity-codex-gateway-placeholder-v1',
      }),
    ).resolves.toEqual({ status: 200, body: 'ok' });
  });

  // The body is the whole diagnosis a Codex turn gets: codex reports it verbatim
  // as the reason the stream disconnected. Naming the Claude connector there sent
  // an operator hunting through the wrong gateway for a missing Codex credential.
  it('names Codex, not Claude, when the Codex gateway refuses the connection', async () => {
    const forward = vi.fn<NonNullable<EgressConnectorOptions['forward']>>(async () => {
      throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    });
    const connector = await runEgressConnector({
      ...options(),
      codexEgressUrl: 'https://relay.internal:8444',
      codexEgressAuthority: 'codex-gateway.internal:9444',
      forward,
    });
    connectors.push(connector);

    const codex = await call(connector.port, '/codex/responses', { host: LOCAL_AUTHORITY });
    expect(codex.status).toBe(502);
    expect(codex.body).toContain('Codex egress unavailable');
    expect(codex.body).toContain('has no Codex credentials configured yet');
    expect(codex.body).not.toContain('Claude');

    // The Claude leg keeps its own wording — the two failures are different repairs.
    const claude = await call(connector.port, '/v1/messages', { host: LOCAL_AUTHORITY });
    expect(claude).toEqual({ status: 502, body: 'Claude connector upstream unavailable' });

    // Rejected before any routing decision, so it blames neither gateway: this
    // is a Codex request, and answering it with the Claude wording is the very
    // misdirection the split exists to remove.
    const mismatch = await call(connector.port, '/codex/responses', { host: 'other-project:1' });
    expect(mismatch).toEqual({
      status: 502,
      body: 'Verity sandbox connector rejected the request before any gateway was reached.',
    });
  });

  // Routing to a gateway is not the same as depending on it: an absolute-form
  // target picks the Claude leg and is then refused before the forward, so the
  // gateway is uninvolved and neither the body nor the record may name it.
  it('blames no gateway for a rejection it made after routing', async () => {
    const forward = vi.fn<NonNullable<EgressConnectorOptions['forward']>>();
    const lines: string[] = [];
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      lines.push(String(chunk));
      return true;
    });
    try {
      const connector = await runEgressConnector({ ...options(), forward });
      connectors.push(connector);
      lines.length = 0;

      const escape = await rawCall(
        connector.port,
        `GET http://elsewhere.internal/v1/messages HTTP/1.1\r\nHost: ${LOCAL_AUTHORITY}\r\nConnection: close\r\n\r\n`,
      );
      expect(escape).toContain(' 502 ');
      expect(escape).toContain('before any gateway was reached');
      expect(escape).not.toContain('Claude connector upstream unavailable');
      expect(forward).not.toHaveBeenCalled();
      // And the record agrees: the body saying one thing while the sandbox log
      // files it under `claude` is the same misdiagnosis one layer down.
      expect(connectorRecords(lines, 'rejected').map((record) => record.leg)).toEqual(['unrouted']);
    } finally {
      stderr.mockRestore();
    }
  });

  // A refused connection is the one Codex fault with a dominant cause. Anything
  // else — timeout, DNS, TLS — must not send an operator to the credential page.
  it('offers the credential repair only when the Codex gateway refused', async () => {
    const connector = await runEgressConnector({
      ...options(),
      codexEgressUrl: 'https://relay.internal:8444',
      codexEgressAuthority: 'codex-gateway.internal:9444',
      forward: async () => {
        throw Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' });
      },
    });
    connectors.push(connector);

    const codex = await call(connector.port, '/codex/responses', { host: LOCAL_AUTHORITY });
    expect(codex.body).toContain('Codex egress unavailable');
    expect(codex.body).not.toContain('credentials');
  });

  // The repair line may not depend on how the connection was attempted: node
  // reports a dual-stack connect failure as an `AggregateError` over the
  // addresses it tried, and a fetch-shaped forward wraps the syscall error in
  // `cause`. Both are the same refused gateway the agent needs told about.
  it('recognises a refused Codex gateway through a wrapped error', async () => {
    const refused = () =>
      Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    const wrapped = [
      new AggregateError(
        [
          Object.assign(new Error('connect EHOSTUNREACH'), {
            code: 'EHOSTUNREACH',
          }),
          refused(),
        ],
        'connect failed',
      ),
      new Error('fetch failed', { cause: refused() }),
    ];
    for (const error of wrapped) {
      const connector = await runEgressConnector({
        ...options(),
        codexEgressUrl: 'https://relay.internal:8444',
        codexEgressAuthority: 'codex-gateway.internal:9444',
        forward: () => Promise.reject(error),
      });
      connectors.push(connector);

      const codex = await call(connector.port, '/codex/responses', { host: LOCAL_AUTHORITY });
      expect(codex.body).toContain('has no Codex credentials configured yet');
    }
  });

  // The failure body reaches the agent, the log reaches the operator: both have
  // to name the same leg, or the sandbox record contradicts what the agent saw.
  it('names the leg in its own record too', async () => {
    const lines: string[] = [];
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      lines.push(String(chunk));
      return true;
    });
    try {
      const connector = await runEgressConnector({
        ...options(),
        codexEgressUrl: 'https://relay.internal:8444',
        codexEgressAuthority: 'codex-gateway.internal:9444',
        forward: async () => {
          throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
        },
      });
      connectors.push(connector);

      // A second connector for the one leg the first cannot produce.
      const unconfigured = await start(async () => {
        throw new Error('unused');
      });

      // From here on the only writer on this stream is one of these two: an
      // earlier test's connector can still be reporting while this one starts.
      lines.length = 0;

      await call(connector.port, '/codex/responses', { host: LOCAL_AUTHORITY });
      await call(connector.port, '/v1/messages', { host: LOCAL_AUTHORITY });
      await call(connector.port, '/codex/responses', { host: 'other-project:1' });
      await call(unconfigured.port, '/codex/responses', { host: LOCAL_AUTHORITY });
      // Answered by the connector itself, so it reaches no gateway — and is not
      // recorded at all, which is the only way it cannot be filed under one.
      await call(connector.port, '/__verity/ready', { host: LOCAL_AUTHORITY });

      const legs = connectorRecords(lines, 'rejected').map(
        (record) => `${String(record.status)} ${record.leg}`,
      );
      expect(legs).toEqual(['502 codex', '502 claude', '502 unrouted', '502 codex-unconfigured']);
    } finally {
      stderr.mockRestore();
    }
  });

  // The record every healthy turn writes, and the one an operator reads most:
  // a Codex turn filed under `claude` would misattribute the whole gateway's
  // traffic without any failure ever making the mistake visible.
  it('names the leg on a request that succeeded', async () => {
    const lines: string[] = [];
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      lines.push(String(chunk));
      return true;
    });
    try {
      const connector = await runEgressConnector({
        ...options(),
        codexEgressUrl: 'https://relay.internal:8444',
        codexEgressAuthority: 'codex-gateway.internal:9444',
        forward: async () => ({ status: 200, headers: {}, body: Readable.from(['ok']) }),
      });
      connectors.push(connector);

      lines.length = 0;
      await call(connector.port, '/codex/responses', { host: LOCAL_AUTHORITY });
      await call(connector.port, '/v1/messages', { host: LOCAL_AUTHORITY });

      const legs = connectorRecords(lines, 'completed').map(
        (record) => `${String(record.status)} ${record.leg}`,
      );
      expect(legs).toEqual(['200 codex', '200 claude']);
    } finally {
      stderr.mockRestore();
    }
  });

  it('reports an unconfigured Codex egress without reaching for the Claude one', async () => {
    const forward = vi.fn<NonNullable<EgressConnectorOptions['forward']>>();
    const connector = await start(forward);

    const response = await call(connector.port, '/codex/responses', { host: LOCAL_AUTHORITY });
    expect(response.status).toBe(502);
    expect(response.body).toBe(
      'Codex egress is not configured for this Sandbox: it was provisioned without a Codex gateway.',
    );
    expect(forward).not.toHaveBeenCalled();
  });

  it('rejects local authority mismatch and absolute-form origin escape', async () => {
    const forward = vi.fn<NonNullable<EgressConnectorOptions['forward']>>();
    const connector = await start(forward);

    await expect(
      call(connector.port, '/v1/messages', {
        host: 'other-project:43123',
        authorization: `Bearer ${CLAUDE_EGRESS_PLACEHOLDER}`,
      }),
    ).resolves.toMatchObject({ status: 502 });
    await expect(
      call(connector.port, 'https://evil.example/collect', {
        host: LOCAL_AUTHORITY,
        authorization: `Bearer ${CLAUDE_EGRESS_PLACEHOLDER}`,
      }),
    ).resolves.toMatchObject({ status: 502 });
    expect(forward).not.toHaveBeenCalled();
  });

  it('rejects duplicate Host fields from a raw local client', async () => {
    const forward = vi.fn<NonNullable<EgressConnectorOptions['forward']>>();
    const connector = await start(forward);

    const response = await rawCall(
      connector.port,
      `GET /v1/messages HTTP/1.1\r\nHost: ${LOCAL_AUTHORITY}\r\nHost: other:1\r\nConnection: close\r\n\r\n`,
    );
    expect(response).toContain(' 502 ');
    expect(forward).not.toHaveBeenCalled();
  });

  it('fails closed on upstream redirects without exposing their location', async () => {
    let aborted = false;
    const connector = await start(async (request) => {
      request.signal.addEventListener('abort', () => (aborted = true));
      return {
        status: 307,
        headers: { location: 'https://evil.example/collect' },
        body: Readable.from([]),
      };
    });

    const response = await call(connector.port, '/v1/messages', {
      host: LOCAL_AUTHORITY,
      authorization: `Bearer ${CLAUDE_EGRESS_PLACEHOLDER}`,
    });
    expect(response.status).toBe(502);
    expect(response.body).not.toContain('evil.example');
    expect(aborted).toBe(true);
  });

  it('forces an active stream closed after the shutdown grace', async () => {
    const neverEnds = new PassThrough();
    neverEnds.write('stream remains active');
    const connector = await runEgressConnector({
      ...options(),
      shutdownGraceMs: 10,
      forward: async () => ({ status: 200, headers: {}, body: neverEnds }),
    });
    connectors.push(connector);
    const active = httpRequest({
      host: CONNECTOR_HOST,
      port: connector.port,
      headers: {
        host: LOCAL_AUTHORITY,
        authorization: `Bearer ${CLAUDE_EGRESS_PLACEHOLDER}`,
      },
    });
    active.on('error', () => undefined);
    active.end();
    await new Promise<void>((resolve) => active.once('response', () => resolve()));

    await expect(connector.close()).resolves.toBeUndefined();
    connectors.splice(connectors.indexOf(connector), 1);
  });

  it('rejects non-HTTPS, credentialed, or path-prefixed gateway URLs', () => {
    for (const egressUrl of [
      'http://gateway.internal:9443',
      'https://user:pass@gateway.internal:9443',
      'https://gateway.internal:9443/arbitrary-prefix',
    ]) {
      expect(() => validateEgressConnectorOptions(options(egressUrl))).toThrow(
        'requires an HTTPS egress origin',
      );
    }
  });

  it('rejects malformed gateway authorities', () => {
    for (const egressAuthority of ['', 'user@gateway.internal:9443', 'gateway.internal/path']) {
      expect(() => validateEgressConnectorOptions({ ...options(), egressAuthority })).toThrow(
        'requires a valid egress authority',
      );
    }
  });

  // The sandbox-side half of diagnosing "Connection closed mid-response": with
  // the gateway's record it shows which side dropped the stream, and after how
  // many bytes. Previously this path swallowed the error without even binding it.
  it('records a mid-response break on stderr with the classified error', async () => {
    const lines: string[] = [];
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      lines.push(String(chunk));
      return true;
    });
    try {
      const connector = await start(async () => {
        const body = new Readable({ read() {} });
        body.push('event: partial\n');
        setTimeout(() => {
          body.destroy(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }));
        }, 5);
        return { status: 200, headers: {}, body };
      });

      const aborted = httpRequest({
        host: CONNECTOR_HOST,
        port: connector.port,
        path: '/v1/messages?beta=true',
        method: 'POST',
        headers: { host: LOCAL_AUTHORITY, authorization: `Bearer ${CLAUDE_EGRESS_PLACEHOLDER}` },
      });
      aborted.once('error', () => undefined);
      aborted.once('response', (response) => {
        response.on('data', () => undefined);
        response.once('error', () => undefined);
      });
      aborted.end('{"prompt":"my-private-prompt"}');

      // Match on this request's route: a connector torn down by an earlier test
      // can still emit its own record while this one runs.
      const reported = (): string | undefined =>
        lines.find((line) => line.includes('"path":"/v1/messages"'));
      const deadline = Date.now() + 2_000;
      while (reported() === undefined) {
        if (Date.now() > deadline) throw new Error('connector never reported');
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const record: unknown = JSON.parse(reported() ?? '{}');
      expect(record).toEqual({
        event: 'egress-connector',
        outcome: 'aborted',
        reason: 'Error/ECONNRESET',
        leg: 'claude',
        status: 200,
        method: 'POST',
        path: '/v1/messages',
        bytesForwarded: 'event: partial\n'.length,
        durationMs: expect.any(Number),
      });
      // Runs inside the untrusted sandbox, so it may state only what the sandbox
      // already knows — never the body, a header, a query value or the message.
      const serialised = JSON.stringify(record);
      expect(serialised).not.toContain('my-private-prompt');
      expect(serialised).not.toContain('socket hang up');
      expect(serialised).not.toContain(CLAUDE_EGRESS_PLACEHOLDER);
      expect(serialised).not.toContain('beta');
    } finally {
      stderr.mockRestore();
    }
  });

  it('does not count an upstream body suppressed by HTTP response semantics', async () => {
    const lines: string[] = [];
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      lines.push(String(chunk));
      return true;
    });
    try {
      const connector = await start(async () => ({
        status: 204,
        headers: {},
        body: Readable.from(['not-transmitted']),
      }));
      await call(connector.port, '/v1/messages', { host: LOCAL_AUTHORITY });
      const record = JSON.parse(lines.find((line) => line.includes('"status":204')) ?? '{}');
      expect(record).toMatchObject({ outcome: 'completed', status: 204, bytesForwarded: 0 });
    } finally {
      stderr.mockRestore();
    }
  });

  it('records one cancellation when the agent disconnects before response headers', async () => {
    const lines: string[] = [];
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      lines.push(String(chunk));
      return true;
    });
    try {
      let forwardStarted!: () => void;
      const started = new Promise<void>((resolve) => (forwardStarted = resolve));
      const connector = await start((request) => {
        forwardStarted();
        return new Promise((_, reject) =>
          request.signal.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          }),
        );
      });
      const cancelled = httpRequest({
        host: CONNECTOR_HOST,
        port: connector.port,
        path: '/v1/messages',
        method: 'POST',
        headers: { host: LOCAL_AUTHORITY },
      });
      cancelled.once('error', () => undefined);
      cancelled.end();
      await started;
      cancelled.destroy();

      const deadline = Date.now() + 2_000;
      while (lines.length === 0) {
        if (Date.now() > deadline) throw new Error('connector never reported');
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({
        event: 'egress-connector',
        outcome: 'cancelled',
        reason: 'agent-closed',
        leg: 'claude',
        status: 0,
        bytesForwarded: 0,
      });
    } finally {
      stderr.mockRestore();
    }
  });
});

function options(egressUrl = EGRESS_URL): EgressConnectorOptions {
  return {
    port: 0,
    localAuthority: LOCAL_AUTHORITY,
    egressUrl,
    egressAuthority: 'claude-gateway.internal:9443',
    ca: 'public-ca',
    cert: 'project-cert',
    key: 'project-key',
  };
}

/** The connector's own records off a shared, mocked `process.stderr`, in the
 *  order they were written. Two filters carry the whole reason this is not just
 *  `JSON.parse` over the captured chunks. The event name, because anything else
 *  on that stream — a Node warning, a vitest write — would otherwise fail a test
 *  that is not about it, and because two records can share one write. And the
 *  outcome, because a `cancelled` or `aborted` record is written from a socket
 *  `close` handler: an earlier test's connector can still emit one after the
 *  capture is reset, while a `rejected` or `completed` record is written while
 *  the request it belongs to is still being answered. */
function connectorRecords(lines: string[], outcome: 'rejected' | 'completed') {
  return lines
    .flatMap((chunk) => chunk.split('\n'))
    .filter((line) => line.startsWith('{"event":"egress-connector"'))
    .map((line) => JSON.parse(line) as { leg: string; status: number; outcome: string })
    .filter((record) => record.outcome === outcome);
}

async function start(forward: NonNullable<EgressConnectorOptions['forward']>) {
  const connector = await runEgressConnector({ ...options(), forward });
  connectors.push(connector);
  return connector;
}

function call(
  port: number,
  path: string,
  headers: Record<string, string>,
  body?: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      { host: CONNECTOR_HOST, port, path, method: body === undefined ? 'GET' : 'POST', headers },
      (response) => {
        let responseBody = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => (responseBody += chunk));
        response.once('end', () =>
          resolve({ status: response.statusCode ?? 0, body: responseBody }),
        );
      },
    );
    request.once('error', reject);
    request.end(body);
  });
}

function rawCall(port: number, raw: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: CONNECTOR_HOST, port });
    let response = '';
    socket.setEncoding('utf8');
    socket.once('error', reject);
    socket.on('data', (chunk) => (response += chunk.toString()));
    socket.once('end', () => resolve(response));
    socket.once('connect', () => socket.end(raw));
  });
}
