import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { TLSSocket, createSecureContext } from 'node:tls';
import type { PemCertificate } from './claude-egress-ca.js';
import type { GhTokenCapabilityRegistry } from './github-token-broker.js';
import type { InternalConnectionIdentity } from './internal-listener.js';
import type { BrokeredForgeAdapter, ForgeAction } from './brokered-forge-github.js';
import {
  brokeredHttpStreamTransport,
  relayBrokeredHttpResponse,
  type BrokeredHttpStreamTransport,
} from './brokered-http-stream.js';

export interface BrokeredForgeProxy {
  connect(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    identity: InternalConnectionIdentity,
  ): void;
}
const FORWARDED_HEADERS = new Set([
  'accept',
  'content-type',
  'content-encoding',
  'git-protocol',
  'x-github-api-version',
]);
const ALL_ACTIONS: ReadonlySet<ForgeAction> = new Set([
  'git-read',
  'git-write',
  'issues-read',
  'issues-write',
  'pulls-read',
  'pulls-write',
]);
export const FORGE_PROXY_CA_FILE = '/run/verity/forge-proxy/ca.crt';
export const FORGE_PLACEHOLDER_PREFIX = 'verity-broker-';

function capability(request: IncomingMessage): string | undefined {
  const value = request.headers.authorization;
  if (!value) return undefined;
  let credential: string;
  if (/^(Bearer|token) /i.test(value)) credential = value.slice(value.indexOf(' ') + 1);
  else if (value.startsWith('Basic ')) {
    const decoded = Buffer.from(value.slice(6), 'base64').toString('utf8');
    credential = decoded.slice(decoded.indexOf(':') + 1);
  } else return undefined;
  return credential.startsWith(FORGE_PLACEHOLDER_PREFIX)
    ? credential.slice(FORGE_PLACEHOLDER_PREFIX.length)
    : undefined;
}
function fail(response: ServerResponse, status: number): void {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  if (status === 401) response.setHeader('www-authenticate', 'Basic realm="Verity forge broker"');
  response.writeHead(status, { 'content-type': 'application/json', connection: 'close' });
  response.end('{"error":"forge broker request rejected"}');
}
async function bufferedBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const value of request) {
    const chunk = Buffer.from(value as Uint8Array);
    size += chunk.length;
    if (size > 1_048_576) throw new Error('forge body rejected');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** Extend the HTTP secret broker with a repository-bound streaming transport.
 * Only this server owns TLS keys and provider credentials. The project listener
 * supplies identity; neither CONNECT nor the decrypted request can choose it. */
export function createBrokeredForgeProxy(options: {
  certificate: PemCertificate;
  capabilities: GhTokenCapabilityRegistry;
  adapter: BrokeredForgeAdapter;
  enabled(projectId: string): boolean;
  actions?(projectId: string): ReadonlySet<ForgeAction>;
  transport?: BrokeredHttpStreamTransport;
}): BrokeredForgeProxy {
  const context = createSecureContext({
    key: options.certificate.keyPem,
    cert: options.certificate.certPem,
    minVersion: 'TLSv1.2',
  });
  const transport = options.transport ?? brokeredHttpStreamTransport;
  return {
    connect(request, socket, head, identity) {
      const target = request.url ?? '';
      const hostname = target.endsWith(':443') ? target.slice(0, -4) : '';
      if (
        !options.enabled(identity.projectId) ||
        !options.adapter.hosts.has(hostname) ||
        head.length ||
        request.headers['transfer-encoding'] ||
        (request.headers['content-length'] !== undefined &&
          request.headers['content-length'] !== '0')
      ) {
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
        return;
      }
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      const tls = new TLSSocket(socket, { isServer: true, secureContext: context });
      const tunnelDeadline = setTimeout(() => tls.destroy(), 10 * 60_000);
      tunnelDeadline.unref();
      tls.once('close', () => clearTimeout(tunnelDeadline));
      tls.on('error', () => tls.destroy());
      tls.setTimeout(60_000, () => tls.destroy());
      const server = createServer({ maxHeaderSize: 16_384 }, (inner, response) => {
        response.shouldKeepAlive = false;
        const abort = new AbortController();
        const timeout = setTimeout(() => abort.abort(), 10 * 60_000);
        timeout.unref();
        response.once('close', () => {
          clearTimeout(timeout);
          abort.abort();
        });
        void (async () => {
          const presented = capability(inner);
          const binding = presented ? await options.capabilities.resolve(presented) : undefined;
          if (
            !binding ||
            binding.projectId !== identity.projectId ||
            binding.containerGeneration !== identity.containerGeneration
          ) {
            fail(response, 401);
            return;
          }
          if (inner.headers.host !== hostname && inner.headers.host !== `${hostname}:443`) {
            fail(response, 403);
            return;
          }
          if (
            inner.headers.connection
              ?.toLowerCase()
              .split(/\s*,\s*/)
              .some((name) => name !== 'close' && name !== 'keep-alive') ||
            inner.headers.expect ||
            inner.headers.upgrade
          ) {
            fail(response, 403);
            return;
          }
          const path = inner.url ?? '';
          // API envelopes are bounded before parsing/policy; Git bodies remain binary streams.
          const body = options.adapter.streams({ hostname, method: inner.method ?? '', path })
            ? inner
            : await bufferedBody(inner);
          if (Buffer.isBuffer(body) && inner.headers['content-encoding']) {
            fail(response, 403);
            return;
          }
          const auth = await options.adapter.authorize(
            {
              hostname,
              method: inner.method ?? '',
              path,
              ...(Buffer.isBuffer(body) ? { body } : {}),
            },
            binding,
            options.actions?.(binding.projectId) ?? ALL_ACTIONS,
            abort.signal,
          );
          if (abort.signal.aborted) return;
          const headers: Record<string, string> = {
            authorization: auth.authorization,
            'user-agent': 'verity-forge-broker',
            'accept-encoding': 'identity',
          };
          for (const [name, value] of Object.entries(inner.headers)) {
            if (FORWARDED_HEADERS.has(name) && typeof value === 'string') headers[name] = value;
          }
          if (Buffer.isBuffer(body)) headers['content-length'] = String(body.length);
          const upstream = await transport({
            hostname,
            method: inner.method ?? '',
            path,
            headers,
            body,
            signal: abort.signal,
          });
          await relayBrokeredHttpResponse(
            upstream,
            response,
            [...auth.credentials, { value: auth.authorization, alias: 'FORGE_AUTH' }],
            abort.signal,
          );
        })()
          .catch(() => fail(response, 502))
          .finally(() => clearTimeout(timeout));
      });
      server.maxRequestsPerSocket = 1;
      server.requestTimeout = 10 * 60_000;
      server.headersTimeout = 10_000;
      server.on('clientError', () => tls.destroy());
      server.on('connect', (_inner, innerSocket) => innerSocket.destroy());
      server.on('upgrade', (_inner, innerSocket) => innerSocket.destroy());
      server.emit('connection', tls);
    },
  };
}
