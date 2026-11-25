import Fastify, { type FastifyInstance } from 'fastify';
import { request as httpRequest } from 'node:http';
import { Writable } from 'node:stream';
import { performance } from 'node:perf_hooks';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { recordRequestQuery } from '@verity/store';
import { serveLoggedGatewayCall, SLOW_GATEWAY_CALL_MS } from './mcp-gateway-call-log.js';

interface LogLine {
  level: number;
  msg: string;
  reqId?: string;
  toolName?: string;
  outcome?: string;
  callerDisconnected?: boolean;
  queries?: { calls: number };
}

type Serve = () => Promise<{ status: number; body?: unknown }>;

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

function buildApp(serve: Serve): { app: FastifyInstance; lines: LogLine[] } {
  const lines: LogLine[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, done) {
      for (const line of chunk.toString().split('\n').filter(Boolean))
        lines.push(JSON.parse(line) as LogLine);
      done();
    },
  });
  const built = Fastify({ logger: { level: 'info', stream } });
  built.post('/internal/mcp', async (request, reply) => {
    const response = await serveLoggedGatewayCall(request, reply, serve);
    reply.code(response.status);
    return response.body === undefined ? reply.send() : response.body;
  });
  app = built;
  return { app: built, lines };
}

const toolCall = (name: unknown) => ({
  jsonrpc: '2.0',
  id: 7,
  method: 'tools/call',
  params: { name, arguments: {} },
});

describe('serveLoggedGatewayCall', () => {
  it('names the tool on a start and a finish line sharing the request id', async () => {
    const { app, lines } = buildApp(() => {
      // Stands in for a store query: it must be counted in the call's own trace.
      recordRequestQuery(2, false);
      return Promise.resolve({ status: 200, body: { jsonrpc: '2.0', id: 7, result: {} } });
    });
    await app.inject({
      method: 'POST',
      url: '/internal/mcp',
      payload: toolCall('verity_publish_session_progress'),
    });
    const started = lines.find((line) => line.msg === 'mcp gateway tool call started');
    const finished = lines.find((line) => line.msg === 'mcp gateway tool call finished');
    expect(started?.toolName).toBe('verity_publish_session_progress');
    expect(finished).toMatchObject({
      toolName: 'verity_publish_session_progress',
      outcome: 'result',
      callerDisconnected: false,
      queries: { calls: 1 },
    });
    expect(finished?.reqId).toBe(started?.reqId);
  });

  it('reports a JSON-RPC or tool error as an error outcome', async () => {
    const { app, lines } = buildApp(() =>
      Promise.resolve({
        status: 200,
        body: { jsonrpc: '2.0', id: 7, result: { isError: true, content: [] } },
      }),
    );
    await app.inject({ method: 'POST', url: '/internal/mcp', payload: toolCall('verity_tasks') });
    expect(lines.find((line) => line.msg === 'mcp gateway tool call finished')?.outcome).toBe(
      'error',
    );
  });

  it('leaves lifecycle requests such as initialize unlogged', async () => {
    const { app, lines } = buildApp(() => Promise.resolve({ status: 200, body: {} }));
    await app.inject({
      method: 'POST',
      url: '/internal/mcp',
      payload: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    });
    expect(lines.some((line) => line.msg.startsWith('mcp gateway tool call'))).toBe(false);
  });

  it('bounds an oversized tool name', async () => {
    const { app, lines } = buildApp(() => Promise.resolve({ status: 200, body: {} }));
    await app.inject({ method: 'POST', url: '/internal/mcp', payload: toolCall('x'.repeat(5000)) });
    expect(
      lines.find((line) => line.msg === 'mcp gateway tool call started')?.toolName,
    ).toHaveLength(100);
  });

  // The incident this guards: a caller that timed out left Fastify without any completion
  // line, so the request log could not tell a slow call from one that never returned.
  it('logs a call that finishes after its caller disconnected, as a warning', async () => {
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let release!: () => void;
    const { app, lines } = buildApp(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { status: 200, body: { jsonrpc: '2.0', id: 7, result: {} } };
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    const caller = httpRequest({
      host: '127.0.0.1',
      port: address.port,
      method: 'POST',
      path: '/internal/mcp',
      headers: { 'content-type': 'application/json' },
    });
    caller.on('error', () => undefined);
    caller.end(JSON.stringify(toolCall('verity_project_inquiry')));
    await new Promise((resolve) => setTimeout(resolve, 50));
    caller.destroy();
    // Finish the handler only once the server has had time to see the caller leave.
    await new Promise((resolve) => setTimeout(resolve, 100));
    release();
    const poll = setInterval(() => {
      if (lines.some((line) => line.msg === 'mcp gateway tool call finished')) finish();
    }, 5);
    const deadline = setTimeout(() => finish(), 5_000);
    await finished;
    clearInterval(poll);
    clearTimeout(deadline);
    expect(
      lines.some((line) => line.msg === 'mcp gateway tool call finished'),
      'an abandoned call must still log its finish line',
    ).toBe(true);
    const line = lines.find((entry) => entry.msg === 'mcp gateway tool call finished');
    expect(line).toMatchObject({ toolName: 'verity_project_inquiry', callerDisconnected: true });
    expect(line?.level).toBe(40);
    expect(lines.some((entry) => entry.msg === 'request completed')).toBe(false);
  });

  it('warns about a call slower than the threshold', async () => {
    let elapsed = 0;
    const { app, lines } = buildApp(() => {
      elapsed = SLOW_GATEWAY_CALL_MS + 1;
      return Promise.resolve({ status: 200, body: {} });
    });
    const real = performance.now.bind(performance);
    const base = real();
    vi.spyOn(performance, 'now').mockImplementation(() => base + elapsed);
    try {
      await app.inject({
        method: 'POST',
        url: '/internal/mcp',
        payload: toolCall('verity_diagnostics'),
      });
    } finally {
      vi.restoreAllMocks();
    }
    expect(lines.find((line) => line.msg === 'mcp gateway tool call finished')).toMatchObject({
      level: 40,
      toolName: 'verity_diagnostics',
    });
  });

  it('keeps a fast, connected call at info level', async () => {
    const { app, lines } = buildApp(() => Promise.resolve({ status: 200, body: {} }));
    await app.inject({ method: 'POST', url: '/internal/mcp', payload: toolCall('verity_tasks') });
    expect(lines.find((line) => line.msg === 'mcp gateway tool call finished')?.level).toBe(30);
  });
});
