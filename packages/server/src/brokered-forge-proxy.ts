import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { TLSSocket, createSecureContext } from 'node:tls';
import { randomUUID } from 'node:crypto';
import type { PemCertificate } from './claude-egress-ca.js';
import type { TurnCredentials } from './turn-credentials.js';
import type { GhTokenCapabilityRegistry } from './github-token-broker.js';
import type { InternalConnectionIdentity } from './internal-listener.js';
import {
  ForgePolicyError,
  type BrokeredForgeAdapter,
  type ForgeAction,
} from './brokered-forge-github.js';
import {
  brokeredHttpStreamTransport,
  relayBrokeredHttpResponse,
  brokeredDownload,
  verifyRelatedIssueResponse,
  type BrokeredHttpStreamTransport,
} from './brokered-http-stream.js';

export interface BrokeredForgeProxy {
  connect(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    identity: InternalConnectionIdentity,
    generationSignal?: AbortSignal,
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
  'releases-read',
  'actions-read',
  'actions-write',
  'releases-write',
  'checks-read',
  'repository-rules-read',
  'packages-read',
]);
export const FORGE_PROXY_CA_FILE = '/run/verity/forge-proxy/ca.crt';
// Never log upstream messages, URLs, headers or error objects: they can contain credentials.
const SAFE_TRANSPORT_CODES = new Set([
  'ERR_INVALID_ARG_VALUE',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'CERT_HAS_EXPIRED',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ABORT_ERR',
  'ERR_STREAM_PREMATURE_CLOSE',
  'ERR_SSL_WRONG_VERSION_NUMBER',
  'ERR_SSL_UNEXPECTED_EOF_WHILE_READING',
  'ERR_SSL_TLSV1_ALERT_UNKNOWN_CA',
  'HPE_INVALID_METHOD',
  'HPE_INVALID_HEADER_TOKEN',
  'HPE_HEADER_OVERFLOW',
  'HPE_INVALID_EOF_STATE',
]);
type FailurePhase =
  | 'certificate'
  | 'client-tls'
  | 'http-parser'
  | 'request'
  | 'upstream'
  | 'response'
  | 'idle-timeout'
  | 'tunnel-timeout'
  | 'request-timeout'
  | 'generation-abort'
  | 'authorization';
const FORGE_PLACEHOLDER_PREFIX = 'verity-broker-';

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

type RepositoryBinding = NonNullable<Awaited<ReturnType<GhTokenCapabilityRegistry['resolve']>>>;

/** Extend the HTTP secret broker with a repository-bound streaming transport.
 * Only this server owns TLS keys and provider credentials. The project listener
 * supplies identity; neither CONNECT nor the decrypted request can choose it. */
