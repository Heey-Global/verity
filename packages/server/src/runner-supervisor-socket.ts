import { createConnection } from 'node:net';

/** Bounded wait for the probe below. A live supervisor accepts on its own host
 *  instantly; anything slower than this is not a supervisor a turn should wait on. */
const REACHABLE_PROBE_TIMEOUT_MS = 1_000;

/**
 * Whether a per-project runner supervisor is actually accepting connections on
 * `socketPath`.
 *
 * The file existing is NOT the same fact. A Sandbox generation whose supervisor was
 * disabled (ADR 0006 boundary attestation) or that died leaves its socket inode
 * behind on the shared runtime volume — the Server deliberately cannot remove it,
 * because the runtime directory is owned by the Runner runtime GID and the Server
 * holds only traverse (`--x`) on it. A presence check therefore reports a supervisor
 * that is not there, and every turn routed at it dies with `ECONNREFUSED` instead of
 * degrading to the in-process loopback the fallback exists for.
 *
 * Any connect failure — `ENOENT`, `ECONNREFUSED`, `EACCES`, timeout — answers the
 * same question the caller is asking ("can a turn be started through this?") with
 * `false`. A supervisor that accepts but then stalls is a different failure with its
 * own timeouts; this probe deliberately only proves the listener.
 */
export async function supervisorSocketReachable(
  socketPath: string,
  timeoutMs: number = REACHABLE_PROBE_TIMEOUT_MS,
): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = createConnection(socketPath);
    let settled = false;
    const settle = (reachable: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(reachable);
    };
    socket.setTimeout(timeoutMs, () => {
      socket.destroy();
      settle(false);
    });
    socket.once('connect', () => {
      // Half-close rather than reset: a supervisor that already started writing its
      // side of the greeting would see a hard `ECONNRESET` for a probe that only ever
      // needed the handshake. `end()` lets the peer finish and close normally.
      socket.end();
      settle(true);
    });
    // Persistent, not `once`: a late error after the verdict (the peer resetting while
    // this side is closing) must still be absorbed, or Node raises it as unhandled.
    socket.on('error', () => {
      socket.destroy();
      settle(false);
    });
    socket.once('close', () => {
      settle(false);
    });
  });
}
