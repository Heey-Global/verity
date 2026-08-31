import { describe, expect, it, vi } from 'vitest';
import { createReleaseChannelResolver, parseSignedReleaseChannel } from './release-channel.js';
import type { ServerCompat } from './compat.js';

const digest = (character: string): string => `sha256:${character.repeat(64)}`;
const compat = (version: string): ServerCompat => ({
  serverVersion: version,
  schema: { min: '0040', current: '0041', max: '0042' },
  runner: { min: 1, current: 1 },
  eventLog: { min: 1, current: 1 },
  gateway: { min: 1, current: 1 },
  updater: { min: 1, current: 1 },
});
const metadata = (version = '2.0.0'): Record<string, unknown> => ({
  schemaVersion: 1,
  channel: 'stable',
  version,
  revision: 'a'.repeat(40),
  architecture: 'amd64',
  serverImage: `ghcr.io/heey-global/verity/verity-server@${digest('b')}`,
  agentSeedImage: `ghcr.io/heey-global/verity/verity-agent-seed@${digest('c')}`,
  compatibility: compat(version),
  publishedAt: '2026-08-09T10:00:00.000Z',
  generation: `stable-${version}`,
});

const envelope = (body: Record<string, unknown> = metadata()) => ({
  payload: Buffer.from(JSON.stringify(body), 'utf8').toString('base64'),
  signature: { kind: 'sigstore-bundle', bundle: Buffer.from('bundle').toString('base64') },
});
const channel = (version = '2.0.0') => envelope(metadata(version));

describe('parseSignedReleaseChannel', () => {
  it('accepts the exact official digest-pinned stable contract', () => {
    expect(parseSignedReleaseChannel(channel())?.metadata.version).toBe('2.0.0');
  });

  it('hands back the exact published bytes as the signed payload', () => {
    const body = metadata();
    const published = JSON.stringify(body);
    const parsed = parseSignedReleaseChannel(envelope(body));
    expect(Buffer.from(parsed?.payload ?? new Uint8Array()).toString('utf8')).toBe(published);
  });

  it('rejects mutable, foreign, mismatched, and extended metadata', () => {
    expect(
      parseSignedReleaseChannel(envelope({ ...metadata(), serverImage: 'verity-server:latest' })),
    ).toBeNull();
    expect(
      parseSignedReleaseChannel(
        envelope({
          ...metadata(),
          serverImage: `ghcrXio/heey-global/verity/verity-server@${digest('b')}`,
        }),
      ),
    ).toBeNull();
    expect(
      parseSignedReleaseChannel(
        envelope({ ...metadata(), version: '2.0.0', compatibility: compat('2.0.1') }),
      ),
    ).toBeNull();
    expect(parseSignedReleaseChannel(envelope({ ...metadata(), extra: true }))).toBeNull();
    expect(parseSignedReleaseChannel({ ...channel(), extra: true })).toBeNull();
  });

  it('accepts a release whose seed still ships inside the Server image', () => {
    const parsed = parseSignedReleaseChannel(envelope({ ...metadata(), agentSeedImage: null }));
    expect(parsed?.metadata.agentSeedImage).toBeNull();
    expect(
      parseSignedReleaseChannel(envelope({ ...metadata(), agentSeedImage: 'verity-seed:latest' })),
    ).toBeNull();
  });

  it('rejects an envelope whose payload or bundle is not canonical base64', () => {
    const body = Buffer.from(JSON.stringify(metadata()), 'utf8').toString('base64');
    expect(
      parseSignedReleaseChannel({ ...channel(), payload: `${body.slice(0, -1)}.` }),
    ).toBeNull();
    // Buffer.from would silently discard the stray character and decode the
    // same bytes, so a lenient parser would treat two spellings as one document.
    expect(parseSignedReleaseChannel({ ...channel(), payload: `${body}\n` })).toBeNull();
    expect(parseSignedReleaseChannel({ ...channel(), payload: 'not json at all!' })).toBeNull();
    expect(
      parseSignedReleaseChannel({
        ...channel(),
        signature: { kind: 'sigstore-bundle', bundle: '' },
      }),
    ).toBeNull();
    expect(
      parseSignedReleaseChannel({
        ...channel(),
        signature: { kind: 'pgp', bundle: Buffer.from('bundle').toString('base64') },
      }),
    ).toBeNull();
  });

  it('rejects extended or invalid compatibility ranges', () => {
    expect(
      parseSignedReleaseChannel(
        envelope({
          ...metadata(),
          compatibility: { ...compat('2.0.0'), runner: { min: 1, current: 1, extra: 1 } },
        }),
      ),
    ).toBeNull();
    expect(
      parseSignedReleaseChannel(
        envelope({
          ...metadata(),
          compatibility: {
            ...compat('2.0.0'),
            schema: { min: '0042', current: '0041', max: '0043' },
          },
        }),
      ),
    ).toBeNull();
    expect(
      parseSignedReleaseChannel(
        envelope({
          ...metadata(),
          compatibility: { ...compat('2.0.0'), gateway: { min: 0, current: 0 } },
        }),
      ),
    ).toBeNull();
  });
});

