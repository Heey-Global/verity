import { createConnection } from 'node:net';
import { mkdtemp, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  drainManagedGateway,
  enterManagedGatewayMaintenance,
  leaveManagedGatewayMaintenance,
  readManagedGatewayStatus,
  startManagedGatewayControlServer,
  switchManagedGatewayBackend,
  waitForManagedGatewayStatus,
  type ManagedGatewayControlServer,
  type ManagedGatewayControlTarget,
} from './managed-gateway-control.js';
import type { ManagedGatewayBackend, ManagedGatewayStatus } from './managed-gateway.js';

const servers: ManagedGatewayControlServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

/**
 * Stand-in for the routing runtime. It enforces the same preconditions the real
 * gateway does, because what this channel has to get right is relaying them —
 * not re-implementing them.
 */
function fakeGateway(): ManagedGatewayControlTarget & {
  drains: number[];
  /** Hosts routed at the start and at the end of each drain. */
  observedDuringDrain: string[];
  /** Set while a drain is parked; call it to let that drain finish. */
  releaseDrain: (() => void) | undefined;
  gateDrain: boolean;
} {
  let maintenance = false;
  let draining = false;
  let backend: ManagedGatewayBackend = {
    host: 'verity-managed-server',
    publicPort: 8082,
    internalPort: 8083,
  };
  const drains: number[] = [];
  const self = {
    drains,
    observedDuringDrain: [] as string[],
    releaseDrain: undefined as (() => void) | undefined,
    gateDrain: false,
    status: (): ManagedGatewayStatus => ({
      maintenance,
      draining,
      backend: { ...backend },
      activeRequests: 0,
      upgradedConnections: 0,
    }),
    enterMaintenance: () => {
      maintenance = true;
    },
    leaveMaintenance: () => {
      maintenance = false;
    },
    switchBackend: (next: ManagedGatewayBackend) => {
      if (!maintenance) throw new Error('managed gateway backend switch requires maintenance');
      if (next.host !== 'verity-managed-server' && next.host !== 'verity-managed-standby')
        throw new Error(`managed gateway backend host is not allowed: ${next.host}`);
      backend = { ...next };
    },
    drain: async (timeoutMs: number) => {
      drains.push(timeoutMs);
      draining = true;
      self.observedDuringDrain.push(backend.host);
      if (self.gateDrain)
        await new Promise<void>((resolve) => {
          self.releaseDrain = resolve;
        });
      else await new Promise((resolve) => setTimeout(resolve, 1));
      self.observedDuringDrain.push(backend.host);
      draining = false;
      return { forced: 2 };
    },
  };
  return self;
}

async function fixture(requestTimeoutMs?: number): Promise<{
  socketPath: string;
  gateway: ReturnType<typeof fakeGateway>;
}> {
  const root = await mkdtemp(join(tmpdir(), 'verity-managed-gateway-control-'));
  const socketPath = join(root, 'control', 'control.sock');
  const gateway = fakeGateway();
  servers.push(
    await startManagedGatewayControlServer(
      requestTimeoutMs === undefined
        ? { socketPath, gateway }
        : { socketPath, gateway, requestTimeoutMs },
    ),
  );
  return { socketPath, gateway };
}

/** Send a raw frame, bypassing the typed client, and read the reply. */
function rawExchange(socketPath: string, frame: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffered = '';
    socket.once('connect', () => socket.write(`${frame}\n`));
    socket.on('data', (chunk: Buffer) => {
      buffered += chunk.toString('utf8');
      const newline = buffered.indexOf('\n');
      if (newline < 0) return;
      socket.destroy();
      try {
        resolve(JSON.parse(buffered.slice(0, newline)) as unknown);
      } catch {
        reject(new Error('control channel replied with a frame that is not JSON'));
      }
    });
    socket.once('error', reject);
  });
}

