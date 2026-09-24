import { createSocket, type RemoteInfo, type Socket as UdpSocket } from 'node:dgram';
import { createConnection, createServer, type Server, type Socket } from 'node:net';

/**
 * DNS for a gVisor project Sandbox.
 *
 * Docker answers names on a user-defined network from its embedded resolver at 127.0.0.11, which
 * exists only in a runc container's own network namespace: gVisor's netstack owns the Sandbox's
 * loopback, so a Sandbox under `runsc-project` resolves nothing. The relay runs under runc on the
 * same project network, so it forwards the Sandbox's queries to its own 127.0.0.11 — and the
 * Sandbox resolves exactly what a runc container on that network would: the host's resolvers
 * (systemd-resolved, Tailscale MagicDNS, search domains), whatever they are and however they
 * change, with no host configuration. Reading upstream servers out of Docker's resolv.conf
 * instead fails on every systemd-resolved host, where Docker only names 127.0.0.53.
 *
 * Bytes are relayed, never parsed; the limits below only bound what one Sandbox can make the
 * relay hold.
 */
export const DNS_PORT = 53;
export const DOCKER_EMBEDDED_DNS = { host: '127.0.0.11', port: 53 } as const;

interface DnsForwarderLimits {
  /** Queries awaiting an upstream answer over UDP. Past this, queries are dropped. */
  maxInFlightUdp: number;
  /** Concurrent DNS-over-TCP connections. */
  maxTcpConnections: number;
  /** How long a UDP query or an idle TCP connection may wait on the upstream. */
  timeoutMs: number;
}

const DNS_FORWARDER_LIMITS: Readonly<DnsForwarderLimits> = Object.freeze({
  maxInFlightUdp: 128,
  maxTcpConnections: 16,
  timeoutMs: 5_000,
});

// A DNS message has a 12-byte header; EDNS lets a UDP payload grow to 4096.
const MIN_MESSAGE_BYTES = 12;
const MAX_UDP_MESSAGE_BYTES = 4096;

export interface DnsForwarder {
  readonly udpPort: number;
  readonly tcpPort: number;
  close(): Promise<void>;
}

interface DnsForwarderOptions {
  host?: string;
  port?: number;
  upstream?: { host: string; port: number };
  limits?: Partial<DnsForwarderLimits>;
}

export async function startDnsForwarder(options: DnsForwarderOptions = {}): Promise<DnsForwarder> {
  const automaticPort = options.port === 0;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await startDnsForwarderAttempt(options);
    } catch (error) {
      if (
        !automaticPort ||
        (error as NodeJS.ErrnoException).code !== 'EADDRINUSE' ||
        attempt === 4
      ) {
        throw error;
      }
    }
  }
}

async function startDnsForwarderAttempt(options: DnsForwarderOptions): Promise<DnsForwarder> {
  const host = options.host ?? '0.0.0.0';
  const port = options.port ?? DNS_PORT;
  const upstream = options.upstream ?? DOCKER_EMBEDDED_DNS;
  const limits = { ...DNS_FORWARDER_LIMITS, ...options.limits };

  const udp = createSocket('udp4');
  const pending = new Set<UdpSocket>();
  udp.on('message', (query: Buffer, client: RemoteInfo) => {
    if (query.length < MIN_MESSAGE_BYTES || query.length > MAX_UDP_MESSAGE_BYTES) return;
    // Dropped, not refused: the client's resolver retries, as it would for a lost packet.
    if (pending.size >= limits.maxInFlightUdp) return;
    const exchange = createSocket('udp4');
    pending.add(exchange);
    const done = (): void => {
      clearTimeout(timer);
      if (pending.delete(exchange)) exchange.close();
    };
    const timer = setTimeout(done, limits.timeoutMs);
    exchange.once('error', done);
    exchange.once('message', (answer: Buffer, from: RemoteInfo) => {
      if (from.address === upstream.host && from.port === upstream.port) {
        udp.send(answer, client.port, client.address);
      }
      done();
    });
    exchange.send(query, upstream.port, upstream.host, (error) => {
      if (error) done();
    });
  });

  const connections = new Set<Socket>();
  const tcp: Server = createServer((downstream) => {
    const upstreamSocket = createConnection(upstream);
    for (const socket of [downstream, upstreamSocket]) {
      connections.add(socket);
      socket.setTimeout(limits.timeoutMs, () => socket.destroy());
      socket.once('close', () => connections.delete(socket));
    }
    downstream.once('error', () => upstreamSocket.destroy());
    upstreamSocket.once('error', () => downstream.destroy());
    downstream.once('close', () => upstreamSocket.destroy());
    upstreamSocket.once('close', () => downstream.destroy());
    downstream.pipe(upstreamSocket);
    upstreamSocket.pipe(downstream);
  });
  tcp.maxConnections = limits.maxTcpConnections;

  try {
    await new Promise<void>((resolve, reject) => {
      udp.once('error', reject);
      udp.bind(port, host, () => {
        udp.off('error', reject);
        resolve();
      });
    });
    // The same port for TCP, which a resolver falls back to for a truncated answer.
    const udpPort = udp.address().port;
    await new Promise<void>((resolve, reject) => {
      tcp.once('error', reject);
      tcp.listen(udpPort, host, () => {
        tcp.off('error', reject);
        resolve();
      });
    });
  } catch (error) {
    try {
      udp.close();
    } catch {
      // Never bound.
    }
    tcp.close();
    throw error;
  }
  // A send to a vanished client must not take the relay down.
  udp.on('error', () => undefined);

  const tcpAddress = tcp.address();
  if (typeof tcpAddress !== 'object' || tcpAddress === null) {
    throw new Error('DNS forwarder has no TCP address');
  }
  return {
    udpPort: udp.address().port,
    tcpPort: tcpAddress.port,
    async close(): Promise<void> {
      for (const exchange of pending) exchange.close();
      pending.clear();
      for (const socket of connections) socket.destroy();
      await Promise.all([
        new Promise<void>((resolve) => udp.close(() => resolve())),
        new Promise<void>((resolve) => tcp.close(() => resolve())),
      ]);
    },
  };
}
