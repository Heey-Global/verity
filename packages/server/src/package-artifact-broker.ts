import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { z } from 'zod';
import {
  brokeredHttpStreamTransport,
  type BrokeredHttpStreamTransport,
} from './brokered-http-stream.js';

const PREFIX = '/internal/package-artifacts/';
const METADATA_LIMIT = 2 * 1024 ** 2;
const ARTIFACT_LIMIT = 32 * 1024 ** 2;
interface Artifact {
  url: string;
  algorithm: 'sha256' | 'sha512';
  digest: string;
  filename: string;
}
export const PACKAGE_ARTIFACT_BASE_URL = 'http://verity-package-broker:8080';
export interface PackageArtifactResponse {
  body: Buffer;
  contentType: string;
}
export class PackageArtifactError extends Error {
  constructor(readonly status: number) {
    super('Package artifact request rejected');
  }
}
function reject(status = 400): never {
  throw new PackageArtifactError(status);
}
const npmName = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u;
const pypiName = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u;
const record = z.record(z.string(), z.unknown());

/** Fixed public origins, no caller URL, cookies, authorization, query or fragment. */
function upstreamUrl(value: string, host: string, prefix: string): URL {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.hostname !== host ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !url.pathname.startsWith(prefix) ||
    /%(?:2f|5c|2e)|\\/iu.test(url.pathname)
  )
    reject();
  return url;
}
async function bounded(
  response: IncomingMessage,
  limit: number,
  signal: AbortSignal,
): Promise<Buffer> {
  const encoding = response.headers['content-encoding'];
  if (encoding !== undefined && encoding !== 'identity') {
    response.destroy();
    reject(502);
  }
  const size = response.headers['content-length'];
  if (size !== undefined && (!/^\d+$/u.test(size) || Number(size) > limit)) {
    response.destroy();
    reject(413);
  }
  const parts: Buffer[] = [];
  let bytes = 0;
  try {
    for await (const value of response) {
      if (signal.aborted) reject(401);
      const chunk = Buffer.from(value as Uint8Array);
      bytes += chunk.length;
      if (bytes > limit) reject(413);
      parts.push(chunk);
    }
    if (signal.aborted) reject(401);
    return Buffer.concat(parts, bytes);
  } finally {
    response.destroy();
  }
}

/** Native registry/index adapter. Content selectors are learned from bounded provider
 * metadata, revalidate selectors under the current generation, and never authorize scripts
 * or arbitrary URLs. Registry API: github.com/npm/registry; PyPI: PEP 691.
 */
