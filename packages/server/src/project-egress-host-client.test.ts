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

it.each(['start', 'connect'] as const)(
  'accepts only generation-matched transport readiness for %s',
  async (operation) => {
    const state = operation === 'start' ? 'started-connected' : 'connected';
    for (const generation of ['g1', 'foreign']) {
      const reply = { state, generation, relayAddress: '172.20.0.3' };
      const command = await fixture((req, res) => {
        req.resume();
        res.end(JSON.stringify(reply));
      });
      const request =
        operation === 'start' ? start : { operation, projectId: 'p1', generation: 'g1' };
      if (generation === 'g1') await expect(command(request)).resolves.toEqual(reply);
      else await expect(command(request)).rejects.toThrow('outcome may be unknown');
    }
  },
);
it('does not confuse explicit connect readiness with start or denial acknowledgements', async () => {
  for (const state of ['started-connected', 'started-denied', 'denied']) {
    const command = await fixture((req, res) => {
      req.resume();
      res.end(
        JSON.stringify({
          state,
          generation: 'g1',
          ...(state === 'started-connected' ? { relayAddress: '172.20.0.3' } : {}),
        }),
      );
    });
    await expect(
      command({ operation: 'connect', projectId: 'p1', generation: 'g1' }),
    ).rejects.toThrow();
  }
});
it('accepts only generation-matched name answers for resolve-direct', async () => {
  const request = {
    operation: 'resolve-direct' as const,
    projectId: 'p1',
    generation: 'g1',
    name: 'downloads.example.com',
  };
  for (const [reply, accepted] of [
    [{ state: 'resolved', generation: 'g1', addresses: ['8.8.8.8'], ttlSeconds: 3 }, true],
    [{ state: 'unresolved', generation: 'g1' }, true],
    [{ state: 'unresolved', generation: 'g2' }, false],
    [{ state: 'denied', generation: 'g1' }, false],
  ] as const) {
    const command = await fixture((req, res) => {
      req.resume();
      res.end(JSON.stringify(reply));
    });
    if (accepted) await expect(command(request)).resolves.toEqual(reply);
    else await expect(command(request)).rejects.toThrow('outcome may be unknown');
  }
});

it.each([
  [401, 'authentication_failed'],
  [503, 'host_not_ready'],
  [302, 'host_not_ready'],
] as const)(
  'classifies HTTP %s without disclosing host response contents',
  async (status, reason) => {
    const command = await fixture((req, res) => {
      req.resume();
      res.writeHead(status).end('private host configuration');
    });
    await expect(command({ operation: 'health' })).rejects.toMatchObject({ reason });
    await expect(command({ operation: 'health' })).rejects.not.toThrow(
      'private host configuration',
    );
  },
);
it('recovers when the projected key becomes readable without reconstructing the client', async () => {
  let readable = false;
  const directory = await mkdtemp('/tmp/egress-key-client-');
  directories.push(directory);
  const socketPath = join(directory, 'control.sock');
  const server = createServer((req, res) => {
    expect(req.headers.authorization).toBe(`Bearer ${'a'.repeat(64)}`);
    req.resume();
    res.end(JSON.stringify({ state: 'health', protocolVersion: 1, packetEnforcement: true }));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  const command = createProjectEgressHostClient({
    socketPath,
    token: () => {
      if (!readable) throw new Error('private key path');
      return 'a'.repeat(64);
    },
  });
  await expect(command({ operation: 'health' })).rejects.toMatchObject({
    reason: 'key_unreadable',
  });
  readable = true;
  await expect(command({ operation: 'health' })).resolves.toMatchObject({
    state: 'health',
    packetEnforcement: true,
  });
});
it('reports a missing socket and malformed health replies with fixed reasons', async () => {
  const command = createProjectEgressHostClient({
    socketPath: '/does-not-exist/verity-control.sock',
    token: 'a'.repeat(64),
  });
  await expect(command({ operation: 'health' })).rejects.toMatchObject({
    reason: 'socket_missing',
  });
  const malformed = await fixture((req, res) => {
    req.resume();
    res.end(JSON.stringify({ state: 'health', protocolVersion: 999, packetEnforcement: true }));
  });
  await expect(malformed({ operation: 'health' })).rejects.toMatchObject({
    reason: 'protocol_mismatch',
  });
});
it('retains timeout classification while aborting a health request', async () => {
  const command = await fixture((req, res) => {
    req.resume();
    res.write('{');
  }, 20);
  await expect(command({ operation: 'health' })).rejects.toMatchObject({ reason: 'timeout' });
});

it('propagates only the fixed incomplete-inventory refusal for a read-only health probe', async () => {
  const command = await fixture((req, res) => {
    req.resume();
    res.writeHead(409).end(
      JSON.stringify({
        error: 'host operation refused',
        reason: 'mandatory_inventory_incomplete',
      }),
    );
  });
  await expect(command({ operation: 'health' })).rejects.toMatchObject({
    reason: 'mandatory_inventory_incomplete',
  });
  await expect(command(start)).rejects.toMatchObject({ reason: 'host_not_ready' });
});
