import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { connect, type AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  PreviewConnector,
  PreviewEdge,
  generatePreviewSecret,
  hashPreviewSecret,
} from '../packages/preview-tunnel/src/index.js';
import type { ContainerSpec, DockerClient } from '../packages/server/src/docker.js';
import { PreviewShareManager } from '../packages/server/src/preview-share-manager.js';
import { projectNetworkName } from '../packages/server/src/provisioner.js';
import {
  UPLINK_CONTROL_URL,
  UplinkControlClient,
} from '../packages/server/src/uplink-control-client.js';

/**
 * The three halves of public preview sharing — the Uplink control client, the
 * share manager, and the edge/connector tunnel — are each covered well on their
 * own, and are joined nowhere but the composition root in `embedded.ts`. This
 * test drives the seam: a share created through the real control client, with
 * the real manager launching a real connector against a real edge, answered by
 * a real dev server, and fetched the way a browser fetches it.
 *
 * Only what this repository genuinely does not contain is simulated: the hosted
 * Uplink (`FakeUplink`), and its TLS/DNS ingress (`connectorDialUrl`). Every
 * value that crosses a package boundary — the scrypt PIN digest, the connector
 * token, the edge URL path, the container environment — is the one the
 * production code produced, never one the test restated.
 */

const PROJECT_ID = 'p1';
const DEV_SERVER_ID = 'dev-1';
const GENERATION = 'generation-1';
const CONNECTOR_IMAGE = `ghcr.io/heey-global/verity/preview-connector@sha256:${'a'.repeat(64)}`;
const PIN = '481625';

const cleanups: (() => Promise<void> | void)[] = [];
/** Wire-contract breaks the Uplink fixture recorded, asserted after every test:
 * scoped to one test they would pass silently in the other two, which is the
 * drift the fixture exists to catch. */
const wireFailures: string[] = [];

afterEach(async () => {
  // Not best-effort as a whole: only the edge and connector teardowns tolerate
  // failure, and they say so at registration via `alreadyClosedIsFine`. A
  // control-client shutdown that threw would otherwise be swallowed here and a
  // regression in it would surface as nothing at all.
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  const recorded = wireFailures.splice(0);
  expect(recorded, 'the Uplink fixture rejected a frame the installation sent').toEqual([]);
});

/** A share that was revoked during the test has already closed its edge and
 * connector; closing them again is expected to fail and means nothing. */
function alreadyClosedIsFine(close: () => Promise<void> | void): () => Promise<void> {
  return async () => {
    try {
      await close();
    } catch {
      /* revoked during the test */
    }
  };
}

/* -------------------------------------------------------------------------- */
/* The hosted Uplink, which is not in this repository                          */
/* -------------------------------------------------------------------------- */

/** The control socket the Uplink would be on the far end of. Frames the client
 * sends are handed to `onFrame`; frames from the service arrive via `deliver`. */
class FakeControlSocket extends EventEmitter {
  readyState: number = WebSocket.CONNECTING;
  readonly sent: Record<string, unknown>[] = [];
  ping = vi.fn();
  close = vi.fn((code?: number, reason?: string) => {
    this.readyState = WebSocket.CLOSED;
    this.emit('close', code, Buffer.from(reason ?? ''));
  });

  constructor(private readonly onFrame: (frame: Record<string, unknown>) => void) {
    super();
  }

  send(value: string, callback?: (error?: Error) => void): void {
    const frame = JSON.parse(value) as Record<string, unknown>;
    this.sent.push(frame);
    callback?.();
    this.onFrame(frame);
  }

  open(): void {
    this.readyState = WebSocket.OPEN;
    this.emit('open');
  }

  deliver(frame: unknown): void {
    this.emit('message', Buffer.from(JSON.stringify(frame)));
  }
}

interface MintedShare {
  edge: PreviewEdge;
  port: number;
  connectorToken: string;
  sessionSecret: string;
}

