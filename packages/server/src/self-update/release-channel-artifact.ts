import { createHash } from 'node:crypto';
import { registryFetch } from '../oci-ref.js';
import type { ReleaseArchitecture } from './release-channel.js';

/**
 * The signed channel document is published as an OCI artifact on the Server's
 * own public package rather than as a release asset or a raw file in the
 * repository: the Verity repository is private, so both of those would need a
 * credential the deployment does not have, while ghcr serves this package
 * anonymously — the same path the Server already uses to resolve its sibling
 * images.
 */
export const RELEASE_CHANNEL_ARTIFACT_TYPE = 'application/vnd.verity.release-channel.v1+json';
const RELEASE_CHANNEL_REGISTRY = 'ghcr.io';
const RELEASE_CHANNEL_REPOSITORY = 'heey-global/verity/verity-server';

export const releaseChannelTag = (architecture: ReleaseArchitecture): string =>
  `channel-stable-${architecture}`;

const MANIFEST_MEDIA_TYPE = 'application/vnd.oci.image.manifest.v1+json';
/** Generous next to the envelope's own 16 KiB / 128 KiB member caps, but low
 *  enough that a hostile or broken registry cannot stream the Server out of
 *  memory before a single byte has been authenticated. */
const MAX_DOCUMENT_BYTES = 512 * 1024;
/** An artifact manifest is a handful of descriptors. */
const MAX_MANIFEST_BYTES = 64 * 1024;
const DIGEST = /^sha256:[a-f0-9]{64}$/;

/**
 * Read a response body under a hard byte budget.
 *
 * `json()` and `arrayBuffer()` buffer whatever the peer sends, so a registry
 * that answers a 200 with an endless stream would exhaust the Server before any
 * of the checks below ever ran. The declared `content-length` is only a hint —
 * it is checked first because it is cheap, and then the stream is capped anyway.
 */
async function readCapped(response: Response, maxBytes: number, what: string): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`release channel ${what} is larger than ${maxBytes} bytes`);
  }
  // `Response.body` is typed as an untyped stream by the platform lib; the web
  // standard guarantees Uint8Array chunks.
  const body = response.body as ReadableStream<Uint8Array> | null;
  if (body === null) throw new Error(`release channel ${what} response had no body`);
  const chunks: Buffer[] = [];
  let total = 0;
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new Error(`release channel ${what} is larger than ${maxBytes} bytes`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks, total);
}

export type RegistryFetch = (
  registry: string,
  repo: string,
  path: string,
  headers: Record<string, string>,
  signal: AbortSignal,
) => Promise<Response>;

export interface ReleaseChannelArtifactOptions {
  readonly architecture: ReleaseArchitecture;
  readonly fetchRegistry?: RegistryFetch;
  readonly registry?: string;
  readonly repository?: string;
}

interface ArtifactManifest {
  readonly artifactType?: unknown;
  readonly layers?: unknown;
}

function readLayerDescriptor(manifest: unknown): { digest: string; size: number } {
  const document = manifest as ArtifactManifest;
  if (document.artifactType !== RELEASE_CHANNEL_ARTIFACT_TYPE) {
    throw new Error('release channel artifact has an unexpected artifact type');
  }
  const layers = document.layers;
  if (!Array.isArray(layers) || layers.length !== 1) {
    throw new Error('release channel artifact must carry exactly one layer');
  }
  const layer = layers[0] as { digest?: unknown; size?: unknown };
  if (typeof layer.digest !== 'string' || !DIGEST.test(layer.digest)) {
    throw new Error('release channel artifact layer has no sha256 digest');
  }
  if (
    typeof layer.size !== 'number' ||
    !Number.isSafeInteger(layer.size) ||
    layer.size <= 0 ||
    layer.size > MAX_DOCUMENT_BYTES
  ) {
    throw new Error('release channel artifact layer has an implausible size');
  }
  return { digest: layer.digest, size: layer.size };
}

/**
 * Load the published channel envelope from ghcr.
 *
 * Nothing here is trusted: the blob is checked against the digest the manifest
 * named, and the envelope it contains is checked against the release signature
 * afterwards. The digest check is not a security boundary on its own — the
 * manifest comes from the same host as the blob — but it turns a truncated or
 * corrupted transfer into a clean failure rather than a parse error.
 */
export function createReleaseChannelArtifactLoader(
  options: ReleaseChannelArtifactOptions,
): (signal: AbortSignal) => Promise<unknown> {
  const fetchRegistry = options.fetchRegistry ?? registryFetch;
  const registry = options.registry ?? RELEASE_CHANNEL_REGISTRY;
  const repository = options.repository ?? RELEASE_CHANNEL_REPOSITORY;
  const tag = releaseChannelTag(options.architecture);

  return async (signal) => {
    const manifestResponse = await fetchRegistry(
      registry,
      repository,
      `manifests/${tag}`,
      { accept: MANIFEST_MEDIA_TYPE },
      signal,
    );
    if (!manifestResponse.ok) {
      throw new Error(`release channel manifest request failed: HTTP ${manifestResponse.status}`);
    }
    const manifest: unknown = JSON.parse(
      (await readCapped(manifestResponse, MAX_MANIFEST_BYTES, 'manifest')).toString('utf8'),
    );
    const { digest, size } = readLayerDescriptor(manifest);

    const blobResponse = await fetchRegistry(
      registry,
      repository,
      `blobs/${digest}`,
      { accept: 'application/json' },
      signal,
    );
    if (!blobResponse.ok) {
      throw new Error(`release channel document request failed: HTTP ${blobResponse.status}`);
    }
    // Capped at the size the manifest declared, not at the global maximum: the
    // descriptor has already been validated, so anything longer is a mismatch
    // there is no reason to keep reading.
    const body = await readCapped(blobResponse, size, 'document');
    if (body.byteLength !== size) {
      throw new Error('release channel document size does not match the published descriptor');
    }
    if (`sha256:${createHash('sha256').update(body).digest('hex')}` !== digest) {
      throw new Error('release channel document digest does not match the published descriptor');
    }
    return JSON.parse(body.toString('utf8')) as unknown;
  };
}
