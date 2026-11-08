import { createServer, type AddressInfo, type Server } from 'node:net';
import { afterEach, expect, it } from 'vitest';

import { runnerEgressReadiness } from '../../../features/verity-sandbox-toolkit/bin/verity-agent-spawn-broker.mjs';

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((r) => server.close(r))));
});

async function listening(): Promise<{ port: number; accepted: () => number }> {
  let count = 0;
  const server = createServer((socket) => {
    count += 1;
    socket.on('data', () => {
      throw new Error('the probe must not send a request');
    });
    socket.destroy();
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { port: (server.address() as AddressInfo).port, accepted: () => count };
}

/** A port that was bound a moment ago and is now closed: connects are refused. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  await new Promise((r) => server.close(r));
  return port;
}

const readyConnector = (async () =>
  new Response('{"protocolVersion":1,"ready":true}', { status: 200 })) as typeof fetch;

// A relay Docker reports running but whose process does not listen yet refuses
// the connect; that is the state a turn must not start in.
it('reports a refusing relay leg and a listening one apart', async () => {
  const codex = await listening();
  const refused = await closedPort();
  const result = await runnerEgressReadiness({
    env: {
      VERITY_CLAUDE_CONNECTOR_PORT: '47821',
      VERITY_CLAUDE_EGRESS_URL: `https://127.0.0.1:${String(refused)}`,
      VERITY_CODEX_EGRESS_URL: `https://127.0.0.1:${String(codex.port)}`,
      VERITY_MCP_GATEWAY_URL: `http://127.0.0.1:${String(refused)}/internal/mcp`,
    },
    fetch: readyConnector,
  });
  expect(result).toEqual({
    ok: true,
    egressReadinessVersion: 1,
    connector: 'ready',
    claude: 'refused',
    codex: 'ready',
    broker: 'refused',
  });
  expect(codex.accepted()).toBe(1);
});

it('leaves legs the Sandbox was provisioned without as not configured', async () => {
  const result = await runnerEgressReadiness({ env: {}, fetch: readyConnector });
  expect(result).toMatchObject({
    connector: 'not_configured',
    claude: 'not_configured',
    codex: 'not_configured',
    broker: 'not_configured',
  });
});

it('reports a local connector that is not up yet', async () => {
  const result = await runnerEgressReadiness({
    env: { VERITY_CLAUDE_CONNECTOR_PORT: String(await closedPort()) },
  });
  expect(result.connector).toBe('refused');
});

it('bounds a hop that never answers', async () => {
  const result = await runnerEgressReadiness({
    env: { VERITY_CODEX_EGRESS_URL: 'https://relay.invalid:8444' },
    connect: (_host, _port, timeoutMs) =>
      new Promise((resolve) => setTimeout(() => resolve('timeout'), timeoutMs)),
    timeoutMs: 20,
  });
  expect(result.codex).toBe('timeout');
});