describe('managed gateway control channel', () => {
  it('waits for a Gateway that has not bound its socket yet', async () => {
    const root = await mkdtemp(join(tmpdir(), 'verity-managed-gateway-control-'));
    const socketPath = join(root, 'control', 'control.sock');
    const gateway = fakeGateway();
    const started = new Promise<void>((resolve, reject) => {
      setTimeout(() => {
        startManagedGatewayControlServer({ socketPath, gateway }).then((server) => {
          servers.push(server);
          resolve();
        }, reject);
      }, 25);
    });

    await expect(
      waitForManagedGatewayStatus(socketPath, { timeoutMs: 1_000 }),
    ).resolves.toMatchObject({ maintenance: false });
    await started;
  });

  it('stops waiting when the control socket bind timeout expires', async () => {
    const root = await mkdtemp(join(tmpdir(), 'verity-managed-gateway-control-'));
    const socketPath = join(root, 'missing.sock');
    let time = 0;

    await expect(
      waitForManagedGatewayStatus(socketPath, {
        timeoutMs: 500,
        now: () => time,
        sleep: async (ms) => {
          time += ms;
        },
      }),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect(time).toBe(500);
  });

  it('does not retry a Gateway that answers with a refusal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'verity-managed-gateway-control-'));
    const socketPath = join(root, 'control.sock');
    const gateway = fakeGateway();
    gateway.status = () => {
      throw new Error('gateway is broken');
    };
    servers.push(await startManagedGatewayControlServer({ socketPath, gateway }));
    let sleeps = 0;
    await expect(
      waitForManagedGatewayStatus(socketPath, {
        sleep: async () => {
          sleeps += 1;
        },
      }),
    ).rejects.toThrow('Managed gateway refused the request: gateway is broken');
    expect(sleeps).toBe(0);
  });

  it('keeps the socket and its directory private to the gateway', async () => {
    const { socketPath } = await fixture();
    expect((await stat(socketPath)).mode & 0o777).toBe(0o600);
    expect((await stat(join(socketPath, '..'))).mode & 0o777).toBe(0o700);
  });

  it('drives maintenance, backend selection, and drain in sequence', async () => {
    const { socketPath, gateway } = await fixture();
    await expect(readManagedGatewayStatus(socketPath)).resolves.toMatchObject({
      maintenance: false,
      backend: { host: 'verity-managed-server', publicPort: 8082, internalPort: 8083 },
    });

    await expect(enterManagedGatewayMaintenance(socketPath)).resolves.toMatchObject({
      maintenance: true,
    });
    await expect(drainManagedGateway(socketPath, 5_000)).resolves.toMatchObject({
      forced: 2,
      status: { draining: false },
    });
    expect(gateway.drains).toEqual([5_000]);

    await expect(
      switchManagedGatewayBackend(socketPath, {
        host: 'verity-managed-standby',
        publicPort: 8082,
        internalPort: 8083,
      }),
    ).resolves.toMatchObject({ backend: { host: 'verity-managed-standby' } });
    await expect(leaveManagedGatewayMaintenance(socketPath)).resolves.toMatchObject({
      maintenance: false,
      backend: { host: 'verity-managed-standby' },
    });
  });

  it('reports the gateway’s own refusal instead of a generic failure', async () => {
    const { socketPath } = await fixture();
    // Switching without maintenance is refused by the runtime, and the reason is
    // what makes a stalled promotion diagnosable from the Updater side.
    await expect(
      switchManagedGatewayBackend(socketPath, {
        host: 'verity-managed-standby',
        publicPort: 8082,
        internalPort: 8083,
      }),
    ).rejects.toThrow('managed gateway backend switch requires maintenance');

    await enterManagedGatewayMaintenance(socketPath);
    await expect(
      switchManagedGatewayBackend(socketPath, {
        host: 'evil.example.com',
        publicPort: 8082,
        internalPort: 8083,
      }),
    ).rejects.toThrow('backend host is not allowed: evil.example.com');
  });

  it('refuses a malformed request without touching the gateway', async () => {
    const { socketPath, gateway } = await fixture();
    // The gateway is left out of maintenance on purpose: it refuses a backend
    // switch in that state too, so asserting only `ok: false` would pass even
    // for a frame the protocol layer wrongly let through. Each case therefore
    // names the rejection it must produce.
    for (const [frame, error] of [
      ['{"type":"promote"}', 'invalid control request'],
      ['{"type":"switch-backend"}', 'invalid backend selection'],
      [
        '{"type":"switch-backend","backend":{"host":"","publicPort":1,"internalPort":2}}',
        'invalid backend selection',
      ],
      [
        '{"type":"switch-backend","backend":{"host":"h","publicPort":70000,"internalPort":2}}',
        'invalid backend selection',
      ],
      // Port 0 means "pick one" to a listener and nothing at all to a client.
      [
        '{"type":"switch-backend","backend":{"host":"h","publicPort":0,"internalPort":2}}',
        'invalid backend selection',
      ],
      [
        '{"type":"switch-backend","backend":{"host":"h","publicPort":1,"internalPort":0}}',
        'invalid backend selection',
      ],
      ['{"type":"drain","timeoutMs":-1}', 'invalid drain timeout'],
      ['{"type":"drain","timeoutMs":"soon"}', 'invalid drain timeout'],
      ['not json', 'control frame is not JSON'],
    ] as const) {
      await expect(rawExchange(socketPath, frame)).resolves.toEqual({ ok: false, error });
    }
    expect(gateway.drains).toEqual([]);
    expect(gateway.status()).toMatchObject({ maintenance: false });
  });

  it('caps a drain so one request cannot wedge the serialized channel', async () => {
    const { socketPath, gateway } = await fixture();
    await enterManagedGatewayMaintenance(socketPath);
    await expect(drainManagedGateway(socketPath, 600_000)).rejects.toThrow(
      'drain timeout exceeds the maximum',
    );
    expect(gateway.drains).toEqual([]);
  });

  it('holds the connection open for a drain that outlasts the read deadline', async () => {
    // The read deadline bounds how long a client may take to send its request.
    // A drain is silent for as long as it runs, so an inactivity timeout left
    // armed past the request would tear down the connection and throw away the
    // verdict — with a cap of five minutes on a drain, that is the common case,
    // not an edge one.
    const { socketPath, gateway } = await fixture(50);
    await enterManagedGatewayMaintenance(socketPath);
    gateway.gateDrain = true;
    const drained = drainManagedGateway(socketPath, 5_000);
    while (gateway.releaseDrain === undefined)
      await new Promise((resolve) => setTimeout(resolve, 5));
    await new Promise((resolve) => setTimeout(resolve, 150));
    gateway.releaseDrain();
    await expect(drained).resolves.toMatchObject({ forced: 2 });
  });

  it('serializes overlapping requests so a stale instruction cannot land last', async () => {
    const { socketPath, gateway } = await fixture();
    await enterManagedGatewayMaintenance(socketPath);
    gateway.gateDrain = true;
    const drained = drainManagedGateway(socketPath, 5_000);
    while (gateway.releaseDrain === undefined)
      await new Promise((resolve) => setTimeout(resolve, 5));

    // The switch arrives while the drain is parked. Serialization is the whole
    // point: a backend that changed mid-drain would mean the gateway kept
    // emptying connections against one generation while already routing to
    // another, and the drain's own verdict would describe neither.
    const switched = switchManagedGatewayBackend(socketPath, {
      host: 'verity-managed-standby',
      publicPort: 8082,
      internalPort: 8083,
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(gateway.status().backend.host).toBe('verity-managed-server');

    gateway.releaseDrain();
    expect((await drained).forced).toBe(2);
    expect(gateway.observedDuringDrain).toEqual(['verity-managed-server', 'verity-managed-server']);
    expect((await switched).backend.host).toBe('verity-managed-standby');
  });

  it('refuses to displace a control socket another gateway still answers', async () => {
    const { socketPath, gateway } = await fixture();
    await expect(startManagedGatewayControlServer({ socketPath, gateway })).rejects.toThrow(
      'socket is already active',
    );
    // The live channel is untouched by the refused start.
    await expect(readManagedGatewayStatus(socketPath)).resolves.toMatchObject({
      maintenance: false,
    });
  });

  it('refuses to bind over a path that is not a socket', async () => {
    const root = await mkdtemp(join(tmpdir(), 'verity-managed-gateway-control-'));
    const socketPath = join(root, 'control.sock');
    await writeFile(socketPath, 'not a socket');
    await expect(
      startManagedGatewayControlServer({ socketPath, gateway: fakeGateway() }),
    ).rejects.toThrow('path exists and is not a socket');
  });
});
