import * as artifacts from '../self-update/release-channel-artifact.js';
import { expect, it, vi } from 'vitest';
import type { BackupManifest } from './format.js';
import { createProbeReleaseCheck } from './probe-release.js';
import {
  OFFICIAL_CERTIFICATE_ISSUER,
  OFFICIAL_RELEASE_WORKFLOW_IDENTITY,
  OFFICIAL_SOURCE_REF,
  OFFICIAL_SOURCE_REPOSITORY,
  OFFICIAL_SOURCE_REPOSITORY_ID,
  type SignerIdentity,
} from '../self-update/release-channel-verify.js';
const REVISION = 'a'.repeat(40);

/** DER `UTF8String`, which is how Fulcio encodes the GitHub extensions. */
const der = (value: string): Uint8Array =>
  Uint8Array.from([0x0c, Buffer.byteLength(value), ...Buffer.from(value, 'utf8')]);

const oid = (id: string, value: string | Uint8Array) => ({
  oid: { id: id.split('.').map(Number) },
  value: typeof value === 'string' ? der(value) : value,
});

const identity = (overrides: Partial<SignerIdentity> = {}): SignerIdentity => ({
  subjectAlternativeName: OFFICIAL_RELEASE_WORKFLOW_IDENTITY,
  extensions: { issuer: OFFICIAL_CERTIFICATE_ISSUER },
  oids: [
    oid('1.3.6.1.4.1.57264.1.12', OFFICIAL_SOURCE_REPOSITORY),
    oid('1.3.6.1.4.1.57264.1.13', REVISION),
    oid('1.3.6.1.4.1.57264.1.14', OFFICIAL_SOURCE_REF),
    oid('1.3.6.1.4.1.57264.1.15', OFFICIAL_SOURCE_REPOSITORY_ID),
  ],
  ...overrides,
});