/**
 * Speaks the Uplink side of `docs/UPLINK_CHANNEL_PROTOCOL.md`. Each
 * `share.create` boots a real `PreviewEdge` the way the hosted deployment does:
 * from hashes only, so the raw PIN, connector token and session secret are
 * never handed to the edge process.
 */
class FakeUplink {
  readonly socket: FakeControlSocket;
  readonly shares = new Map<string, MintedShare>();
  readonly removed: string[] = [];
  readonly failures = wireFailures;
  private counter = 0;

  constructor() {
    this.socket = new FakeControlSocket((frame) => void this.handle(frame));
  }

  /**
   * A throw in here would otherwise become an unhandled rejection and the
   * awaited control request would simply never be answered, turning a wire
   * contract break into a timeout with no cause attached. Answer the request
   * with the failure instead, so it surfaces as the rejection of whatever the
   * manager was waiting on.
   */
  private async handle(frame: Record<string, unknown>): Promise<void> {
    try {
      if (frame.type === 'share.create') await this.createShare(frame);
      if (frame.type === 'share.remove') await this.removeShare(frame);
    } catch (error) {
      const code = error instanceof Error ? error.message : 'uplink fixture failed';
      this.failures.push(code);
      this.socket.deliver({
        type: frame.type === 'share.create' ? 'share.error' : 'remove.failed',
        requestId: frame.requestId,
        ...(frame.type === 'share.remove' ? { shareId: frame.shareId } : {}),
        code,
      });
    }
  }

  /** Connect, welcome, and grant the sharing entitlement. */
  async welcome(client: UplinkControlClient): Promise<void> {
    client.start();
    // The client attaches its listeners asynchronously; opening before it does
    // would drop the `open` event and hang the handshake.
    await until(() => this.socket.listenerCount('open') > 0, 'the client to attach its listeners');
    this.socket.open();
    await until(() => this.socket.sent.some((frame) => frame.type === 'hello'), 'the client hello');
    this.socket.deliver({
      type: 'welcome',
      installationId: 'installation-1',
      features: ['sharing'],
      leaseUntil: new Date(Date.now() + 600_000).toISOString(),
    });
    await until(() => client.isAvailable(), 'the sharing entitlement to take effect');
  }

  private async createShare(frame: Record<string, unknown>): Promise<void> {
    // Nothing else pins the outbound half of the wire contract. A field renamed
    // on the installation side would otherwise be read as `undefined` here and
    // quietly become a NaN expiry or the literal string "undefined".
    if (typeof frame.requestId !== 'string' || frame.requestId.length === 0) {
      throw new Error('share.create carried no requestId');
    }
    const duration = Number(frame.duration);
    if (!Number.isSafeInteger(duration) || duration <= 0) {
      throw new Error(`share.create carried no usable duration: ${String(frame.duration)}`);
    }
    if (
      typeof frame.pinHash !== 'string' ||
      !/^scrypt:[a-f0-9]{32}:[a-f0-9]{64}$/.test(frame.pinHash)
    ) {
      throw new Error(`share.create carried no Verity scrypt PIN digest: ${String(frame.pinHash)}`);
    }
    this.counter += 1;
    const shareId = `share-${this.counter}`;
    const connectorToken = generatePreviewSecret(32);
    const sessionSecret = generatePreviewSecret(32);
    const publicOrigin = `https://${shareId}.preview.example.test`;
    const expiresAt = new Date(Date.now() + duration * 1000);
    // The PIN digest is whatever the manager computed. If its scrypt encoding
    // ever drifts from what the edge accepts, the edge constructor rejects it
    // here rather than at a user's login attempt.
    const edge = new PreviewEdge({
      shareId,
      pinHash: frame.pinHash,
      connectorTokenHash: hashPreviewSecret(connectorToken),
      sessionSecretHash: hashPreviewSecret(sessionSecret),
      publicOrigin,
      expiresAt: expiresAt.toISOString(),
    });
    const port = await edge.listen();
    cleanups.push(alreadyClosedIsFine(() => edge.close()));
    this.shares.set(shareId, { edge, port, connectorToken, sessionSecret });
    this.socket.deliver({
      type: 'share.ready',
      requestId: frame.requestId,
      shareId,
      publicOrigin,
      edgeUrl: `wss://${shareId}.preview.example.test/__verity/connector`,
      connectorToken,
      sessionSecret,
      expiresAt: expiresAt.toISOString(),
    });
  }