export function createBrokeredForgeProxy(options: {
  certificate: PemCertificate;
  certificateFor?(hostname: string): Promise<PemCertificate>;
  allowsHost?(authority: string): Promise<boolean>;
  capabilities: GhTokenCapabilityRegistry;
  /** A turn's own badge, accepted alongside the container capability; it proves
   *  the project and names the turn's person for personal forge access later. */
  turnCredentials?: Pick<TurnCredentials, 'resolve'> | undefined;
  resolveRepository?: (
    binding: NonNullable<Awaited<ReturnType<GhTokenCapabilityRegistry['resolve']>>>,
    hostname: string,
    path: string,
  ) => Promise<RepositoryBinding | RepositoryBinding[] | undefined>;
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
  // A bad client can open many tunnels. Bound diagnostics across the proxy as
  // well as deduplicating each tunnel's cascading abort/error/close events.
  let diagnosticWindow = Date.now();
  let diagnosticCount = 0;
  return {
    connect(request, socket, head, identity, generationSignal) {
      const connectionId = randomUUID();
      let phase: FailurePhase = 'request';
      let reported = false;
      let completed = false;
      const report = (failurePhase: FailurePhase, error?: unknown) => {
        if (reported || completed) return;
        reported = true;
        const now = Date.now();
        if (now - diagnosticWindow >= 60_000) {
          diagnosticWindow = now;
          diagnosticCount = 0;
        }
        if (diagnosticCount >= 20) return;
        diagnosticCount++;
        const code = error instanceof Error && 'code' in error ? error.code : undefined;
        console.warn('Forge broker connection failed', {
          connectionId,
          phase: failurePhase,
          code: typeof code === 'string' && SAFE_TRANSPORT_CODES.has(code) ? code : 'UNKNOWN',
        });
      };
      void (async () => {
        const target = request.url ?? '';
        const hostname = target.endsWith(':443') ? target.slice(0, -4) : target;
        let allowed = options.adapter.hosts.has(hostname);
        try {
          if (options.allowsHost) allowed = await options.allowsHost(hostname);
        } catch {
          allowed = false;
        }
        if (
          generationSignal?.aborted ||
          !options.enabled(identity.projectId) ||
          !allowed ||
          head.length ||
          request.headers['transfer-encoding'] ||
          (request.headers['content-length'] !== undefined &&
            request.headers['content-length'] !== '0')
        ) {
          socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
          return;
        }
        let selectedContext = context;
        if (options.certificateFor) {
          phase = 'certificate';
          try {
            const certificate = await options.certificateFor(hostname);
            selectedContext = createSecureContext({
              key: certificate.keyPem,
              cert: certificate.certPem,
              minVersion: 'TLSv1.2',
            });
          } catch (error) {
            report('certificate', error);
            socket.destroy();
            return;
          }
        }
        if (generationSignal?.aborted || socket.destroyed) return;
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        phase = 'client-tls';
        const tls = new TLSSocket(socket, { isServer: true, secureContext: selectedContext });
        const tunnelDeadline = setTimeout(() => {
          report('tunnel-timeout');
          tls.destroy();
        }, 10 * 60_000);
        tunnelDeadline.unref();
        tls.once('secure', () => {
          phase = 'http-parser';
        });
        tls.once('close', () => {
          clearTimeout(tunnelDeadline);
          if (!completed) report(generationSignal?.aborted ? 'generation-abort' : phase);
        });
        tls.on('error', (error) => {
          report(phase, error);
          tls.destroy();
        });
        tls.setTimeout(60_000, () => {
          report('idle-timeout');
          tls.destroy();
        });
        const server = createServer({ maxHeaderSize: 16_384 }, (inner, response) => {
          phase = 'request';
          response.shouldKeepAlive = false;
          response.once('finish', () => {
            completed = true;
          });
          const abort = new AbortController();
          const retire = () => {
            report('generation-abort');
            abort.abort();
          };
          generationSignal?.addEventListener('abort', retire, { once: true });
          if (generationSignal?.aborted) abort.abort();
          let authorizationPoll: ReturnType<typeof setInterval> | undefined;
          const timeout = setTimeout(() => {
            report('request-timeout');
            abort.abort();
          }, 10 * 60_000);
          timeout.unref();
          response.once('close', () => {
            clearTimeout(timeout);
            if (authorizationPoll !== undefined) clearInterval(authorizationPoll);
            generationSignal?.removeEventListener('abort', retire);
            abort.abort();
          });
          void (async () => {
            if (
              hostname === 'ghcr.io' &&
              inner.url === '/v2/' &&
              ['GET', 'HEAD'].includes(inner.method ?? '')
            ) {
              response.writeHead(401, {
                'www-authenticate': 'Bearer realm="https://ghcr.io/token",service="ghcr.io"',
                'docker-distribution-api-version': 'registry/2.0',
              });
              response.end();
              return;
            }
            const path = inner.url ?? '';
            const presented = capability(inner);
            let chosen: RepositoryBinding | undefined;
            let candidates: RepositoryBinding[] = [];
            const resolveBinding = async () => {
              const turn =
                presented === undefined
                  ? undefined
                  : options.turnCredentials?.resolve({
                      projectId: identity.projectId,
                      token: presented,
                    });
              // A badge proves the project itself; the repository and generation are
              // the project's current container binding, exactly as its capability
              // would have named them.
              const current = !presented
                ? undefined
                : turn !== undefined
                  ? await options.capabilities.bindingForProject?.(identity.projectId)
                  : await options.capabilities.resolve(presented);
              const resolved =
                current && options.resolveRepository
                  ? await options.resolveRepository(current, hostname, path)
                  : current;
              candidates = (Array.isArray(resolved) ? resolved : resolved ? [resolved] : []).filter(
                (candidate) =>
                  candidate.projectId === identity.projectId &&
                  candidate.containerGeneration === identity.containerGeneration,
              );
              const selected = chosen;
              return selected
                ? candidates.find(
                    (candidate) =>
                      candidate.owner === selected.owner &&
                      candidate.repo === selected.repo &&
                      candidate.forgeConnectionId === selected.forgeConnectionId,
                  )
                : candidates[0];
            };
            let binding = await resolveBinding();
            if (
              abort.signal.aborted ||
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
                .split(',')
                .map((name) => name.trim())
                .some((name) => name !== 'close' && name !== 'keep-alive') ||
              inner.headers.expect ||
              inner.headers.upgrade
            ) {
              fail(response, 403);
              return;
            }
            // API envelopes are bounded before parsing/policy; Git bodies remain binary streams.
            const body = options.adapter.streams({ hostname, method: inner.method ?? '', path })
              ? inner
              : await bufferedBody(inner);
            // Git compresses larger upload-pack requests; forward them without inflating in the broker.
            if (
              inner.headers['content-encoding'] &&
              !(
                inner.method === 'POST' &&
                /^\/(?:[^/]+\/)*git-upload-pack$/.test(path) &&
                inner.headers['content-encoding'] === 'gzip'
              )
            ) {
              fail(response, 403);
              return;
            }
            let auth: Awaited<ReturnType<BrokeredForgeAdapter['authorize']>> | undefined;
            let rejected: unknown;
            for (const candidate of candidates) {
              try {
                auth = await options.adapter.authorize(
                  {
                    hostname,
                    method: inner.method ?? '',
                    path,
                    ...(Buffer.isBuffer(body) ? { body } : {}),
                  },
                  candidate,
                  options.actions?.(candidate.projectId) ?? ALL_ACTIONS,
                  abort.signal,
                );
                chosen = candidate;
                binding = candidate;
                break;
              } catch (error) {
                rejected = error;
              }
            }
            if (!auth)
              throw rejected instanceof Error
                ? rejected
                : new Error('repository authorization failed', { cause: rejected });
            // Credential resolution may wait on a provider. The exact capability
            // and repository binding must still be live when payload leaves.
            const still = await resolveBinding();
            const matches = (current: typeof still) =>
              current !== undefined &&
              current.projectId === binding.projectId &&
              current.containerGeneration === binding.containerGeneration &&
              current.owner === binding.owner &&
              current.repo === binding.repo &&
              current.forgeConnectionId === binding.forgeConnectionId;
            if (abort.signal.aborted || !matches(still) || !options.enabled(identity.projectId)) {
              fail(response, 401);
              return;
            }
            let checking = false;
            authorizationPoll = setInterval(() => {
              if (checking || abort.signal.aborted) return;
              checking = true;
              // A wedged capability store must close the stream, not suspend
              // revocation checks indefinitely while credentials keep flowing.
              const deadline = setTimeout(() => {
                report('authorization');
                abort.abort();
              }, 1000);
              deadline.unref();
              void resolveBinding()
                .then(
                  (current) => {
                    if (!matches(current) || !options.enabled(identity.projectId)) {
                      report('authorization');
                      abort.abort();
                    }
                  },
                  (error: unknown) => {
                    report('authorization', error);
                    abort.abort();
                  },
                )
                .finally(() => {
                  clearTimeout(deadline);
                  checking = false;
                });
            }, 500);
            authorizationPoll.unref();
            if (auth.registryTokenResponse) {
              response.writeHead(200, { 'content-type': 'application/json' });
              response.end(JSON.stringify({ token: FORGE_PLACEHOLDER_PREFIX + presented }));
              return;
            }
            const headers: Record<string, string> = {
              ...(auth.authorization ? { authorization: auth.authorization } : {}),
              'user-agent': 'verity-forge-broker',
              'accept-encoding': 'identity',
            };
            for (const [name, value] of Object.entries(inner.headers)) {
              if (FORWARDED_HEADERS.has(name) && typeof value === 'string') headers[name] = value;
            }
            if (Buffer.isBuffer(body)) headers['content-length'] = String(body.length);
            else if (typeof inner.headers['content-length'] === 'string') {
              if (
                !/^\d+$/.test(inner.headers['content-length']) ||
                Number(inner.headers['content-length']) > 2 * 1024 ** 3
              ) {
                fail(response, 413);
                return;
              }
              headers['content-length'] = inner.headers['content-length'];
            }
            const input = {
              hostname,
              ...auth.upstream,
              method: inner.method ?? '',
              path,
              headers,
              body,
              signal: abort.signal,
            };
            phase = 'upstream';
            let upstream = await brokeredDownload(
              transport,
              input,
              (inner.method === 'GET' || inner.method === 'HEAD') &&
                ((hostname === 'ghcr.io' && path.includes('/blobs/')) ||
                  (hostname === 'api.github.com' &&
                    /\/(?:logs|zip|releases\/assets\/\d+)$/.test(path.split('?')[0]!))),
            );
            phase = 'response';
            if (auth.verifyRelatedIssues)
              upstream = await verifyRelatedIssueResponse(upstream, binding.owner, binding.repo);
            await relayBrokeredHttpResponse(
              upstream,
              response,
              [
                ...auth.credentials,
                ...(auth.authorization ? [{ value: auth.authorization, alias: 'FORGE_AUTH' }] : []),
              ],
              abort.signal,
            );
          })()
            .catch((error: unknown) => {
              if (!(error instanceof ForgePolicyError)) {
                report(phase, error);
              }
              fail(response, error instanceof ForgePolicyError ? 403 : 502);
            })
            .finally(() => {
              clearTimeout(timeout);
              if (authorizationPoll !== undefined) clearInterval(authorizationPoll);
              generationSignal?.removeEventListener('abort', retire);
            });
        });
        server.maxRequestsPerSocket = 1;
        server.requestTimeout = 10 * 60_000;
        server.headersTimeout = 10_000;
        server.on('clientError', (error) => {
          report('http-parser', error);
          tls.destroy();
        });
        server.on('connect', (_inner, innerSocket) => innerSocket.destroy());
        server.on('upgrade', (_inner, innerSocket) => innerSocket.destroy());
        server.emit('connection', tls);
      })().catch((error: unknown) => {
        report(phase, error);
        socket.destroy();
      });
    },
  };
}
