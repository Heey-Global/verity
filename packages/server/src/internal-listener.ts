import { createHash } from 'node:crypto';
import { chmodSync, chownSync, lstatSync, mkdirSync, unlinkSync, type Stats } from 'node:fs';
import { createServer, type Server as HttpServer } from 'node:http';
import { createConnection, type Socket } from 'node:net';
import { join } from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';

/**
 * Network-level isolation for the `/internal/*` control-plane routes (audit H1
 * follow-up). The commit-signing broker (`POST /internal/git/sign`) is protected
 * by a broker token, but it rode the SAME Fastify listener as the operator API —
 * so on a LAN-published deployment it was technically answerable from the LAN
 * (token-gated, but reachable). This module lets Verity serve `/internal/*` on a
 * SECOND, non-published HTTP listener that shares the Fastify request handler:
 * the public API port then 404s `/internal/*` (see `internalPathGuard` in
 * server.ts), and the broker is reachable only container-to-container over the
 * internal Docker network. Opt-in via `VERITY_INTERNAL_PORT`.
 */

// Marker stamped on every socket the internal listener accepts, so the origin
// guard can tell an internal connection from one that landed on the public API
// port. Symbol-keyed: it can't be forged from a header/query or collide with any
// real socket property — the only way to get it set is to connect to the internal
// listener, which is not published to the host.
const INTERNAL_SOCKET = Symbol('verityInternalSocket');

export interface InternalConnectionIdentity {
  readonly projectId: string;
  readonly containerGeneration: string;
}

type InternalSocketTag = true | InternalConnectionIdentity;
type Taggable = Record<symbol, InternalSocketTag>;

/** Tag every socket this HTTP server accepts as internal. */
export function markInternalConnections(
  server: HttpServer,
  identity: InternalConnectionIdentity | undefined = undefined,
): void {
  server.on('connection', (socket) => {
    (socket as unknown as Taggable)[INTERNAL_SOCKET] = identity ?? true;
  });
}

/**
 * True iff `request` arrived on a socket accepted by the internal listener. Wired
 * as buildServer's `internalPathGuard` so `/internal/*` is reachable ONLY over the
 * internal (non-published) port, never the public/LAN-published API listener.
 */
export function requestArrivedInternally(request: FastifyRequest): boolean {
  return (request.raw.socket as unknown as Taggable)[INTERNAL_SOCKET] !== undefined;
}

/** Trusted project identity bound by a project-specific Unix listener. Headers,
 * query parameters and request bodies cannot set or override this value. */
export function internalConnectionIdentity(
  request: FastifyRequest,
): InternalConnectionIdentity | undefined {
  const tag = (request.raw.socket as unknown as Taggable)[INTERNAL_SOCKET];
  return tag === true ? undefined : tag;
}

export interface InternalListener {
  /** The port actually bound (useful when starting on port 0 in tests). */
  readonly port: number;
  close(): Promise<void>;
}

export interface ProjectInternalUnixListener {
  readonly socketPath: string;
  readonly identity: InternalConnectionIdentity;
  close(): Promise<void>;
}

export interface ProjectInternalUnixListenerOptions {
  /** Existing, Verity-owned root under which the binding directory is derived. */
  readonly socketRoot: string;
  readonly identity: InternalConnectionIdentity;
  /** Verity-owned uid for the non-writable directory/socket owner. */
  readonly ownerUid: number;
  /** Dedicated relay group; group members may connect but cannot replace files. */
  readonly relayGid: number;
}

/** Remove a socket path only while it still names the inode this lifecycle
 * bound. A successor may bind the same pathname between `server.close()` and
 * outgoing cleanup during an update handoff; path-only unlinking would delete
 * that successor's live socket. */