describe('createReleaseChannelResolver', () => {
  const resolver = (overrides: Record<string, unknown> = {}) =>
    createReleaseChannelResolver({
      managed: true,
      current: compat('1.0.0'),
      architecture: 'amd64',
      load: vi.fn(async () => channel()),
      verify: vi.fn(async () => true),
      ...overrides,
    });

  it('does not contact the channel for an unmanaged deployment', async () => {
    const load = vi.fn();
    await expect(resolver({ managed: false, load }).resolve()).resolves.toMatchObject({
      state: 'unsupported',
    });
    expect(load).not.toHaveBeenCalled();
  });

  it('returns available only after signature and compatibility verification', async () => {
    await expect(resolver().resolve()).resolves.toMatchObject({
      state: 'available',
      release: { version: '2.0.0' },
    });
  });

  it('reports the stable channel as current when it is not newer', async () => {
    const load = vi.fn(async () => channel('1.0.0'));
    await expect(resolver({ load }).resolve()).resolves.toMatchObject({ state: 'current' });
  });

  it('reports architecture and protocol mismatches as incompatible', async () => {
    await expect(
      resolver({
        load: vi.fn(async () => envelope({ ...metadata(), architecture: 'arm64' })),
      }).resolve(),
    ).resolves.toMatchObject({ state: 'incompatible', reasons: [expect.stringMatching(/amd64/)] });

    await expect(
      resolver({
        load: vi.fn(async () =>
          envelope({
            ...metadata(),
            compatibility: { ...compat('2.0.0'), runner: { min: 2, current: 2 } },
          }),
        ),
      }).resolve(),
    ).resolves.toMatchObject({
      state: 'incompatible',
      reasons: [expect.stringMatching(/runner protocol mismatch/)],
    });
  });

  it('fails closed on an invalid signature', async () => {
    await expect(resolver({ verify: vi.fn(async () => false) }).resolve()).resolves.toMatchObject({
      state: 'unreachable',
      reason: 'release channel signature is invalid',
    });
  });

  it('times out a stalled signature verifier and allows a later lookup', async () => {
    const verify = vi
      .fn()
      .mockImplementationOnce(() => new Promise<boolean>(() => undefined))
      .mockResolvedValueOnce(true);
    const subject = resolver({ verify, timeoutMs: 10, cacheTtlMs: 0 });

    await expect(subject.resolve()).resolves.toMatchObject({
      state: 'unreachable',
      reason: 'release channel lookup timed out after 10ms',
    });
    await expect(subject.resolve()).resolves.toMatchObject({ state: 'available' });
    expect(verify).toHaveBeenCalledTimes(2);
  });

  it('times out when the load ignores the abort signal', async () => {
    const load = vi.fn(() => new Promise<unknown>(() => undefined));
    await expect(resolver({ load, timeoutMs: 10 }).resolve()).resolves.toMatchObject({
      state: 'unreachable',
      reason: 'release channel lookup timed out after 10ms',
    });
  });

  it('does not let a verifier that completes after timeout mutate last-good state', async () => {
    let finishVerification: ((verified: boolean) => void) | undefined;
    const verify = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finishVerification = resolve;
        }),
    );
    const load = vi
      .fn()
      .mockResolvedValueOnce(channel())
      .mockRejectedValueOnce(new Error('offline'));
    const subject = resolver({ load, verify, timeoutMs: 10, cacheTtlMs: 0 });

    await expect(subject.resolve()).resolves.toMatchObject({
      state: 'unreachable',
      lastGood: null,
    });
    finishVerification?.(true);
    await Promise.resolve();
    await expect(subject.resolve()).resolves.toMatchObject({
      state: 'unreachable',
      reason: 'offline',
      lastGood: null,
    });
  });

  it('caches lookups and exposes the last verified release after a later outage', async () => {
    let time = 0;
    const load = vi
      .fn()
      .mockResolvedValueOnce(channel())
      .mockRejectedValueOnce(new Error('offline'));
    const subject = resolver({ load, now: () => time, cacheTtlMs: 10 });
    await expect(subject.resolve()).resolves.toMatchObject({ state: 'available' });
    await expect(subject.resolve()).resolves.toMatchObject({ state: 'available' });
    expect(load).toHaveBeenCalledTimes(1);
    time = 11;
    await expect(subject.resolve()).resolves.toMatchObject({
      state: 'unreachable',
      lastGood: { version: '2.0.0' },
    });
  });

  it('tracks a valid incompatible newer release for rollback protection', async () => {
    let time = 0;
    const incompatible = envelope({ ...metadata('3.0.0'), architecture: 'arm64' });
    const load = vi
      .fn()
      .mockResolvedValueOnce(incompatible)
      .mockResolvedValueOnce(channel('2.0.0'));
    const subject = resolver({ load, now: () => time, cacheTtlMs: 0 });
    await expect(subject.resolve()).resolves.toMatchObject({ state: 'incompatible' });
    time = 1;
    await expect(subject.resolve()).resolves.toMatchObject({
      state: 'unreachable',
      reason: expect.stringMatching(/rolled back/),
      lastGood: { version: '3.0.0' },
    });
  });

  it('retries transient channel failures before the successful-result cache expires', async () => {
    let time = 0;
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(channel());
    const subject = resolver({
      load,
      now: () => time,
      cacheTtlMs: 60_000,
      failureCacheTtlMs: 10,
    });

    await expect(subject.resolve()).resolves.toMatchObject({ state: 'unreachable' });
    time = 9;
    await expect(subject.resolve()).resolves.toMatchObject({ state: 'unreachable' });
    expect(load).toHaveBeenCalledTimes(1);
    time = 10;
    await expect(subject.resolve()).resolves.toMatchObject({ state: 'available' });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('coalesces concurrent lookups', async () => {
    const load = vi.fn(async () => channel());
    const subject = resolver({ load });
    await Promise.all([subject.resolve(), subject.resolve()]);
    expect(load).toHaveBeenCalledTimes(1);
  });
});