function fixture() {
  const manifest: BackupManifest = {
    format: 1,
    repository: 'test',
    sequence: 1,
    capturedAt: '2026-10-01T00:00:00Z',
    release: '1',
    schema: '2026_schema',
    files: [],
    capture: {
      startedAt: '2026-10-01T00:00:00Z',
      finishedAt: '2026-10-01T00:01:00Z',
      databaseAt: '2026-10-01T00:00:00Z',
      barrierMs: 1,
      sourceRoot: '/original',
      architecture: 'amd64',
      image: `ghcr.io/heey-global/verity/verity-server@sha256:${'a'.repeat(64)}`,
      scope: ['database', 'workspaces', 'sessions', 'knowledge', 'identity'],
      activeTurns: [],
      projects: [],
      exclusions: [],
      warnings: [],
      identity: [
        'deployment-id',
        'pairing-identity.pem',
        'tls-key.pem',
        'tls-cert.pem',
        'tls-ca-cert.pem',
      ],
      caKey: {
        installationId: '12345678-1234-4234-8234-123456789abc',
        keyGeneration: 1,
        path: 'identity/ca-key.age',
      },
      git: [],
    },
  };

  manifest.release = '1.0.0';
  const protocol = { min: 1, current: 1 };
  const metadata = {
    schemaVersion: 1,
    channel: 'stable',
    version: manifest.release,
    revision: REVISION,
    architecture: 'amd64',
    serverImage: manifest.capture!.image,
    agentSeedImage: null,
    compatibility: {
      serverVersion: manifest.release,
      schema: { min: manifest.schema, current: manifest.schema, max: manifest.schema },
      runner: protocol,
      eventLog: protocol,
      gateway: protocol,
      updater: protocol,
    },
    publishedAt: '2026-10-01T00:00:00Z',
    generation: 'stable-1.0.0',
  };
  const envelope = () => ({
    payload: Buffer.from(JSON.stringify(metadata)).toString('base64'),
    signature: { kind: 'sigstore-bundle', bundle: Buffer.from('{}').toString('base64') },
  });
  const verifyBundle = vi.fn(async () => ({ identity: identity() }));
  const options = {
    load: vi.fn<(image: string, signal: AbortSignal) => Promise<unknown>>(async () => envelope()),
    verification: { tufCachePath: '/tmp/unused', verifyBundle },
  };
  return { manifest, metadata, options, envelope, verifyBundle };
}
it('verifies the exact historical payload and binds it to the snapshot', async () => {
  const f = fixture();
  await createProbeReleaseCheck(f.options)(f.manifest, 'amd64');
  expect(f.options.load).toHaveBeenCalledWith(f.manifest.capture!.image, expect.any(AbortSignal));
  expect(f.verifyBundle).toHaveBeenCalledWith({}, Buffer.from(f.envelope().payload, 'base64'));
});
it.each(['digest', 'architecture', 'version', 'schema'] as const)(
  'rejects a valid signature for another %s',
  async (field) => {
    const f = fixture();
    if (field === 'digest')
      f.metadata.serverImage = f.metadata.serverImage.replace('a'.repeat(64), 'b'.repeat(64));
    if (field === 'architecture') f.metadata.architecture = 'arm64';
    if (field === 'version') {
      f.metadata.version = '2.0.0';
      f.metadata.compatibility.serverVersion = '2.0.0';
    }
    if (field === 'schema')
      f.metadata.compatibility.schema = { min: 'other', current: 'other', max: 'other' };
    await expect(createProbeReleaseCheck(f.options)(f.manifest, 'amd64')).rejects.toThrow(
      'does not match',
    );
  },
);
it('rejects malformed envelopes, invalid cryptography and foreign workflow signers', async () => {
  const f = fixture();
  f.options.load.mockResolvedValueOnce({});
  await expect(createProbeReleaseCheck(f.options)(f.manifest, 'amd64')).rejects.toThrow(
    'signature invalid',
  );
  expect(f.verifyBundle).not.toHaveBeenCalled();
  f.verifyBundle.mockRejectedValueOnce(new Error('bad signature'));
  await expect(createProbeReleaseCheck(f.options)(f.manifest, 'amd64')).rejects.toThrow(
    'signature invalid',
  );
  f.verifyBundle.mockResolvedValueOnce({
    identity: identity({ subjectAlternativeName: 'foreign' }),
  });
  await expect(createProbeReleaseCheck(f.options)(f.manifest, 'amd64')).rejects.toThrow(
    'signature invalid',
  );
});
it('rejects foreign host architecture before loading', async () => {
  const f = fixture();
  await expect(createProbeReleaseCheck(f.options)(f.manifest, 'arm64')).rejects.toThrow(
    'native image',
  );
  expect(f.options.load).not.toHaveBeenCalled();
});
it('bounds stalled loads and signature verification', async () => {
  const f = fixture();
  f.options.load.mockImplementationOnce(() => new Promise(() => {}));
  await expect(
    createProbeReleaseCheck({ ...f.options, timeoutMs: 10 })(f.manifest, 'amd64'),
  ).rejects.toThrow('timed out');
  expect(f.options.load.mock.calls[0]![1].aborted).toBe(true);
  f.verifyBundle.mockImplementationOnce(() => new Promise(() => {}));
  await expect(
    createProbeReleaseCheck({ ...f.options, timeoutMs: 10 })(f.manifest, 'amd64'),
  ).rejects.toThrow('timed out');
});
it('honors shutdown before and during loading', async () => {
  const f = fixture();
  await expect(
    createProbeReleaseCheck({ ...f.options, signal: AbortSignal.abort() })(f.manifest, 'amd64'),
  ).rejects.toThrow();
  expect(f.options.load).not.toHaveBeenCalled();
  const controller = new AbortController();
  f.options.load.mockImplementationOnce(async () => {
    controller.abort();
    return f.envelope();
  });
  await expect(
    createProbeReleaseCheck({ ...f.options, signal: controller.signal })(f.manifest, 'amd64'),
  ).rejects.toThrow();
  expect(f.verifyBundle).not.toHaveBeenCalled();
});

it('uses retained versioned release evidence by default', async () => {
  const f = fixture();
  const load = vi.fn(async () => f.envelope());
  const factory = vi.spyOn(artifacts, 'createReleaseChannelArtifactLoader').mockReturnValue(load);
  try {
    await createProbeReleaseCheck({ verification: f.options.verification })(f.manifest, 'amd64');
    expect(factory).toHaveBeenCalledWith({
      architecture: 'amd64',
      tag: `candidate-stable-v${f.manifest.release}-amd64`,
    });
    expect(load).toHaveBeenCalledOnce();
  } finally {
    factory.mockRestore();
  }
});