  private async removeShare(frame: Record<string, unknown>): Promise<void> {
    const shareId = String(frame.shareId);
    this.removed.push(shareId);
    // Closed before the acknowledgement goes out, the way the hosted service
    // tears the public surface down before reporting the share removed. The
    // manager awaits that acknowledgement, so the revocation assertions cannot
    // observe a listener that is still accepting.
    await this.shares.get(shareId)?.edge.close();
    this.socket.deliver({ type: 'share.removed', requestId: frame.requestId, shareId });
  }
}

/* -------------------------------------------------------------------------- */
/* Installation side                                                          */
/* -------------------------------------------------------------------------- */

/** The share rows, with the state machine the manager actually depends on:
 * transitions are compare-and-set against the states it names. */
function memoryStore(targetPort: number) {
  const shares = new Map<string, Record<string, unknown>>();
  return {
    shares,
    getDevServer: vi.fn(async () => ({
      id: DEV_SERVER_ID,
      projectId: PROJECT_ID,
      containerPort: String(targetPort),
    })),
    getProject: vi.fn(async () => ({
      id: PROJECT_ID,
      // The connector reaches the dev server over the project network, so the
      // manager builds its target origin from this name. Pointing it at the
      // loopback address the test's dev server actually listens on keeps that
      // construction under test instead of rewriting it afterwards.
      containerName: '127.0.0.1',
      state: 'active',
    })),
    createPublicPreviewShare: vi.fn(async (input: Record<string, unknown>) => {
      const record = {
        ...input,
        state: 'creating',
        connectorContainerId: null,
        revokedAt: null,
        failure: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      shares.set(String(input.id), record);
      return record;
    }),
    transitionPublicPreviewShare: vi.fn(
      async (id: string, from: string[], state: string, patch: Record<string, unknown> = {}) => {
        const record = shares.get(id);
        if (!record || !from.includes(String(record.state))) return undefined;
        const next = { ...record, ...patch, state, updatedAt: new Date() };
        shares.set(id, next);
        return next;
      },
    ),
    getPublicPreviewShare: vi.fn(async (id: string) => shares.get(id)),
    listPublicPreviewShares: vi.fn(async () => [...shares.values()]),
    getVeritySettings: vi.fn(async () => ({
      uplinkSubscriptionKey: 'subscription-fixture',
      uplinkInstallationId: null,
    })),
    updateVeritySettings: vi.fn(async (patch: Record<string, unknown>) => patch),
    addPendingUplinkShareRemoval: vi.fn(async () => undefined),
    listPendingUplinkShareRemovals: vi.fn(async () => [] as string[]),
    deletePendingUplinkShareRemoval: vi.fn(async () => undefined),
  };
}

/** The sandbox as the manager's hardening check demands to find it. */
function sandboxInspect() {
  return {
    id: 'sandbox-id',
    running: true,
    labels: { 'verity.container-generation': GENERATION },
    networks: { [projectNetworkName(PROJECT_ID)]: {} },
    env: [] as string[],
    mountCount: 0,
    mounts: [],
    privileged: false,
    deviceCount: 0,
    capAdd: [],
    capDrop: ['ALL'],
    securityOpt: ['no-new-privileges:true'],
    readOnlyRootfs: true,
    runtime: 'runsc',
    user: 'dev',
  };
}

function envOf(spec: ContainerSpec): Record<string, string> {
  return Object.fromEntries(
    (spec.env ?? []).map((entry) => {
      const split = entry.indexOf('=');
      // Without this an entry carrying no `=` would yield a truncated key and
      // the whole string as its value, quietly satisfying the lookups below.
      if (split <= 0) throw new Error(`malformed container env entry: ${entry}`);
      return [entry.slice(0, split), entry.slice(split + 1)];
    }),
  );
}

/**
 * The one substitution on the data path. In production the connector dials the
 * public hostname and a TLS ingress in front of the edge terminates it; neither
 * the certificate nor the DNS record is in this repository. Scheme and authority
 * are swapped for the edge's loopback listener, and nothing else — the path the
 * manager generated is what gets dialled.
 */
function connectorDialUrl(edgeUrl: string, edgePort: number): string {
  const url = new URL(edgeUrl);
  // Asserted from the captured spec in the environment test rather than here:
  // a failure raised inside the docker stub runs inside `manager.create`, which
  // would rewrite it into an opaque share-setup failure.
  if (url.protocol !== 'wss:') throw new Error(`edge URL is not WSS: ${edgeUrl}`);
  return `ws://127.0.0.1:${edgePort}${url.pathname}`;
}

/** Docker, except `startContainer` really starts the connector the manager
 * asked for, built from the environment the manager put in the spec. */
function dockerWithRealConnectors(uplink: FakeUplink) {
  const specs: ContainerSpec[] = [];
  const connectors = new Map<string, PreviewConnector>();
  const established = new Set<string>();
  const docker = {
    inspectContainer: vi.fn(async (id: string) =>
      connectors.has(id) ? { ...sandboxInspect(), id } : sandboxInspect(),
    ),
    createContainer: vi.fn(async (spec: ContainerSpec) => {
      specs.push(spec);
      return { id: `connector-${spec.name}`, warnings: [] as string[] };
    }),
    startContainer: vi.fn(async (id: string) => {
      const spec = specs.find((candidate) => `connector-${candidate.name}` === id);
      if (!spec) throw new Error(`no spec for ${id}`);
      const env = envOf(spec);
      const shareId = spec.labels?.['verity.public-preview-share'];
      const minted = [...uplink.shares.entries()].find(
        ([, share]) => share.connectorToken === env.VERITY_PREVIEW_CONNECTOR_TOKEN,
      );
      if (!minted) {
        // Recorded as well as thrown: the manager rewrites anything this stub
        // throws into a generic share-setup failure, so a token that stopped
        // matching would otherwise be indistinguishable from Docker being down.
        const failure = `connector token does not match any minted share (${shareId})`;
        uplink.failures.push(failure);
        throw new Error(failure);
      }
      const connector = new PreviewConnector({
        edgeUrl: connectorDialUrl(env.VERITY_PREVIEW_EDGE_URL!, minted[1].port),
        connectorToken: env.VERITY_PREVIEW_CONNECTOR_TOKEN!,
        targetOrigin: env.VERITY_PREVIEW_TARGET_ORIGIN!,
      });
      await connector.connect();
      connectors.set(id, connector);
      established.add(id);
      cleanups.push(alreadyClosedIsFine(() => connector.close()));
    }),
    removeContainer: vi.fn(async (id: string) => {
      // `PreviewConnector.close()` is synchronous, so the socket is down by the
      // time this resolves and the revocation assertions cannot race it.
      connectors.get(id)?.close();
      connectors.delete(id);
      established.delete(id);
    }),
    // The manager waits for this marker before it calls a share active, so the
    // readiness handshake is decided by whether the connector really attached.
    containerLogs: vi.fn(async (id: string) =>
      established.has(id) ? 'preview connector established\n' : '',
    ),
  };
  return { docker, specs, connectors };
}

async function startDevServer(body: string): Promise<{ port: number }> {
  const server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end(`${body} ${request.url}`);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { port: (server.address() as AddressInfo).port };
}

/** Counts connection attempts and registers the single-dial expectation. */
function dials(factory: () => WebSocket): () => WebSocket {
  let count = 0;
  cleanups.push(() => {
    expect(count, 'the control client re-dialled a socket that cannot be re-opened').toBe(1);
  });
  return () => {
    count += 1;
    return factory();
  };
}

async function harness() {
  const devServer = await startDevServer('dev server says hello');
  const uplink = new FakeUplink();
  const store = memoryStore(devServer.port);
  const control = new UplinkControlClient({
    url: UPLINK_CONTROL_URL,
    store,
    serverVersion: 'e2e',
    // One socket for the whole test: these scenarios never re-dial, and the fake
    // could not serve a second connection anyway once its readyState is CLOSED.
    // Asserted at teardown rather than assumed, so a client that grew a reconnect
    // on any of these paths fails here instead of double-handling every frame.
    webSocketFactory: dials(() => uplink.socket as unknown as WebSocket),
  });
  cleanups.push(() => control.stop());
  await uplink.welcome(control);
  const { docker, specs, connectors } = dockerWithRealConnectors(uplink);
  const manager = new PreviewShareManager({
    store,
    docker: docker as unknown as DockerClient,
    edge: control,
    resolveConnectorImage: async () => CONNECTOR_IMAGE,
    isDevServerRunning: async () => true,
    connectorReadyPollMs: 25,
    // Comfortably below the per-test timeout, so a connector that never attaches
    // fails with the manager's own readiness error instead of as a test timeout.
    connectorReadyTimeoutMs: 2_000,
  });
  return { devServer, uplink, store, control, manager, docker, specs, connectors };
}

/** Waits for a condition the client itself reports, rather than for a fixed
 * number of ticks: a handshake that grows a timer or a deeper promise chain
 * would otherwise turn these tests into silent flakes instead of failures. */
async function until(condition: () => boolean, what: string, deadlineMs = 5_000): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Opens a bare TCP connection, so "the edge is gone" is judged on the listener
 * rather than on whatever error an HTTP client happens to raise. */
async function connectTo(port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = connect({ port, host: '127.0.0.1' });
    socket.once('connect', () => {
      socket.destroy();
      resolve();
    });
    socket.once('error', reject);
  });
}

