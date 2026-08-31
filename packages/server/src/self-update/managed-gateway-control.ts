import { chmod } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';

import {
  closeUnixServer,
  ControlProtocolError,
  DEFAULT_CONTROL_TIMEOUT_MS,
  exchangeControlFrame,
  isRecord,
  listenUnix,
  prepareControlSocketPath,
  readControlFrame,
  writeControlFrame,
} from '../control-socket.js';
import type {
  ManagedGatewayBackend,
  ManagedGatewayRuntime,
  ManagedGatewayStatus,
} from './managed-gateway.js';

/**
 * Out-of-process control surface for the managed Gateway (ADR 0008 D7).
 *
 * The Gateway's maintenance switch and backend selection exist as in-process
 * calls, but the Updater — the process that has to use them — runs in a
 * different container with `network_mode: none`. This channel is the only way
 * the two can meet: a Unix socket on a volume both mount, carrying the same
 * newline-delimited JSON frames as the Server→Agent-Gateway channel.
 *
 * Access control is the filesystem. The socket is `0600` and owned by the
 * Gateway's uid; the Updater reaches it as root. No bearer token is involved,
 * because a process that can open this socket is already inside one of the two
 * containers, and neither the requests nor the responses carry a secret.
 *
 * The Gateway is deliberately the passive side. It exposes what it is routing
 * and accepts instructions about it, but it never decides that an update should
 * happen — that authority stays with the sealed deployment spec and the journal.
 */

/** Path both sides agree on, via the `verity-managed-gateway-control` volume. */
export const MANAGED_GATEWAY_CONTROL_SOCKET = '/run/verity-gateway/control.sock';

/** Maximum startup grace for a Gateway container to bind its control socket. */
export const GATEWAY_CONTROL_BIND_TIMEOUT_MS = 60_000;
const BIND_POLL_MS = 250;

/** Diagnostic prefix for transport-level failures on this channel. */
const CONTROL_LABEL = 'Managed gateway control';

/**
 * Upper bound on a requested drain. The channel serializes requests, so an
 * unbounded drain would also block the status query that would explain the
 * stall. Any real drain is a few seconds; this only stops a typo from wedging
 * the channel until the Gateway restarts.
 */
export const MAX_DRAIN_TIMEOUT_MS = 300_000;

/** The part of the runtime this channel is allowed to reach. */
export type ManagedGatewayControlTarget = Pick<
  ManagedGatewayRuntime,
  'status' | 'enterMaintenance' | 'leaveMaintenance' | 'switchBackend' | 'drain'
>;

type ControlRequest =
  | { type: 'status' }
  | { type: 'enter-maintenance' }
  | { type: 'leave-maintenance' }
  | { type: 'switch-backend'; backend: ManagedGatewayBackend }
  | { type: 'drain'; timeoutMs: number };

type ControlResponse =
  { ok: true; status: ManagedGatewayStatus; forced?: number } | { ok: false; error: string };

type ParsedControlRequest = { request: ControlRequest } | { error: unknown };

export interface ManagedGatewayControlServer {
  close(): Promise<void>;
}

export async function startManagedGatewayControlServer(options: {
  socketPath: string;
  requestTimeoutMs?: number;
  gateway: ManagedGatewayControlTarget;
}): Promise<ManagedGatewayControlServer> {
  await prepareControlSocketPath({
    socketPath: options.socketPath,
    label: CONTROL_LABEL,
    probe: { type: 'status' } satisfies ControlRequest,
  });
  let controlTail: Promise<void> = Promise.resolve();
  const server = createServer((socket) => {
    // Start reading immediately: a later connection may time out while an
    // earlier drain is still running, and retaining its settled result keeps an
    // already-closed socket from blocking the serialized queue forever.
    const parsed = readControlRequest(
      socket,
      options.requestTimeoutMs ?? DEFAULT_CONTROL_TIMEOUT_MS,
    );
    // Serialized on purpose. Maintenance, backend switch, and drain are a
    // sequence with preconditions on each other; interleaving two of them would
    // let a stale instruction land after the one that superseded it.
    controlTail = controlTail.then(() => handleControlSocket(socket, options.gateway, parsed));
  });
  await listenUnix(server, options.socketPath);
  try {
    await chmod(options.socketPath, 0o600);
  } catch (error) {
    await closeUnixServer(server).catch(() => undefined);
    throw error;
  }
  return {
    async close(): Promise<void> {
      // Node removes a pathname-backed Unix socket as part of server.close().
      // Do not unlink afterward: a replacement process may have bound the path
      // between close completion and a second cleanup operation.
      await closeUnixServer(server);
    },
  };
}