export function unlinkOwnedUnixSocket(
  socketPath: string,
  owner: Pick<Stats, 'dev' | 'ino' | 'ctimeMs'>,
): void {
  try {
    const current = lstatSync(socketPath);
    if (
      current.isSocket() &&
      !current.isSymbolicLink() &&
      current.dev === owner.dev &&
      current.ino === owner.ino &&
      current.ctimeMs === owner.ctimeMs
    )
      unlinkSync(socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

export function projectSocketBindingName(identity: InternalConnectionIdentity): string {
  const bindingHash = createHash('sha256')
    .update(`${identity.projectId}\0${identity.containerGeneration}`)
    .digest('hex')
    .slice(0, 32);
  return `project-${bindingHash}`;
}

/** Exported so the relay-drift test can hold the sidecar's forwarding allowlist to
 *  it: the relay is the only hop a Sandbox has to this socket. */
export const PROJECT_UDS_ROUTES: ReadonlySet<string> = new Set([
  'POST /internal/git/sign',
  'POST /internal/github/token',
  'POST /internal/project/memory',
  // The loopback MCP gateway (ADR 0014 D1). It rides the project-bound socket for the same
  // reason the others do: the project identity the handler binds its per-turn bearer to is
  // the one the connection proved, not one the request body could claim.
  'POST /internal/mcp',
  // The Streamable HTTP server-message stream, which this gateway does not offer. Admitted
  // only so the 405 that says so comes from the gateway route rather than from a route table
  // that would answer 404 — a difference the MCP client transport acts on.
  'GET /internal/mcp',
]);

/**
 * Start an inactive-by-default, project-bound broker listener on a Unix socket.
 * The listener enforces its route set before Fastify sees the request; route
 * handlers independently bind the presented capability to `identity.projectId`.
 * Commit signing is admitted only with its project-scoped capability.
 */
export async function startProjectInternalUnixListener(
  app: FastifyInstance,
  options: ProjectInternalUnixListenerOptions,
): Promise<ProjectInternalUnixListener> {
  const { socketRoot, identity, ownerUid, relayGid } = options;
  if (identity.projectId.trim() === '' || identity.containerGeneration.trim() === '') {
    throw new Error('project Unix listener requires project and container-generation identity');
  }
  if (
    !Number.isSafeInteger(ownerUid) ||
    ownerUid < 0 ||
    !Number.isSafeInteger(relayGid) ||
    relayGid < 0
  ) {
    throw new Error('project Unix listener requires a valid owner uid and relay gid');
  }
  const rootStat = lstatSync(socketRoot);
  if (
    !rootStat.isDirectory() ||
    rootStat.isSymbolicLink() ||
    rootStat.uid !== ownerUid ||
    (rootStat.mode & 0o022) !== 0
  ) {
    throw new Error('project Unix listener requires a trusted Verity-owned socket root');
  }
  const socketDirectory = join(socketRoot, projectSocketBindingName(identity));
  let createdDirectory = false;
  try {
    mkdirSync(socketDirectory, { mode: 0o710 });
    createdDirectory = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  if (createdDirectory) {
    chownSync(socketDirectory, ownerUid, relayGid);
    chmodSync(socketDirectory, 0o710);
  } else {
    const directoryStat = lstatSync(socketDirectory);
    if (
      !directoryStat.isDirectory() ||
      directoryStat.isSymbolicLink() ||
      directoryStat.uid !== ownerUid ||
      directoryStat.gid !== relayGid ||
      (directoryStat.mode & 0o777) !== 0o710
    ) {
      throw new Error('project Unix listener refuses an untrusted existing project directory');
    }
  }

  const socketPath = join(socketDirectory, 'broker.sock');
  let existing: Stats | undefined;
  try {
    existing = lstatSync(socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (existing !== undefined) {
    if (!existing.isSocket() || existing.isSymbolicLink()) {
      throw new Error('project Unix listener refuses a non-socket broker path');
    }
    if (await unixSocketAcceptsConnections(socketPath)) {
      throw new Error('project Unix listener socket is already active');
    }
    unlinkSync(socketPath);
  }

  const connections = new Set<Socket>();
  const server = createServer((req, res) => {
    const pathname = (req.url ?? '').split('?', 1)[0] ?? '';
    if (!PROJECT_UDS_ROUTES.has(`${req.method ?? ''} ${pathname}`)) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"error":"not found"}');
      return;
    }
    app.routing(req, res);
  });
  markInternalConnections(server, identity);
  server.on('connection', (socket) => {
    connections.add(socket);
    socket.once('close', () => connections.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => reject(err);
    server.once('error', onError);
    server.listen(socketPath, () => {
      server.removeListener('error', onError);
      resolve();
    });
  });
  try {
    chownSync(socketPath, ownerUid, relayGid);
    chmodSync(socketPath, 0o660);
  } catch (error) {
    for (const socket of connections) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw error;
  }
  const boundSocket = lstatSync(socketPath);
  return {
    socketPath,
    identity,
    close: async () => {
      for (const socket of connections) socket.destroy();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
      unlinkOwnedUnixSocket(socketPath, boundSocket);
    },
  };
}

function unixSocketAcceptsConnections(socketPath: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ path: socketPath });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', (error: NodeJS.ErrnoException) => {
      socket.destroy();
      if (error.code === 'ECONNREFUSED' || error.code === 'ENOENT') resolve(false);
      else reject(error);
    });
  });
}

/**
 * Start a second HTTP listener that shares `app`'s request handler but is NOT
 * published to the host. Every accepted socket is tagged so
 * {@link requestArrivedInternally} passes. `app` must be ready (its `routing`
 * dispatch is only available post-`ready`/`listen`).
 */
export async function startInternalListener(
  app: FastifyInstance,
  port: number,
  host = '0.0.0.0',
): Promise<InternalListener> {
  const server = createServer((req, res) => {
    app.routing(req, res);
  });
  markInternalConnections(server);
  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => reject(err);
    server.once('error', onError);
    server.listen(port, host, () => {
      server.removeListener('error', onError);
      resolve();
    });
  });
  const address = server.address();
  const boundPort = typeof address === 'object' && address !== null ? address.port : port;
  return {
    port: boundPort,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
