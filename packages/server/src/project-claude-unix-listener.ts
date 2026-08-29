import { chmodSync, chownSync, lstatSync, mkdirSync, unlinkSync } from 'node:fs';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { join } from 'node:path';

import {
  projectSocketBindingName,
  unlinkOwnedUnixSocket,
  type InternalConnectionIdentity,
} from './internal-listener.js';

export interface ProjectClaudeUnixListener {
  readonly socketPath: string;
  readonly identity: InternalConnectionIdentity;
  close(): Promise<void>;
}

export interface ProjectClaudeUnixListenerOptions {
  socketRoot: string;
  identity: InternalConnectionIdentity;
  ownerUid: number;
  relayGid: number;
  /** Fixed control-plane mTLS gateway target; never derived from relay traffic. */
  gatewayHost: string;
  gatewayPort: number;
  /** Protocol-neutral socket filename. Defaults to the legacy Claude name. */
  socketName?: 'claude.sock' | 'codex.sock';
  serviceName?: 'Claude' | 'Codex';
  maxConnections?: number | undefined;
  idleTimeoutMs?: number | undefined;
  staleProbeTimeoutMs?: number | undefined;
  onRuntimeError?: ((error: Error) => void) | undefined;
  /** Dependency-injection seam for transport-level tests. */
  serverFactory?: ((listener: (socket: Socket) => void) => Server) | undefined;
  /** Dependency-injection seam for a gateway connection that has not opened yet. */
  upstreamFactory?: (() => Socket) | undefined;
}

/**
 * Bind one project-generation UDS and byte-forward it to the fixed Claude mTLS
 * gateway. TLS remains end-to-end between the sandbox identity and Verity; this
 * listener never parses, terminates, or selects an upstream from caller bytes.
 */
export async function startProjectClaudeUnixListener(
  options: ProjectClaudeUnixListenerOptions,
): Promise<ProjectClaudeUnixListener> {
  validateOptions(options);
  const maxConnections = options.maxConnections ?? 8;
  const idleTimeoutMs = options.idleTimeoutMs ?? 15_000;
  const bindingDirectory = join(options.socketRoot, projectSocketBindingName(options.identity));
  ensureBindingDirectory(bindingDirectory, options.ownerUid, options.relayGid);
  const socketPath = join(bindingDirectory, options.socketName ?? 'claude.sock');
  await reconcileSocketPath(socketPath, options.staleProbeTimeoutMs ?? 250);

  const connections = new Set<Socket>();
  const downstreams = new Set<Socket>();
  const acceptDownstream = (downstream: Socket): void => {
    if (downstreams.size >= maxConnections) {
      downstream.destroy();
      return;
    }
    downstreams.add(downstream);
    downstream.once('close', () => downstreams.delete(downstream));
    track(connections, downstream);
    const upstream =
      options.upstreamFactory?.() ??
      createConnection({
        host: options.gatewayHost,
        port: options.gatewayPort,
        allowHalfOpen: true,
      });
    track(connections, upstream);
    const destroyPair = (): void => {
      downstream.destroy();
      upstream.destroy();
    };
    // The idle timeout guards the OPENING of a connection, not its life. This
    // listener forwards bytes without parsing them, so it cannot tell a dead peer
    // from a model that is simply thinking — and an LLM stream is silent for long
    // stretches by nature: a slow first token, a large context being read, a tool
    // call being computed upstream. Killing the pair on that silence surfaced as
    // "502 upstream unavailable" when it hit before the first byte and
    // "connection closed mid-response" when it hit during the stream, with the
    // gateway recording `sandbox-closed` at exactly 15003 ms.
    //
    // Once a byte arrives from the gateway, the upstream path has proven itself:
    // the timer comes off and the stream may go quiet for as long as it needs. The
    // forwarded protocol is end-to-end TLS, so this evidence arrives during the
    // TLS handshake, before any slow model response. Neither a downstream
    // ClientHello nor a raw TCP accept is sufficient on its own: a silent gateway
    // must not occupy a connection slot forever.
    const openingDeadline = setTimeout(destroyPair, idleTimeoutMs);
    openingDeadline.unref();
    downstream.once('close', () => {
      clearTimeout(openingDeadline);
      upstream.destroy();
    });
    upstream.once('close', () => clearTimeout(openingDeadline));
    downstream.once('error', () => upstream.destroy());
    upstream.once('error', () => downstream.destroy());
    downstream.pipe(upstream, { end: false });
    upstream.pipe(downstream, { end: false });
    // Attach traffic observation after both pipes. A `data` listener switches a
    // socket into flowing mode, so attaching it earlier could drop the first bytes.
    // There is deliberately no post-handshake inactivity deadline: this byte-only
    // listener cannot distinguish a stuck peer from a valid model/tool pause. The
    // relay socket is project-scoped and maxConnections bounds exposure to that
    // project; reintroducing an inactivity timer here would recreate the truncation
    // this listener exists to avoid.
    upstream.once('data', () => clearTimeout(openingDeadline));
    downstream.once('end', () => {
      if (upstream.connecting) upstream.once('connect', () => upstream.end());
      else upstream.end();
    });
    upstream.once('end', () => downstream.end());
  };
  const server =
    options.serverFactory?.(acceptDownstream) ??
    createServer({ allowHalfOpen: true }, acceptDownstream);
  server.maxConnections = maxConnections + 1;
  server.on('error', (error) => {
    destroyAll(connections);
    if (server.listening) server.close();
    try {
      options.onRuntimeError?.(error);
    } catch {
      // A diagnostic callback must never turn a contained listener failure
      // into an uncaught control-plane exception.
    }
  });
  await listenUnix(server, socketPath);
  try {
    chownSync(socketPath, options.ownerUid, options.relayGid);
    chmodSync(socketPath, 0o660);
  } catch (error) {
    destroyAll(connections);
    await closeServer(server);
    throw error;
  }
  const boundSocket = lstatSync(socketPath);

  return {
    socketPath,
    identity: options.identity,
    async close(): Promise<void> {
      destroyAll(connections);
      await closeServer(server);
      unlinkOwnedUnixSocket(socketPath, boundSocket);
    },
  };
}