async function handleControlSocket(
  socket: Socket,
  gateway: ManagedGatewayControlTarget,
  parsed: Promise<ParsedControlRequest>,
): Promise<void> {
  try {
    const result = await parsed;
    if ('error' in result) throw result.error;
    writeControlFrame(socket, await apply(gateway, result.request));
  } catch (error) {
    // Unlike the Agent Gateway channel, nothing secret crosses this one: the
    // payload is a host name and two ports, and the only reader of a response
    // is the peer that sent the request. Reporting the actual refusal — "switch
    // requires maintenance", "host is not allowed" — is what makes a stalled
    // promotion diagnosable, so the message is passed through rather than
    // flattened. Every one of them is a literal from this repository.
    writeControlFrame(socket, { ok: false, error: describe(error) } satisfies ControlResponse);
  }
}

async function apply(
  gateway: ManagedGatewayControlTarget,
  request: ControlRequest,
): Promise<ControlResponse> {
  switch (request.type) {
    case 'status':
      return { ok: true, status: gateway.status() };
    case 'enter-maintenance':
      gateway.enterMaintenance();
      return { ok: true, status: gateway.status() };
    case 'leave-maintenance':
      gateway.leaveMaintenance();
      return { ok: true, status: gateway.status() };
    case 'switch-backend':
      gateway.switchBackend(request.backend);
      return { ok: true, status: gateway.status() };
    case 'drain': {
      const { forced } = await gateway.drain(request.timeoutMs);
      return { ok: true, status: gateway.status(), forced };
    }
  }
}

function describe(error: unknown): string {
  if (error instanceof ControlProtocolError) return error.message;
  if (error instanceof Error && error.message.length > 0) return error.message.slice(0, 200);
  return 'control request failed';
}

async function readControlRequest(
  socket: Socket,
  timeoutMs: number,
): Promise<ParsedControlRequest> {
  const onTimeout = (): void => {
    socket.destroy();
  };
  socket.setTimeout(timeoutMs, onTimeout);
  try {
    return { request: parseRequest(await readControlFrame(socket)) };
  } catch (error) {
    return { error };
  } finally {
    // This deadline bounds how long a client may take to send its request, and
    // nothing else. Node measures it as inactivity, and a drain is silent for
    // exactly as long as it runs — leaving it armed would destroy the
    // connection mid-drain and lose the verdict the Updater is waiting for.
    socket.setTimeout(0);
    socket.off('timeout', onTimeout);
  }
}

function parseRequest(value: unknown): ControlRequest {
  if (!isRecord(value) || typeof value.type !== 'string')
    throw new ControlProtocolError('invalid control request');
  switch (value.type) {
    case 'status':
      return { type: 'status' };
    case 'enter-maintenance':
      return { type: 'enter-maintenance' };
    case 'leave-maintenance':
      return { type: 'leave-maintenance' };
    case 'switch-backend': {
      const backend = value.backend;
      if (
        !isRecord(backend) ||
        typeof backend.host !== 'string' ||
        backend.host.length === 0 ||
        !isPort(backend.publicPort) ||
        !isPort(backend.internalPort)
      )
        throw new ControlProtocolError('invalid backend selection');
      // The host is checked against this deployment's allowlist by the runtime,
      // which owns that policy; the protocol layer only guarantees the shape.
      return {
        type: 'switch-backend',
        backend: {
          host: backend.host,
          publicPort: backend.publicPort,
          internalPort: backend.internalPort,
        },
      };
    }
    case 'drain': {
      const timeoutMs = value.timeoutMs;
      if (!Number.isSafeInteger(timeoutMs) || (timeoutMs as number) < 0)
        throw new ControlProtocolError('invalid drain timeout');
      if ((timeoutMs as number) > MAX_DRAIN_TIMEOUT_MS)
        throw new ControlProtocolError('drain timeout exceeds the maximum');
      return { type: 'drain', timeoutMs: timeoutMs as number };
    }
    default:
      throw new ControlProtocolError('invalid control request');
  }
}

