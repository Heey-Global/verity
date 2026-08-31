import { createServer, request } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  closeManagedGatewayUpstreamSocket,
  startManagedGateway,
  type ManagedGatewayRuntime,
} from './managed-gateway.js';

const closers: (() => Promise<void>)[] = [];
afterEach(async () => Promise.all(closers.splice(0).map((close) => close())));

async function backend(label: string): Promise<{
  port: number;
  connections: Set<import('node:net').Socket>;
  /** Cumulative accepts. `connections` only holds the OPEN ones, so its size
   *  cannot distinguish one reused socket from fifteen that closed behind it. */
  accepted: () => number;
  close(): Promise<void>;
}> {
  const sockets = new Set<import('node:net').Socket>();
  let accepted = 0;
  const server = createServer((req, res) => {
    res.setHeader('x-backend', label);
    res.end(`${label}:${req.method}:${req.url ?? ''}:${req.headers.host ?? ''}`);
  });
  server.on('upgrade', (_req, socket) => {
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: test\r\n\r\n',
    );
    socket.pipe(socket);
  });
  server.on('connection', (socket) => {
    accepted += 1;
    sockets.add(socket);
    socket.on('error', () => undefined);
    socket.once('close', () => sockets.delete(socket));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  return {
    port,
    connections: sockets,
    accepted: () => accepted,
    close: () => {
      for (const socket of sockets) socket.destroy();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

async function get(
  port: number,
  path: string,
  headers?: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    request({ host: '127.0.0.1', port, path, headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () =>
        resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString() }),
      );
    })
      .once('error', reject)
      .end();
  });
}