function validateOptions(options: ProjectClaudeUnixListenerOptions): void {
  const service = options.serviceName ?? 'Claude';
  if (
    options.identity.projectId.trim() === '' ||
    options.identity.containerGeneration.trim() === ''
  )
    throw new Error(`project ${service} Unix listener requires project and generation identity`);
  if (options.gatewayHost.trim() === '')
    throw new Error(`project ${service} Unix listener requires a fixed gateway host`);
  if (
    !Number.isSafeInteger(options.gatewayPort) ||
    options.gatewayPort < 1 ||
    options.gatewayPort > 65_535
  )
    throw new Error(`project ${service} Unix listener requires a valid gateway port`);
  if (
    !Number.isSafeInteger(options.ownerUid) ||
    options.ownerUid < 0 ||
    !Number.isSafeInteger(options.relayGid) ||
    options.relayGid < 0
  )
    throw new Error(`project ${service} Unix listener requires valid uid and gid`);
  for (const [name, value] of [
    ['maxConnections', options.maxConnections ?? 8],
    ['idleTimeoutMs', options.idleTimeoutMs ?? 15_000],
    ['staleProbeTimeoutMs', options.staleProbeTimeoutMs ?? 250],
  ] as const) {
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new Error(`project ${service} Unix listener requires valid ${name}`);
  }
  const root = lstatSync(options.socketRoot);
  if (
    !root.isDirectory() ||
    root.isSymbolicLink() ||
    root.uid !== options.ownerUid ||
    (root.mode & 0o022) !== 0
  )
    throw new Error(`project ${service} Unix listener requires a trusted socket root`);
}

function ensureBindingDirectory(path: string, ownerUid: number, relayGid: number): void {
  let created = false;
  try {
    mkdirSync(path, { mode: 0o710 });
    created = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  if (created) {
    chownSync(path, ownerUid, relayGid);
    chmodSync(path, 0o710);
    return;
  }
  const stat = lstatSync(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== ownerUid ||
    stat.gid !== relayGid ||
    (stat.mode & 0o777) !== 0o710
  )
    throw new Error('project Claude Unix listener refuses an untrusted binding directory');
}

async function reconcileSocketPath(path: string, timeoutMs: number): Promise<void> {
  try {
    const stat = lstatSync(path);
    if (!stat.isSocket() || stat.isSymbolicLink())
      throw new Error('project Claude Unix listener refuses a non-socket path');
    if (await socketAcceptsConnections(path, timeoutMs))
      throw new Error('project Claude Unix listener socket is already active');
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function socketAcceptsConnections(path: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ path });
    const timeout = setTimeout(() => {
      socket.destroy();
      // An indeterminate probe is treated as active; never unlink under it.
      resolve(true);
    }, timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timeout);
      socket.destroy();
      resolve(true);
    });
    socket.once('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timeout);
      socket.destroy();
      if (error.code === 'ECONNREFUSED' || error.code === 'ENOENT') resolve(false);
      else reject(error);
    });
  });
}

function track(connections: Set<Socket>, socket: Socket): void {
  connections.add(socket);
  socket.once('close', () => connections.delete(socket));
}

function destroyAll(connections: Set<Socket>): void {
  for (const socket of connections) socket.destroy();
  connections.clear();
}

function listenUnix(server: Server, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