/**
 * A backend port is a destination, never a bind request, so `0` is rejected
 * here even though the gateway's own listen ports may legitimately be zero.
 */
function isPort(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= 65_535;
}

async function exchange(
  socketPath: string,
  request: ControlRequest,
  timeoutMs: number = DEFAULT_CONTROL_TIMEOUT_MS,
): Promise<ControlResponse> {
  const value = await exchangeControlFrame({
    socketPath,
    request,
    label: CONTROL_LABEL,
    timeoutMs,
  });
  if (!isControlResponse(value)) throw new Error('Managed gateway returned an invalid response');
  if (!value.ok) throw new Error(`Managed gateway refused the request: ${value.error}`);
  return value;
}

function isControlResponse(value: unknown): value is ControlResponse {
  if (!isRecord(value) || typeof value.ok !== 'boolean') return false;
  if (value.ok === false) return typeof value.error === 'string';
  const status = value.status;
  return (
    isRecord(status) &&
    typeof status.maintenance === 'boolean' &&
    typeof status.draining === 'boolean' &&
    typeof status.activeRequests === 'number' &&
    typeof status.upgradedConnections === 'number' &&
    isRecord(status.backend) &&
    typeof status.backend.host === 'string' &&
    typeof status.backend.publicPort === 'number' &&
    typeof status.backend.internalPort === 'number' &&
    (value.forced === undefined || typeof value.forced === 'number')
  );
}

function statusOf(response: ControlResponse): ManagedGatewayStatus {
  if (!response.ok) throw new Error(response.error);
  return response.status;
}

export async function readManagedGatewayStatus(socketPath: string): Promise<ManagedGatewayStatus> {
  return statusOf(await exchange(socketPath, { type: 'status' }));
}

function isUnboundSocket(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT' || code === 'ECONNREFUSED';
}

export async function waitForManagedGatewayStatus(
  socketPath: string,
  options: {
    timeoutMs?: number;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
  } = {},
): Promise<ManagedGatewayStatus> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + (options.timeoutMs ?? GATEWAY_CONTROL_BIND_TIMEOUT_MS);
  for (;;) {
    try {
      return await readManagedGatewayStatus(socketPath);
    } catch (error) {
      // A Gateway that answers and refuses is a real fault; only the absence
      // of a listener means "not yet". Widening this to every error would turn
      // a broken Gateway into a 60 s stall before the same failure.
      if (!isUnboundSocket(error) || now() >= deadline) throw error;
    }
    await sleep(Math.min(BIND_POLL_MS, Math.max(1, deadline - now())));
  }
}

export async function enterManagedGatewayMaintenance(
  socketPath: string,
): Promise<ManagedGatewayStatus> {
  return statusOf(await exchange(socketPath, { type: 'enter-maintenance' }));
}

export async function leaveManagedGatewayMaintenance(
  socketPath: string,
): Promise<ManagedGatewayStatus> {
  return statusOf(await exchange(socketPath, { type: 'leave-maintenance' }));
}

export async function switchManagedGatewayBackend(
  socketPath: string,
  backend: ManagedGatewayBackend,
): Promise<ManagedGatewayStatus> {
  return statusOf(await exchange(socketPath, { type: 'switch-backend', backend }));
}

export async function drainManagedGateway(
  socketPath: string,
  timeoutMs: number,
): Promise<{ status: ManagedGatewayStatus; forced: number }> {
  // The Gateway holds the connection open for the whole drain, so the client
  // deadline has to outlast the drain it asked for rather than the default.
  const response = await exchange(
    socketPath,
    { type: 'drain', timeoutMs },
    timeoutMs + DEFAULT_CONTROL_TIMEOUT_MS,
  );
  return { status: statusOf(response), forced: response.ok ? (response.forced ?? 0) : 0 };
}