async function expectConnectionsClosed(sockets: Set<import('node:net').Socket>): Promise<void> {
  for (let attempt = 0; attempt < 200 && sockets.size > 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(sockets.size).toBe(0);
}

async function gateway(
  publicBackend: number,
  internalBackend: number,
): Promise<ManagedGatewayRuntime> {
  const runtime = await startManagedGateway({
    publicPort: 0,
    internalPort: 0,
    backend: { host: '127.0.0.1', publicPort: publicBackend, internalPort: internalBackend },
    allowedBackendHosts: ['127.0.0.1'],
  });
  closers.push(() => runtime.close());
  return runtime;
}

describe('managed gateway foundation', () => {
  it('replaces a spoofed managed-client header with a signed socket identity', async () => {
    let forwarded: string | string[] | undefined;
    const server = createServer((request, response) => {
      forwarded = request.headers['x-verity-managed-client'];
      response.end('ok');
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = (server.address() as { port: number }).port;
    closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const runtime = await startManagedGateway({
      publicPort: 0,
      internalPort: 0,
      backend: { host: '127.0.0.1', publicPort: port, internalPort: port },
      allowedBackendHosts: ['127.0.0.1'],
      clientIdentitySecret: Buffer.alloc(32, 7),
    });
    closers.push(() => runtime.close());

    await get(runtime.publicPort, '/', { 'x-verity-managed-client': 'spoofed' });
    expect(forwarded).toEqual(expect.stringMatching(/^\d+\.[^.]+\.[A-Za-z0-9_-]+$/));
    expect(forwarded).not.toBe('spoofed');
  });

  it('replaces a spoofed managed-client header on WebSocket upgrades', async () => {
    let forwarded: string | string[] | undefined;
    const sockets = new Set<import('node:net').Socket>();
    const server = createServer();
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
    });
    server.on('upgrade', (request, socket) => {
      forwarded = request.headers['x-verity-managed-client'];
      socket.end(
        'HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: test\r\n\r\n',
      );
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = (server.address() as { port: number }).port;
    closers.push(
      () =>
        new Promise<void>((resolve) => {
          for (const socket of sockets) socket.destroy();
          server.close(() => resolve());
        }),
    );
    const runtime = await startManagedGateway({
      publicPort: 0,
      internalPort: 0,
      backend: { host: '127.0.0.1', publicPort: port, internalPort: port },
      allowedBackendHosts: ['127.0.0.1'],
      clientIdentitySecret: Buffer.alloc(32, 7),
    });
    closers.push(() => runtime.close());

    const socket = connect(runtime.publicPort, '127.0.0.1');
    await once(socket, 'connect');
    socket.write(
      'GET /events HTTP/1.1\r\nHost: gateway\r\nConnection: Upgrade\r\nUpgrade: test\r\n' +
        'X-Verity-Managed-Client: spoofed\r\n\r\n',
    );
    await once(socket, 'data');
    socket.destroy();

    expect(forwarded).toEqual(expect.stringMatching(/^\d+\.[^.]+\.[A-Za-z0-9_-]+$/));
    expect(forwarded).not.toBe('spoofed');
  });
  it('switches public and internal routes atomically behind maintenance', async () => {
    const oldBackend = await backend('old');
    const nextBackend = await backend('next');
    closers.push(
      () => oldBackend.close(),
      () => nextBackend.close(),
    );
    const runtime = await gateway(oldBackend.port, oldBackend.port);
    expect((await get(runtime.publicPort, '/before')).body).toContain('old:');
    expect((await get(runtime.internalPort, '/before')).body).toContain('old:');

    runtime.enterMaintenance();
    expect(await get(runtime.publicPort, '/during')).toMatchObject({ status: 503 });
    expect(() =>
      runtime.switchBackend({
        host: '127.0.0.1',
        publicPort: nextBackend.port,
        internalPort: nextBackend.port,
      }),
    ).not.toThrow();
    runtime.leaveMaintenance();

    expect((await get(runtime.publicPort, '/after')).body).toContain('next:');
    expect((await get(runtime.internalPort, '/after')).body).toContain('next:');
  });

  it.each(['/internal/mcp', '/internal/control-plane/mcp'])(
    'keeps an approval request to %s alive beyond the ordinary proxy timeout',
    async (path) => {
      const sockets = new Set<import('node:net').Socket>();
      const server = createServer((_request, response) => {
        setTimeout(() => response.end('approved'), 75);
      });
      server.on('connection', (socket) => {
        sockets.add(socket);
        socket.on('error', () => undefined);
        socket.once('close', () => sockets.delete(socket));
      });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const port = (server.address() as { port: number }).port;
      closers.push(async () => {
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      });
      const runtime = await startManagedGateway({
        publicPort: 0,
        internalPort: 0,
        backend: { host: '127.0.0.1', publicPort: port, internalPort: port },
        allowedBackendHosts: ['127.0.0.1'],
        requestTimeoutMs: 20,
      });
      closers.push(() => runtime.close());

      expect(await get(runtime.internalPort, path)).toEqual({
        status: 200,
        body: 'approved',
      });
      expect(await get(runtime.internalPort, '/internal/other')).toEqual({
        status: 502,
        body: '{"error":"upstream unavailable"}',
      });
    },
  );

  it('does not accumulate close listeners on a kept-alive upstream socket', async () => {
    const upstream = await backend('keepalive');
    closers.push(() => upstream.close());
    const runtime = await gateway(upstream.port, upstream.port);

    const warnings: Error[] = [];
    const onWarning = (warning: Error): void => {
      warnings.push(warning);
    };
    process.on('warning', onWarning);
    try {
      // Node's global agent keeps upstream connections alive, so these all ride
      // one socket. Well past the default limit of ten: the pre-fix code added a
      // listener per request and tripped the warning on the eleventh.
      for (let attempt = 0; attempt < 15; attempt += 1) {
        expect((await get(runtime.publicPort, `/keepalive/${String(attempt)}`)).status).toBe(200);
      }
      // `process.emitWarning` defers to the next tick, so give it one.
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      process.off('warning', onWarning);
    }

    expect(warnings.map((warning) => warning.name)).not.toContain('MaxListenersExceededWarning');
    // The backend accepted exactly one connection for all fifteen requests, so
    // the assertion above cannot pass for the wrong reason — fifteen sockets
    // that never got reused would each carry a single listener and warn about
    // nothing. Cumulative accepts, not `connections.size`: that Set holds only
    // the sockets still open, and would also read 1 if fourteen had closed.
    expect(upstream.accepted()).toBe(1);
  });

  it('requires maintenance for switching and rejects non-allowlisted targets', async () => {
    const current = await backend('current');
    closers.push(() => current.close());
    const runtime = await gateway(current.port, current.port);
    expect(() =>
      runtime.switchBackend({
        host: '127.0.0.1',
        publicPort: current.port,
        internalPort: current.port,
      }),
    ).toThrow(/maintenance/);
    runtime.enterMaintenance();
    expect(() =>
      runtime.switchBackend({
        host: 'evil.example',
        publicPort: 8082,
        internalPort: 8083,
      }),
    ).toThrow(/allowlisted/);
  });

  it('serializes drain against switching, reopening, and repeated drains', async () => {
    const current = await backend('current');
    closers.push(() => current.close());
    const runtime = await gateway(current.port, current.port);
    const socket = connect(runtime.publicPort, '127.0.0.1');
    await once(socket, 'connect');
    socket.write(
      'GET /events HTTP/1.1\r\nHost: gateway\r\nConnection: Upgrade\r\nUpgrade: test\r\n\r\n',
    );
    await once(socket, 'data');
    runtime.enterMaintenance();
    const draining = runtime.drain(25);
    expect(() => runtime.leaveMaintenance()).toThrow(/while draining/);
    expect(() =>
      runtime.switchBackend({
        host: '127.0.0.1',
        publicPort: current.port,
        internalPort: current.port,
      }),
    ).toThrow(/overlap drain/);
    await expect(runtime.drain(0)).rejects.toThrow(/already in progress/);
    await draining;
    expect(() =>
      runtime.switchBackend({
        host: '127.0.0.1',
        publicPort: current.port,
        internalPort: current.port,
      }),
    ).not.toThrow();
    runtime.leaveMaintenance();
    runtime.enterMaintenance();
    await expect(runtime.drain(0)).resolves.toEqual({ forced: 0 });
  });

  it('bounds upgrade draining and force-closes connections at the deadline', async () => {
    const current = await backend('current');
    closers.push(() => current.close());
    const runtime = await gateway(current.port, current.port);
    const socket = connect(runtime.publicPort, '127.0.0.1');
    await once(socket, 'connect');
    socket.write(
      'GET /events HTTP/1.1\r\nHost: gateway\r\nConnection: Upgrade\r\nUpgrade: test\r\n\r\n',
    );
    const [upgradeResponse] = await once(socket, 'data');
    expect(String(upgradeResponse)).toContain('101 Switching Protocols');
    const clientClosed = once(socket, 'close');
    runtime.enterMaintenance();
    await expect(runtime.drain(0)).resolves.toEqual({ forced: 1 });
    await clientClosed;
    await expectConnectionsClosed(current.connections);
  });

  it('force-closes an in-flight HTTP request at the drain deadline', async () => {
    const stalled = createServer();
    const stalledSockets = new Set<import('node:net').Socket>();
    stalled.on('connection', (socket) => {
      stalledSockets.add(socket);
      socket.on('error', () => undefined);
      socket.once('close', () => stalledSockets.delete(socket));
    });
    stalled.listen(0, '127.0.0.1');
    await once(stalled, 'listening');
    const stalledPort = (stalled.address() as { port: number }).port;
    closers.push(
      () =>
        new Promise((resolve) => {
          for (const socket of stalledSockets) socket.destroy();
          stalled.close(() => resolve());
        }),
    );
    const runtime = await gateway(stalledPort, stalledPort);
    const reached = once(stalled, 'request');
    const client = request({ host: '127.0.0.1', port: runtime.publicPort, path: '/stalled' });
    const clientClosed = new Promise<void>((resolve) => {
      client.once('error', () => resolve());
      client.once('close', () => resolve());
    });
    client.end();
    await reached;
    runtime.enterMaintenance();
    await expect(runtime.drain(0)).resolves.toEqual({ forced: 1 });
    await clientClosed;
    await expectConnectionsClosed(stalledSockets);
  });

  it('force-closes concurrent pipelined requests sharing one socket', async () => {
    const stalled = createServer();
    const stalledSockets = new Set<import('node:net').Socket>();
    stalled.on('connection', (socket) => {
      stalledSockets.add(socket);
      socket.on('error', () => undefined);
      socket.once('close', () => stalledSockets.delete(socket));
    });
    stalled.listen(0, '127.0.0.1');
    await once(stalled, 'listening');
    const stalledPort = (stalled.address() as { port: number }).port;
    closers.push(
      () =>
        new Promise((resolve) => {
          for (const socket of stalledSockets) socket.destroy();
          stalled.close(() => resolve());
        }),
    );
    const runtime = await gateway(stalledPort, stalledPort);
    let requests = 0;
    const reachedBoth = new Promise<void>((resolve) => {
      stalled.on('request', () => {
        requests += 1;
        if (requests === 2) resolve();
      });
    });
    const socket = connect(runtime.publicPort, '127.0.0.1');
    await once(socket, 'connect');
    socket.write(
      'GET /first HTTP/1.1\r\nHost: gateway\r\n\r\n' +
        'GET /second HTTP/1.1\r\nHost: gateway\r\nConnection: close\r\n\r\n',
    );
    await reachedBoth;
    const clientClosed = once(socket, 'close');
    runtime.enterMaintenance();
    await expect(runtime.drain(0)).resolves.toEqual({ forced: 1 });
    await clientClosed;
    await expectConnectionsClosed(stalledSockets);
  });

  it('immediately destroys a connecting upstream instead of deferring a reset', () => {
    const destroy = vi.fn();
    const resetAndDestroy = vi.fn();
    closeManagedGatewayUpstreamSocket({
      connecting: true,
      destroyed: false,
      writable: true,
      destroy,
      resetAndDestroy,
    });
    expect(destroy).toHaveBeenCalledOnce();
    expect(resetAndDestroy).not.toHaveBeenCalled();
  });

  it('idempotently destroys an upstream that closes during drain', () => {
    const destroy = vi.fn();
    const resetAndDestroy = vi.fn(() => {
      throw new Error('reset must not run for a closed socket');
    });
    closeManagedGatewayUpstreamSocket({
      connecting: false,
      destroyed: true,
      writable: false,
      destroy,
      resetAndDestroy,
    });
    expect(destroy).toHaveBeenCalledOnce();
    expect(resetAndDestroy).not.toHaveBeenCalled();
  });

  it('routes public and internal listeners only to their fixed backend ports', async () => {
    const publicServer = await backend('public');
    const internalServer = await backend('internal');
    closers.push(
      () => publicServer.close(),
      () => internalServer.close(),
    );
    const runtime = await gateway(publicServer.port, internalServer.port);

    expect(await get(runtime.publicPort, '/projects?q=1')).toMatchObject({ status: 200 });
    expect((await get(runtime.publicPort, '/projects?q=1')).body).toContain(
      'public:GET:/projects?q=1',
    );
    expect((await get(runtime.internalPort, '/internal/sign')).body).toContain(
      'internal:GET:/internal/sign',
    );
  });

  it.each(['/internal', '/internal/sign', '/internal/sign?q=1'])(
    'rejects %s on the public listener without contacting the backend',
    async (path) => {
      const publicServer = await backend('public');
      const internalServer = await backend('internal');
      closers.push(
        () => publicServer.close(),
        () => internalServer.close(),
      );
      const runtime = await gateway(publicServer.port, internalServer.port);
      expect(await get(runtime.publicPort, path)).toEqual({ status: 404, body: '' });
    },
  );

  it('proxies WebSocket upgrades on both listeners', async () => {
    const publicServer = await backend('public');
    const internalServer = await backend('internal');
    closers.push(
      () => publicServer.close(),
      () => internalServer.close(),
    );
    const runtime = await gateway(publicServer.port, internalServer.port);
    for (const [port, path] of [
      [runtime.publicPort, '/events'],
      [runtime.internalPort, '/internal/events'],
    ] as const) {
      const socket = connect(port, '127.0.0.1');
      await once(socket, 'connect');
      socket.write(
        `GET ${path} HTTP/1.1\r\nHost: gateway\r\nConnection: Upgrade\r\nUpgrade: test\r\n\r\n`,
      );
      const [chunk] = (await once(socket, 'data')) as [Buffer];
      expect(chunk.toString()).toContain('101 Switching Protocols');
      socket.destroy();
    }
  });

  it('rejects non-allowlisted and ambiguous backend identities', async () => {
    await expect(
      startManagedGateway({
        publicPort: 0,
        internalPort: 0,
        backend: { host: 'evil.example', publicPort: 8082, internalPort: 8083 },
        allowedBackendHosts: ['verity-server'],
      }),
    ).rejects.toThrow(/allowlisted/);
    await expect(
      startManagedGateway({
        publicPort: 0,
        internalPort: 0,
        backend: { host: 'verity-server:80', publicPort: 8082, internalPort: 8083 },
        allowedBackendHosts: ['verity-server:80'],
      }),
    ).rejects.toThrow(/allowlisted/);
  });

  it('admits only canonical updater-owned generation identities when enabled', async () => {
    const runtime = await startManagedGateway({
      publicPort: 0,
      internalPort: 0,
      backend: { host: 'verity-managed-server', publicPort: 8082, internalPort: 8083 },
      allowedBackendHosts: ['verity-managed-server'],
      allowManagedServerGenerations: true,
    });
    runtime.enterMaintenance();
    expect(() =>
      runtime.switchBackend({
        host: 'verity-managed-server-g12',
        publicPort: 8082,
        internalPort: 8083,
      }),
    ).not.toThrow();
    for (const host of [
      'verity-managed-server-g0',
      'verity-managed-server-g01',
      'verity-managed-server-g1.evil',
      'verity-managed-server-g2147483648',
      'verity-managed-server-g99999999999',
      'verity-managed-standby-g1',
    ]) {
      expect(() => runtime.switchBackend({ host, publicPort: 8082, internalPort: 8083 })).toThrow(
        /allowlisted/,
      );
    }
    await runtime.close();
  });

  it('restores the last acknowledged backend after a Gateway restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'verity-managed-gateway-state-'));
    const backendStatePath = join(root, 'backend.json');
    const config = {
      publicPort: 0,
      internalPort: 0,
      backend: { host: 'verity-managed-server', publicPort: 8082, internalPort: 8083 },
      allowedBackendHosts: ['verity-managed-server'],
      allowManagedServerGenerations: true,
      backendStatePath,
    } as const;
    const first = await startManagedGateway(config);
    first.enterMaintenance();
    first.switchBackend({
      host: 'verity-managed-server-g9',
      publicPort: 8082,
      internalPort: 8083,
    });
    await first.close();
    expect(JSON.parse(await readFile(backendStatePath, 'utf8'))).toMatchObject({
      host: 'verity-managed-server-g9',
    });

    const restarted = await startManagedGateway(config);
    expect(restarted.status().backend.host).toBe('verity-managed-server-g9');
    await restarted.close();
  });

  it('returns 502 for an unavailable backend and closes idempotently', async () => {
    const runtime = await gateway(65_534, 65_533);
    expect((await get(runtime.publicPort, '/healthz')).status).toBe(502);
    await runtime.close();
    await runtime.close();
    await expect(get(runtime.publicPort, '/healthz')).rejects.toBeDefined();
  });
});