/** Logs in the way the browser does: form-encoded PIN, redirect not followed,
 * so the caller can judge the status and read the session cookie off it. */
async function login(port: number, pin: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/__verity/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ pin, next: '/' }),
  });
}

/* -------------------------------------------------------------------------- */

describe('public preview sharing, composed end to end', () => {
  it(
    'serves a dev server through the Uplink binding and stops serving once revoked',
    { timeout: 20_000 },
    async () => {
      const { uplink, manager, specs, store } = await harness();

      const share = await manager.create({
        devServerId: DEV_SERVER_ID,
        pin: PIN,
        ttlSeconds: 3600,
      });

      expect(share.state).toBe('active');
      const minted = uplink.shares.get(share.id);
      expect(minted).toBeDefined();
      expect(share.publicOrigin).toBe(`https://${share.id}.preview.example.test`);

      // The PIN the user chose, verified against the digest the manager derived,
      // by the edge's own verifier. Nothing in this path was restated by the test.
      const denied = await login(minted!.port, '000000');
      expect(denied.status).toBe(401);
      const accepted = await login(minted!.port, PIN);
      expect(accepted.status).toBe(303);
      // Read rather than asserted away: an edge that stopped setting the cookie
      // would otherwise fail below as a TypeError on null.
      const setCookie = accepted.headers.get('set-cookie');
      expect(setCookie, 'the edge issued no session cookie').toBeTruthy();
      const cookie = setCookie!.split(';')[0]!;

      // The whole point of the share is that the PIN gate stands in front of the
      // dev server. A proxy that forwarded unauthenticated requests would still
      // satisfy every assertion below, and would publish the dev server to anyone
      // holding the URL.
      const anonymous = await fetch(`http://127.0.0.1:${minted!.port}/hello`, {
        redirect: 'manual',
      });
      // Pinned to the redirect rather than "not 200": an edge that errored out
      // on every request would otherwise read as a working gate.
      expect(anonymous.status).toBe(303);
      expect(anonymous.headers.get('location')).toBe('/__verity/login?next=%2Fhello');
      expect(await anonymous.text()).not.toContain('dev server says hello');

      const page = await fetch(`http://127.0.0.1:${minted!.port}/hello`, { headers: { cookie } });
      expect(page.status).toBe(200);
      expect(await page.text()).toBe('dev server says hello /hello');

      // Revocation has to reach the Uplink and take the public surface down, not
      // merely mark the row.
      await expect(manager.stop(share.id)).resolves.toBe(true);
      expect(uplink.removed).toEqual([share.id]);
      expect(store.shares.get(share.id)?.state).toBe('revoked');
      // Refused at the socket, not merely "some error": a typo in the URL would
      // otherwise pass for a public surface that is gone.
      await expect(connectTo(minted!.port)).rejects.toMatchObject({ code: 'ECONNREFUSED' });
      expect(specs).toHaveLength(1);
    },
  );

  it(
    'gives the connector exactly the environment its entrypoint requires',
    { timeout: 20_000 },
    async () => {
      const { manager, specs, devServer } = await harness();
      const share = await manager.create({
        devServerId: DEV_SERVER_ID,
        pin: PIN,
        ttlSeconds: 3600,
      });

      // Derived from the entrypoint rather than listed here: a variable renamed on
      // one side only would leave the connector container crash-looping in
      // production while every unit test stayed green.
      // Read from source, which is where Vitest runs this suite from; it is not
      // collected from a build output.
      const entrypoint = await readFile(
        fileURLToPath(new URL('../packages/preview-tunnel/src/connector-main.ts', import.meta.url)),
        'utf8',
      );
      const required = [...entrypoint.matchAll(/required\('(VERITY_PREVIEW_[A-Z_]+)'\)/g)].map(
        (match) => match[1]!,
      );
      // Without this, a reworded entrypoint would yield an empty list, the loop
      // below would never run, and the check would pass by doing nothing.
      expect(required).toContain('VERITY_PREVIEW_EDGE_URL');
      expect(required).toContain('VERITY_PREVIEW_CONNECTOR_TOKEN');
      const env = envOf(specs[0]!);
      // `VERITY_PREVIEW_STATIC_PATH` sits behind the entrypoint's static-root
      // branch (connector-main.ts: it is only read when VERITY_PREVIEW_STATIC_ROOT
      // is set). A dev-server share leaves that branch dead, so the exemption
      // holds only as long as the manager sets no static root — assert that
      // rather than trusting it, or this loop would quietly stop covering a
      // variable that had become mandatory.
      expect(env.VERITY_PREVIEW_STATIC_ROOT).toBeUndefined();
      const staticOnly = new Set(['VERITY_PREVIEW_STATIC_PATH']);
      for (const name of required) {
        if (staticOnly.has(name)) continue;
        expect(env[name], `${name} is required by connector-main.ts`).toBeTruthy();
      }

      expect(env.VERITY_PREVIEW_TARGET_ORIGIN).toBe(`http://127.0.0.1:${devServer.port}`);
      const edgeUrl = new URL(env.VERITY_PREVIEW_EDGE_URL!);
      expect(edgeUrl.protocol).toBe('wss:');
      expect(edgeUrl.pathname).toBe('/__verity/connector');
      expect(share.state).toBe('active');
    },
  );

  it(
    'refuses to create a share once the Uplink withdraws the sharing entitlement',
    { timeout: 20_000 },
    async () => {
      const { uplink, manager, control } = await harness();

      uplink.socket.deliver({ type: 'revoke', reason: 'expired' });
      await until(() => !control.isAvailable(), 'the entitlement to be withdrawn');

      expect(control.isAvailable()).toBe(false);
      // Pinned rather than matched loosely: the manager has to refuse on the
      // withdrawn entitlement, which is a different state from a dropped socket.
      await expect(
        manager.create({ devServerId: DEV_SERVER_ID, pin: PIN, ttlSeconds: 3600 }),
      ).rejects.toThrow('public previews are not entitled or the Uplink is offline');
      expect(uplink.shares.size).toBe(0);
    },
  );
});
