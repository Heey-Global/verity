import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { gunzipSync } from 'node:zlib';
import type { FastifyInstance, RouteHandlerMethod } from 'fastify';
import { bearerToken } from './auth.js';
import type { GhTokenCapabilityRegistry } from './github-token-broker.js';
import {
  internalConnectionGenerationSignal,
  internalConnectionIdentity,
  type InternalConnectionIdentity,
} from './internal-listener.js';
import {
  createPackageArtifactBroker,
  PackageArtifactError,
  PACKAGE_ARTIFACT_BASE_URL,
} from './package-artifact-broker.js';
import type { BrokeredHttpStreamTransport } from './brokered-http-stream.js';

function capability(header: string | undefined): string {
  const bearer = bearerToken(header);
  if (bearer) return bearer;
  // pip and uv use index URL Basic credentials; no provider credential is minted.
  const basic = /^Basic ([A-Za-z0-9+/]+={0,2})$/u.exec(header ?? '');
  if (!basic || basic[1]!.length > 2048) return '';
  const decoded = Buffer.from(basic[1]!, 'base64').toString('utf8');
  return decoded.startsWith('verity:') ? decoded.slice(7) : '';
}

export function registerPackageArtifactRoutes(
  app: FastifyInstance,
  options: {
    capabilities: GhTokenCapabilityRegistry;
    transport?: BrokeredHttpStreamTransport;
    artifactBaseUrl?: (identity: InternalConnectionIdentity) => string;
  },
): void {
  const broker = createPackageArtifactBroker(options);
  let activeTransfers = 0;
  const handler: RouteHandlerMethod = async (request, reply) => {
    const authorityProbe =
      request.method === 'HEAD' && request.url === '/internal/package-artifacts/authority';
    if (!authorityProbe && activeTransfers >= 2)
      return reply.code(429).send({ error: 'package artifact capacity reached' });
    if (!authorityProbe) activeTransfers++;
    try {
      const identity = internalConnectionIdentity(request);
      const generation = internalConnectionGenerationSignal(request);
      const token = capability(request.headers.authorization);
      const authorized = async (): Promise<boolean> => {
        if (!identity || !generation || generation.aborted || !token) return false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const binding = await Promise.race([
          options.capabilities.resolve(token).catch(() => undefined),
          new Promise<undefined>((resolve) => {
            timer = setTimeout(() => resolve(undefined), 1000);
            timer.unref();
          }),
        ]).finally(() => {
          if (timer) clearTimeout(timer);
        });
        return (
          !generation.aborted &&
          binding?.projectId === identity.projectId &&
          binding.containerGeneration === identity.containerGeneration
        );
      };
      if (!(await authorized()) || !identity) {
        reply.header('www-authenticate', 'Basic realm="Verity package artifacts"');
        return reply.code(401).send({ error: 'unauthorized' });
      }
      // Registry paths only: no query, caller headers, upstream cookies or raw URLs.
      if (
        request.url.includes('?') ||
        request.headers.range ||
        (request.method !== 'POST' &&
          ((request.headers['content-length'] && request.headers['content-length'] !== '0') ||
            request.headers['transfer-encoding']))
      )
        return reply.code(400).send({ error: 'invalid package artifact request' });
      if (authorityProbe) return reply.code(204).send();
      const controller = new AbortController();
      let sending = false;
      const abort = () => {
        controller.abort();
        if (sending && !reply.raw.writableFinished) reply.raw.destroy();
      };
      const closed = () => {
        if (!reply.raw.writableFinished) abort();
      };
      generation?.addEventListener('abort', abort, { once: true });
      request.raw.once('aborted', abort);
      reply.raw.once('close', closed);
      if (generation?.aborted) abort();
      const timeout = setTimeout(abort, 30_000);
      timeout.unref();
      let polling = false;
      const poll = setInterval(() => {
        if (polling || controller.signal.aborted) return;
        polling = true;
        void authorized()
          .then((valid) => {
            if (!valid) abort();
          }, abort)
          .finally(() => {
            polling = false;
          });
      }, 200);
      poll.unref();
      try {
        const path = (request.params as { '*': string })['*'];
        const base = options.artifactBaseUrl?.(identity) ?? PACKAGE_ARTIFACT_BASE_URL;
        const response =
          request.method === 'POST'
            ? await broker.advisories(request.body, controller.signal, authorized)
            : await broker.serve(path, controller.signal, authorized, base);
        if (controller.signal.aborted || !(await authorized()))
          return reply.code(401).send({ error: 'unauthorized' });
        reply.header('cache-control', 'no-store');
        sending = true;
        // Keep revocation checks alive until the client-side transfer completes,
        // rather than dropping them as soon as the broker buffers the artifact.
        const transfer = finished(reply.raw, { readable: false, cleanup: true });
        // Fastify's Reply thenable can settle after end() while socket writes are
        // still buffered. Observe the actual writable completion instead.
        void transfer.catch(() => {});
        reply.type(response.contentType).send(response.body);
        await transfer;
        return reply;
      } catch (error) {
        if (reply.raw.destroyed) return;
        const status = controller.signal.aborted
          ? 401
          : error instanceof PackageArtifactError
            ? error.status
            : 502;
        return reply.code(status).send({ error: 'package artifact request rejected' });
      } finally {
        clearTimeout(timeout);
        clearInterval(poll);
        generation?.removeEventListener('abort', abort);
        request.raw.removeListener('aborted', abort);
        reply.raw.removeListener('close', closed);
      }
    } finally {
      if (!authorityProbe) activeTransfers--;
    }
  };
  app.get('/internal/package-artifacts/*', handler);
  app.post(
    '/internal/package-artifacts/npm/-/npm/v1/security/advisories/bulk',
    {
      bodyLimit: 65536,
      preParsing: async (request, _reply, payload) => {
        const encoding = request.headers['content-encoding'];
        if (encoding === undefined || encoding === 'identity') return payload;
        if (encoding !== 'gzip')
          throw Object.assign(new Error('Unsupported advisory encoding'), { statusCode: 415 });
        const parts: Buffer[] = [];
        let bytes = 0;
        for await (const value of payload) {
          const chunk = Buffer.from(value as Uint8Array);
          bytes += chunk.length;
          if (bytes > 65536)
            throw Object.assign(new Error('Advisory body too large'), { statusCode: 413 });
          parts.push(chunk);
        }
        let decoded: Buffer;
        try {
          decoded = gunzipSync(Buffer.concat(parts, bytes), { maxOutputLength: 65536 });
        } catch {
          throw Object.assign(new Error('Invalid compressed advisory body'), { statusCode: 400 });
        }
        // Fastify compares the original Content-Length against encoded bytes.
        const stream = Object.assign(Readable.from([decoded]), { receivedEncodedLength: bytes });
        delete request.headers['content-encoding'];
        return stream;
      },
    },
    handler,
  );
}
