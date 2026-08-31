import { mkdir, chmod, lstat, unlink } from 'node:fs/promises';
import { createConnection, type Server, type Socket } from 'node:net';
import { dirname } from 'node:path';

/**
 * Transport shared by Verity's private control channels.
 *
 * Both the Server→Agent-Gateway channel and the Updater→managed-Gateway channel
 * are the same thing underneath: one newline-delimited JSON frame in, one frame
 * out, over a `0600` Unix socket on a volume that only the two peers mount. The
 * filesystem is the authentication boundary — there is no bearer token, because
 * anyone who can open the socket is already inside one of the two containers.
 *
 * Everything here is deliberately payload-agnostic. Request shapes, validation,
 * and diagnostics belong to the channel that owns them; a frame that fails to
 * parse is reported structurally so no channel can leak its contents by
 * reflecting them back.
 */

export const DEFAULT_CONTROL_FRAME_BYTES = 1024 * 1024;
export const DEFAULT_CONTROL_TIMEOUT_MS = 5_000;

export class ControlProtocolError extends Error {}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Read one newline-delimited JSON frame, or reject with a structural reason. */
export function readControlFrame(
  socket: Socket,
  maxFrameBytes = DEFAULT_CONTROL_FRAME_BYTES,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0);
    const onData = (chunk: Buffer): void => {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length > maxFrameBytes) {
        cleanup();
        reject(new ControlProtocolError('control frame is too large'));
        socket.destroy();
        return;
      }
      const newline = buffered.indexOf(0x0a);
      if (newline < 0) return;
      const frame = buffered.subarray(0, newline).toString('utf8');
      cleanup();
      try {
        resolve(JSON.parse(frame) as unknown);
      } catch {
        reject(new ControlProtocolError('control frame is not JSON'));
      }
    };
    const onEnd = (): void => {
      cleanup();
      reject(new ControlProtocolError('control frame ended early'));
    };
    const onClose = (): void => {
      cleanup();
      reject(new ControlProtocolError('control connection closed'));
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const cleanup = (): void => {
      socket.off('data', onData);
      socket.off('end', onEnd);
      socket.off('close', onClose);
      socket.off('error', onError);
    };
    socket.on('data', onData);
    socket.once('end', onEnd);
    socket.once('close', onClose);
    socket.once('error', onError);
  });
}

/** Write one frame and end the connection, tolerating a client that left. */
export function writeControlFrame(socket: Socket, value: unknown): void {
  if (socket.destroyed || socket.writableEnded) return;
  // A client may disconnect after its request was parsed but before an older
  // serialized request finishes. Treat that as a dropped response, not a
  // process-level EPIPE.
  socket.once('error', () => undefined);
  socket.end(`${JSON.stringify(value)}\n`);
}

/** Send one frame and await the peer's reply, bounded by a timeout. */
export function exchangeControlFrame(options: {
  socketPath: string;
  request: unknown;
  /** Prefix for transport-level diagnostics, e.g. `Agent gateway control`. */
  label: string;
  timeoutMs?: number;
  maxFrameBytes?: number;
}): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(options.socketPath);
    const timeout = setTimeout(
      () => socket.destroy(new Error(`${options.label} timed out`)),
      options.timeoutMs ?? DEFAULT_CONTROL_TIMEOUT_MS,
    );
    timeout.unref();
    // Keep the writable side open while the request waits behind an older
    // serialized request; half-closing here lets Node auto-close the server
    // socket before it has a chance to send the queued response.
    socket.once('connect', () => socket.write(`${JSON.stringify(options.request)}\n`));
    socket.once('error', reject);
    void readControlFrame(socket, options.maxFrameBytes)
      .then(resolve)
      .catch(reject)
      .finally(() => {
        clearTimeout(timeout);
        socket.destroy();
      });
  });
}

/**
 * Make the socket path bindable, refusing to displace a live peer.
 *
 * A stale socket file survives a crash and would otherwise make `listen` fail,
 * so it is unlinked — but only after proving nothing answers on it. Unlinking a
 * socket a running process is still bound to would leave that process serving a
 * path no client can reach.
 */
export async function prepareControlSocketPath(options: {
  socketPath: string;
  /** Prefix for diagnostics, e.g. `Agent gateway control`. */
  label: string;
  /** Frame written to a responsive peer while probing; any valid request. */
  probe: unknown;
}): Promise<void> {
  const socketDirectory = dirname(options.socketPath);
  await mkdir(socketDirectory, { recursive: true, mode: 0o700 });
  // Named-volume roots can pre-exist with image/default permissions. The
  // control directory itself is part of the authentication boundary, so
  // reconcile its mode on every start rather than relying on mkdir's mode.
  await chmod(socketDirectory, 0o700);
  try {
    const stat = await lstat(options.socketPath);
    if (!stat.isSocket()) throw new Error(`${options.label} path exists and is not a socket`);
    if (await socketAcceptsConnections(options.socketPath, options.probe)) {
      throw new Error(`${options.label} socket is already active`);
    }
    await unlink(options.socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function socketAcceptsConnections(socketPath: string, probe: unknown): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    const timeout = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, 250);
    timeout.unref();
    socket.once('connect', () => {
      clearTimeout(timeout);
      socket.write(`${JSON.stringify(probe)}\n`);
      socket.once('data', () => socket.destroy());
      resolve(true);
    });
    socket.once('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timeout);
      if (error.code === 'ECONNREFUSED' || error.code === 'ENOENT') resolve(false);
      else reject(error);
    });
  });
}

export function listenUnix(server: Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.off('error', reject);
      void chmod(socketPath, 0o600).then(() => resolve(), reject);
    });
  });
}

export function closeUnixServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
