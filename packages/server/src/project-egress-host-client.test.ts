import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server, type RequestListener } from 'node:http';
import { join } from 'node:path';
import { createProjectEgressHostClient } from './project-egress-host-client.js';

const servers: Server[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function fixture(listener: RequestListener, timeoutMs = 1000) {
  const directory = await mkdtemp('/tmp/egress-client-');
  directories.push(directory);
  const socketPath = join(directory, 'control.sock');
  const server = createServer(listener);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return createProjectEgressHostClient({ socketPath, token: 'a'.repeat(64), timeoutMs });
}
const start = {
  operation: 'start',
  projectId: 'p1',
  generation: 'g1',
  role: 'sandbox',
  containerId: 'b'.repeat(64),
} as const;
it('authenticates over Unix and accepts only the requested generation and result', async () => {
  const command = await fixture((req, res) => {
    expect(req.url).toBe('/v1/command');
    expect(req.headers.authorization).toBe(`Bearer ${'a'.repeat(64)}`);
    req.resume();
    res.end(JSON.stringify({ state: 'started-denied', generation: 'g1' }));
  });
  await expect(command(start)).resolves.toEqual({ state: 'started-denied', generation: 'g1' });
});
it('rejects wrong generation, unexpected states, foreign bindings, redirects and oversized replies', async () => {
  for (const value of [
    { state: 'started-denied', generation: 'foreign' },
    { state: 'denied', generation: 'g1' },
    { state: 'current', projectId: 'foreign', binding: null },
    { state: 'started-denied', generation: 'g1', extra: true },
    'x'.repeat(8193),
  ]) {
    const command = await fixture((req, res) => {
      req.resume();
      res.end(JSON.stringify(value));
    });
    await expect(command(start)).rejects.toThrow('outcome may be unknown');
  }
  const redirected = await fixture((req, res) => {
    req.resume();
    res.writeHead(302, { location: 'http://localhost/' }).end();
  });
  await expect(redirected(start)).rejects.toThrow();
});
it('bounds total time and never retries an ambiguous start', async () => {
  let calls = 0;
  const command = await fixture((req, res) => {
    calls++;
    req.resume();
    res.writeHead(200);
    res.write('{');
  }, 30);
  await expect(command(start)).rejects.toThrow('outcome may be unknown');
  expect(calls).toBe(1);
});
it('rejects a current binding for another project even inside a matching envelope', async () => {
  const command = await fixture((req, res) => {
    req.resume();
    res.end(
      JSON.stringify({
        state: 'current',
        projectId: 'p1',
        binding: {
          projectId: 'p2',
          generation: 'g1',
          networkName: 'n1',
          networkId: 'b'.repeat(64),
          bridge: 'vep0123456789ab',
        },
      }),
    );
  });
  await expect(command({ operation: 'current', projectId: 'p1' })).rejects.toThrow();
});
