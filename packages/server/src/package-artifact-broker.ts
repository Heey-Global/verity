import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { z } from 'zod';
import { projectNpmPublications } from './npm-publication-projection.js';
import {
  npmPackageIdentity,
  npmReleaseEligibility,
  type NpmInstallPolicy,
} from './package-install-grants.js';
import {
  brokeredHttpStreamTransport,
  type BrokeredHttpStreamTransport,
} from './brokered-http-stream.js';

const PREFIX = '/internal/package-artifacts/';
/** Concurrent registry metadata lookups across all verifications; others wait. */
export const PUBLICATION_METADATA_SLOTS = 6;
/** Time one metadata lookup may take once it holds a slot; queueing does not count. */
const PUBLICATION_LOOKUP_TIMEOUT_MS = 30_000;
const METADATA_LIMIT = 2 * 1024 ** 2;
const ARTIFACT_LIMIT = 32 * 1024 ** 2;
interface Artifact {
  url: string;
  algorithm: 'sha256' | 'sha512';
  digest: string;
  filename: string;
  npmIdentity?: string;
  published?: unknown;
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
function npmArtifact(
  name: string,
  version: string,
  dist: Record<string, unknown>,
  published: unknown,
): Artifact | undefined {
  const integrity =
    typeof dist.integrity === 'string'
      ? /^(sha512|sha256)-([A-Za-z0-9+/]+={0,2})$/u.exec(dist.integrity)
      : null;
  if (!integrity) return undefined;
  const algorithm = integrity[1] as 'sha256' | 'sha512';
  const digest = integrity[2]!;
  if (Buffer.from(digest, 'base64').length !== (algorithm === 'sha512' ? 64 : 32)) reject(502);
  if (typeof dist.tarball !== 'string') reject(502);
  const url = upstreamUrl(dist.tarball, 'registry.npmjs.org', `/${name}/-/`);
  const filename = url.pathname.slice(url.pathname.lastIndexOf('/') + 1);
  if (!/^[a-zA-Z0-9._-]+\.tgz$/u.test(filename)) reject(502);
  return {
    url: url.href,
    algorithm,
    digest,
    filename,
    npmIdentity: npmPackageIdentity(name, version),
    published,
  };
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
  // Verification fans out across many names, so it queues for a slot instead of
  // failing with 429 like interactive artifact requests.
  let metadataInFlight = 0;
  const metadataWaiters: (() => void)[] = [];
  const acquireMetadataSlot = async (signal: AbortSignal): Promise<() => void> => {
    // A waiter woken for a free slot and aborted before taking it passes the
    // wake-up on, so the slot does not sit idle while others stay queued.
    const abandon = (): never => {
      if (metadataInFlight < PUBLICATION_METADATA_SLOTS) metadataWaiters.shift()?.();
      return reject(401);
    };
    while (metadataInFlight >= PUBLICATION_METADATA_SLOTS) {
      if (signal.aborted) abandon();
      await new Promise<void>((wake) => {
        // Remove the queued entry itself on abort; a stale entry would later absorb
        // the wake-up of a free slot and leave a live waiter parked.
        const entry = (): void => {
          signal.removeEventListener('abort', onAbort);
          wake();
        };
        const onAbort = (): void => {
          const index = metadataWaiters.indexOf(entry);
          if (index >= 0) metadataWaiters.splice(index, 1);
          wake();
        };
        metadataWaiters.push(entry);
        signal.addEventListener('abort', onAbort, { once: true });
      });
    }
    if (signal.aborted) abandon();
    metadataInFlight++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      metadataInFlight--;
      metadataWaiters.shift()?.();
    };
  };
  const selectorFor = (
    ecosystem: 'npm' | 'pypi',
    name: string,
    value: Artifact,
    artifactBase: string,
  ): string =>
    `${artifactBase}${PREFIX}file/${ecosystem}/${Buffer.from(name).toString('base64url')}/${value.algorithm}/${Buffer.from(value.digest, 'base64').toString('hex')}/${encodeURIComponent(value.filename)}`;
  const project = async (
    name: string,
    versions: readonly string[],
    signal: AbortSignal,
    authorized: () => Promise<boolean>,
    selectArtifact?: Parameters<typeof projectNpmPublications>[4],
  ): Promise<Awaited<ReturnType<typeof projectNpmPublications>>> => {
    const check = async (): Promise<void> => {
      if (signal.aborted || !(await authorized()) || signal.aborted) reject(401);
    };
    const initial = new URL(`https://registry.npmjs.org/${encodeURIComponent(name)}`);
    let url = initial;
    for (let redirects = 0; ; redirects++) {
      await check();
      const response = await transport({
        hostname: url.hostname,
        path: url.pathname,
        method: 'GET',
        // Full packuments compress about eightfold; the projection bounds both sizes.
        headers: { accept: 'application/json', 'accept-encoding': 'gzip' },
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
        url = upstreamUrl(new URL(location, url).href, initial.hostname, initial.pathname);
        continue;
      }
      if (response.statusCode !== 200) {
        response.destroy();
        reject(response.statusCode === 404 ? 404 : 502);
      }
      const facts = await projectNpmPublications(
        response,
        name,
        new Set(versions),
        signal,
        selectArtifact,
      );
      await check();
      return facts;
    }
  };
  return {
    async publicationTimes(
      name: string,
      versions: readonly string[],
      signal: AbortSignal,
      authorized: () => Promise<boolean>,
    ): Promise<{ versions: ReadonlySet<string>; times: ReadonlyMap<string, unknown> }> {
      if (
        name.length > 214 ||
        !npmName.test(name) ||
        versions.length > 5000 ||
        versions.some((version) => !/^[0-9A-Za-z.+_-]{1,128}$/u.test(version))
      )
        reject();
      const release = await acquireMetadataSlot(signal);
      try {
        const bounded = AbortSignal.any([
          signal,
          AbortSignal.timeout(PUBLICATION_LOOKUP_TIMEOUT_MS),
        ]);
        return await project(name, versions, bounded, authorized);
      } finally {
        release();
      }
    },
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
      npmPolicy?: NpmInstallPolicy,
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
        // npm replaces the default registry host in pre-existing lockfiles but
        // retains their ordinary tarball paths. Resolve those through metadata
        // just like content selectors; the path itself grants no upstream URL.
        const legacyNpm = /^npm\/((?:@[^/]+\/)?[^/]+)\/-\/([A-Za-z0-9._-]+\.tgz)$/u.exec(path);
        if (legacyNpm) path = `npm/${legacyNpm[1]!}`;
        let selected: Artifact | undefined;
        if (selector) {
          const name = Buffer.from(selector[2]!, 'base64url').toString('utf8');
          if (Buffer.from(name).toString('base64url') !== selector[2]) reject();
          if (selector[4]!.length !== (selector[3] === 'sha512' ? 128 : 64)) reject();
          path = selector[1] === 'npm' ? `npm/${name}` : `pypi/simple/${name}/`;
        }
        const select = (value: Artifact): void => {
          if (legacyNpm && new URL(value.url).pathname === `/${legacyNpm[1]!}/-/${legacyNpm[2]!}`)
            selected = value;
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
          if (selected.npmIdentity) {
            if (npmPolicy && !npmPolicy.packages.has(selected.npmIdentity)) reject(403);
            const eligibility = npmReleaseEligibility(
              selected.published,
              npmPolicy?.minimumAgeDays ?? 3,
            );
            if (!eligibility.availableAt) reject(409);
            if (!eligibility.eligible && !npmPolicy?.exceptions.has(selected.npmIdentity))
              reject(409);
          }
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
          if (selector || legacyNpm) {
            const metadata = await project(name, [], signal, authorized, (candidate) => {
              const value = npmArtifact(name, candidate.version, candidate.dist, undefined);
              if (!value) return false;
              return (
                !!(
                  legacyNpm &&
                  new URL(value.url).pathname === `/${legacyNpm[1]!}/-/${legacyNpm[2]!}`
                ) ||
                !!(
                  selector &&
                  selector[3] === value.algorithm &&
                  selector[4] === Buffer.from(value.digest, 'base64').toString('hex') &&
                  selector[5] === value.filename
                )
              );
            });
            if (!metadata.artifact) reject(404);
            const version = metadata.artifact.version;
            // JSON object order is not authority: time may precede versions.
            let publication = metadata.times;
            if (!publication.has(version)) {
              const refreshed = await project(name, [version], signal, authorized);
              if (!refreshed.versions.has(version)) reject(404);
              publication = refreshed.times;
            }
            selected = npmArtifact(name, version, metadata.artifact.dist, publication.get(version));
            return await download();
          }
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
          const times = record.safeParse(data.time);
          const rewritten: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
          for (const [version, raw] of Object.entries(versions)) {
            const manifest = record.parse(raw);
            const dist = record.parse(manifest.dist);
            // Old SHA1-only releases stay unavailable, rather than weakening integrity.
            const artifact = npmArtifact(
              name,
              version,
              dist,
              times.success ? times.data[version] : undefined,
            );
            if (!artifact) continue;
            select(artifact);
            rewritten[version] = {
              ...manifest,
              dist: {
                ...dist,
                tarball: selectorFor('npm', name, artifact, artifactBase),
              },
            };
          }
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
            .filter(
              (entry) =>
                entry.size <= ARTIFACT_LIMIT &&
                /^[A-Za-z0-9][A-Za-z0-9._+-]{0,239}\.(?:whl|tar\.gz|zip)$/u.test(entry.filename),
            )
            .map((entry) => {
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
