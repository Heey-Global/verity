import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  createReleaseChannelArtifactLoader,
  RELEASE_CHANNEL_ARTIFACT_TYPE,
  releaseChannelTag,
  type RegistryFetch,
} from './release-channel-artifact.js';

const body = Buffer.from(JSON.stringify({ payload: 'x', signature: {} }), 'utf8');
const digestOf = (bytes: Buffer) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

const manifest = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 2,
  mediaType: 'application/vnd.oci.image.manifest.v1+json',
  artifactType: RELEASE_CHANNEL_ARTIFACT_TYPE,
  layers: [{ mediaType: 'application/json', digest: digestOf(body), size: body.byteLength }],
  ...overrides,
});

const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });

const registry = (
  manifestResponse: Response | (() => Response),
  blobResponse: Response | (() => Response) = () => new Response(body, { status: 200 }),
): RegistryFetch =>
  vi.fn(async (_registry: string, _repo: string, path: string) => {
    const pick = path.startsWith('manifests/') ? manifestResponse : blobResponse;
    return typeof pick === 'function' ? pick() : pick;
  });

const load = (fetchRegistry: RegistryFetch) =>
  createReleaseChannelArtifactLoader({ architecture: 'amd64', fetchRegistry })(
    new AbortController().signal,
  );

describe('createReleaseChannelArtifactLoader', () => {
  it('reads the stable channel envelope for the running architecture', async () => {
    const fetchRegistry = registry(() => json(manifest()));
    await expect(load(fetchRegistry)).resolves.toEqual({ payload: 'x', signature: {} });
    expect(fetchRegistry).toHaveBeenCalledWith(
      'ghcr.io',
      'heey-global/verity/verity-server',
      `manifests/${releaseChannelTag('amd64')}`,
      expect.objectContaining({ accept: 'application/vnd.oci.image.manifest.v1+json' }),
      expect.anything(),
    );
    expect(releaseChannelTag('arm64')).toBe('channel-stable-arm64');
  });

  it('refuses a manifest that is not a release channel artifact', async () => {
    await expect(
      load(
        registry(() =>
          json(manifest({ artifactType: 'application/vnd.oci.image.config.v1+json' })),
        ),
      ),
    ).rejects.toThrow(/unexpected artifact type/);
  });

  it('refuses a manifest that does not carry exactly one document', async () => {
    await expect(load(registry(() => json(manifest({ layers: [] }))))).rejects.toThrow(
      /exactly one layer/,
    );
    await expect(
      load(
        registry(() => json(manifest({ layers: [...manifest().layers, ...manifest().layers] }))),
      ),
    ).rejects.toThrow(/exactly one layer/);
  });

  it('refuses a descriptor with no digest or an implausible size', async () => {
    await expect(
      load(registry(() => json(manifest({ layers: [{ digest: 'md5:abc', size: 12 }] })))),
    ).rejects.toThrow(/sha256 digest/);
    await expect(
      load(
        registry(() =>
          json(manifest({ layers: [{ digest: digestOf(body), size: 4 * 1024 * 1024 }] })),
        ),
      ),
    ).rejects.toThrow(/implausible size/);
  });

  it('refuses a document whose bytes do not match the published digest', async () => {
    const tampered = Buffer.from(JSON.stringify({ payload: 'evil', signature: {} }), 'utf8');
    await expect(
      load(
        registry(
          () => json(manifest({ layers: [{ digest: digestOf(body), size: tampered.byteLength }] })),
          () => new Response(tampered, { status: 200 }),
        ),
      ),
    ).rejects.toThrow(/digest does not match/);
  });

  it('refuses a truncated document even before hashing it', async () => {
    await expect(
      load(
        registry(
          () => json(manifest()),
          () => new Response(body.subarray(0, 4), { status: 200 }),
        ),
      ),
    ).rejects.toThrow(/size does not match/);
  });

  it('stops reading a registry that streams without end', async () => {
    // No content-length, no `done`: buffering this response with `json()` or
    // `arrayBuffer()` would never return.
    const endless = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.enqueue(new Uint8Array(64 * 1024));
          },
        }),
        { status: 200 },
      );
    await expect(load(registry(endless))).rejects.toThrow(/manifest is larger than/);
    await expect(load(registry(() => json(manifest()), endless))).rejects.toThrow(
      /document is larger than/,
    );
  });

  it('refuses a body whose declared length already exceeds the budget', async () => {
    await expect(
      load(
        registry(
          () => json(manifest()),
          () =>
            new Response(body, {
              status: 200,
              headers: { 'content-length': String(4 * 1024 * 1024) },
            }),
        ),
      ),
    ).rejects.toThrow(/document is larger than/);
  });

  it('surfaces registry failures as errors the resolver can report', async () => {
    await expect(load(registry(() => new Response('', { status: 404 })))).rejects.toThrow(
      /manifest request failed: HTTP 404/,
    );
    await expect(
      load(
        registry(
          () => json(manifest()),
          () => new Response('', { status: 500 }),
        ),
      ),
    ).rejects.toThrow(/document request failed: HTTP 500/);
  });
});