export function createPackageArtifactBroker(
  options: {
    transport?: BrokeredHttpStreamTransport;
  } = {},
) {
  const transport = options.transport ?? brokeredHttpStreamTransport;
  let inFlight = 0;
  const selectorFor = (
    ecosystem: 'npm' | 'pypi',
    name: string,
    value: Artifact,
    artifactBase: string,
  ): string =>
    `${artifactBase}${PREFIX}file/${ecosystem}/${Buffer.from(name).toString('base64url')}/${value.algorithm}/${Buffer.from(value.digest, 'base64').toString('hex')}/${encodeURIComponent(value.filename)}`;
  return {
    async advisories(
      input: unknown,
      signal: AbortSignal,
      authorized: () => Promise<boolean>,
    ): Promise<PackageArtifactResponse> {
      const parsed = z
        .record(
          z.string().min(1).max(214).regex(npmName),
          z
            .array(
              z
                .string()
                .min(1)
                .max(128)
                .regex(/^[0-9A-Za-z.+_-]+$/u),
            )
            .min(1)
            .max(100),
        )
        .safeParse(input);
      if (!parsed.success) reject();
      const payload = parsed.data;
      const body = Buffer.from(JSON.stringify(payload));
      if (body.length > 65536 || Object.keys(payload).length > 1000) reject(413);
      if (++inFlight > 2) {
        inFlight--;
        reject(429);
      }
      try {
        const check = async () => {
          if (signal.aborted || !(await authorized()) || signal.aborted) reject(401);
        };
        await check();
        const response = await transport({
          hostname: 'registry.npmjs.org',
          path: '/-/npm/v1/security/advisories/bulk',
          method: 'POST',
          headers: {
            accept: 'application/json',
            'content-type': 'application/json',
            'content-length': String(body.length),
            'accept-encoding': 'identity',
          },
          body,
          signal,
        });
        await check().catch((error: unknown) => {
          response.destroy();
          throw error;
        });
        // Unlike artifact downloads, advisory POST never follows redirects.
        if (response.statusCode !== 200) {
          response.destroy();
          reject(502);
        }
        const bytes = await bounded(response, METADATA_LIMIT, signal);
        const advisory = z
          .object({
            name: z.string().max(214),
            url: z.string().url().max(2048),
            id: z.union([z.string().max(128), z.number().int()]),
            severity: z.enum(['info', 'low', 'moderate', 'high', 'critical']),
            vulnerable_versions: z.string().max(4096),
            title: z.string().max(4096),
          })
          .passthrough();
        const result = z
          .record(z.string(), z.array(advisory).max(200))
          .parse(JSON.parse(bytes.toString('utf8')));
        for (const [name, values] of Object.entries(result))
          if (!Object.hasOwn(payload, name) || values.some((item) => item.name !== name))
            reject(502);
        await check();
        return { body: Buffer.from(JSON.stringify(result)), contentType: 'application/json' };
      } finally {
        inFlight--;
      }
    },
    async serve(
      path: string,
      signal: AbortSignal,
      authorized: () => Promise<boolean>,
      artifactBase = PACKAGE_ARTIFACT_BASE_URL,
    ): Promise<PackageArtifactResponse> {
      if (++inFlight > 2) {
        inFlight--;
        reject(429);
      }
      try {
        const check = async () => {
          if (signal.aborted || !(await authorized()) || signal.aborted) reject(401);
        };
        await check();
        const fetch = async (initial: URL, limit: number, accept: string): Promise<Buffer> => {
          let url = initial;
          for (let redirects = 0; ; redirects++) {
            await check();
            const response = await transport({
              hostname: url.hostname,
              path: url.pathname,
              method: 'GET',
              headers: { accept, 'accept-encoding': 'identity' },
              body: Buffer.alloc(0),
              signal,
            });
            await check().catch((error: unknown) => {
              response.destroy();
              throw error;
            });
            if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0)) {
              const location = response.headers.location;
              response.destroy();
              if (redirects >= 2 || typeof location !== 'string') reject(502);
              // Redirects stay on the exact previously selected provider and path class.
              url = upstreamUrl(
                new URL(location, url).href,
                initial.hostname,
                initial.pathname.startsWith('/packages/') ? '/packages/' : initial.pathname,
              );
              continue;
            }
            if (response.statusCode === 404) {
              response.destroy();
              reject(404);
            }
            if (response.statusCode !== 200) {
              response.destroy();
              reject(502);
            }
            const body = await bounded(response, limit, signal);
            await check();
            return body;
          }
        };
        const selector =
          /^file\/(npm|pypi)\/([A-Za-z0-9_-]+)\/(sha256|sha512)\/([a-f0-9]{64}|[a-f0-9]{128})\/([^/]+)$/u.exec(
            path,
          );
        let selected: Artifact | undefined;
        if (selector) {
          const name = Buffer.from(selector[2]!, 'base64url').toString('utf8');
          if (Buffer.from(name).toString('base64url') !== selector[2]) reject();
          if (selector[4]!.length !== (selector[3] === 'sha512' ? 128 : 64)) reject();
          path = selector[1] === 'npm' ? `npm/${name}` : `pypi/simple/${name}/`;
        }
        const select = (value: Artifact): void => {
          if (
            selector &&
            selector[3] === value.algorithm &&
            selector[4] === Buffer.from(value.digest, 'base64').toString('hex') &&
            selector[5] === value.filename
          )
            selected = value;
        };
        const download = async (): Promise<PackageArtifactResponse> => {
          // A lockfile URL is only a content selector, never reusable authority.
          // Re-fetch provider metadata on every request, including after restart.
          if (!selected) reject(404);
          const body = await fetch(
            new URL(selected.url),
            ARTIFACT_LIMIT,
            'application/octet-stream',
          );
          if (createHash(selected.algorithm).update(body).digest('base64') !== selected.digest)
            reject(502);
          await check();
          return { body, contentType: 'application/octet-stream' };
        };
        if (path.startsWith('npm/')) {
          const name = path.slice(4);
          if (name.length > 214 || !npmName.test(name)) reject();
          const data = record.parse(
            JSON.parse(
              (
                await fetch(
                  new URL(`https://registry.npmjs.org/${encodeURIComponent(name)}`),
                  METADATA_LIMIT,
                  'application/json',
                )
              ).toString('utf8'),
            ),
          );
          if (data.name !== name) reject(502);
          const versions = record.parse(data.versions);
          const rewritten: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
          for (const [version, raw] of Object.entries(versions)) {
            const manifest = record.parse(raw);
            const dist = record.parse(manifest.dist);
            // Old SHA1-only releases stay unavailable, rather than weakening integrity.
            const integrity =
              typeof dist.integrity === 'string'
                ? /^(sha512|sha256)-([A-Za-z0-9+/]+={0,2})$/u.exec(dist.integrity)
                : null;
            if (!integrity) continue;
            const algorithm = integrity[1] as 'sha256' | 'sha512';
            const digest = integrity[2]!;
            if (Buffer.from(digest, 'base64').length !== (algorithm === 'sha512' ? 64 : 32))
              reject(502);
            if (typeof dist.tarball !== 'string') reject(502);
            const url = upstreamUrl(dist.tarball, 'registry.npmjs.org', `/${name}/-/`);
            const filename = url.pathname.slice(url.pathname.lastIndexOf('/') + 1);
            if (!/^[a-zA-Z0-9._-]+\.tgz$/u.test(filename)) reject(502);
            const artifact = { url: url.href, algorithm, digest, filename };
            select(artifact);
            rewritten[version] = {
              ...manifest,
              dist: {
                ...dist,
                tarball: selectorFor('npm', name, artifact, artifactBase),
              },
            };
          }
          if (selector) return await download();
          const tags = record.parse(data['dist-tags']);
          data['dist-tags'] = Object.fromEntries(
            Object.entries(tags).filter(
              ([, version]) => typeof version === 'string' && Object.hasOwn(rewritten, version),
            ),
          );
          data.versions = rewritten;
          await check();
          const body = Buffer.from(JSON.stringify(data));
          if (body.length > 4 * METADATA_LIMIT) reject(413);
          return { body, contentType: 'application/json' };
        }
        const simple = /^pypi\/simple\/([^/]+)\/$/u.exec(path);
        if (simple) {
          const name = simple[1]!;
          if (name.length > 200 || !pypiName.test(name)) reject();
          const data = z
            .object({
              name: z.string(),
              files: z
                .array(
                  z.object({
                    filename: z.string(),
                    url: z.string(),
                    hashes: z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/u) }),
                    'requires-python': z.string().nullable().optional(),
                    yanked: z.union([z.boolean(), z.string()]).optional(),
                    size: z.number().int().nonnegative(),
                    'upload-time': z.string().nullable().optional(),
                  }),
                )
                .max(2000),
            })
            .parse(
              JSON.parse(
                (
                  await fetch(
                    new URL(`https://pypi.org/simple/${name}/`),
                    METADATA_LIMIT,
                    'application/vnd.pypi.simple.v1+json',
                  )
                ).toString('utf8'),
              ),
            );
          if (data.name.toLowerCase().replace(/[-_.]+/gu, '-') !== name) reject(502);
          const files = data.files
            .filter((entry) => entry.size <= ARTIFACT_LIMIT)
            .map((entry) => {
              if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,239}\.(?:whl|tar\.gz|zip)$/u.test(entry.filename))
                reject(502);
              const url = upstreamUrl(entry.url, 'files.pythonhosted.org', '/packages/');
              const artifact: Artifact = {
                url: url.href,
                filename: entry.filename,
                algorithm: 'sha256',
                digest: Buffer.from(entry.hashes.sha256, 'hex').toString('base64'),
              };
              select(artifact);
              const href = selectorFor('pypi', name, artifact, artifactBase);
              return { ...entry, url: href };
            });
          if (selector) return await download();
          await check();
          return {
            body: Buffer.from(
              JSON.stringify({ meta: { 'api-version': '1.1' }, name: data.name, files }),
            ),
            contentType: 'application/vnd.pypi.simple.v1+json',
          };
        }
        reject(404);
      } finally {
        inFlight--;
      }
    },
  };
}
