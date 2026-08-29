import { describe, expect, it } from 'vitest';
import { releaseChannelMetadataFromEnv } from './release-channel-publish.js';
import { parseReleaseChannelMetadata } from './release-channel.js';
import { SERVER_COMPAT } from './compat.js';

/** The shipped surface as a stamped image carries it — tests run unstamped. */
const stamped = { ...SERVER_COMPAT, serverVersion: '10.5.0' };

const env = (overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  VERITY_RELEASE_SERVER_IMAGE: `ghcr.io/heey-global/verity/verity-server@sha256:${'b'.repeat(64)}`,
  VERITY_RELEASE_REVISION: 'a'.repeat(40),
  VERITY_RELEASE_ARCHITECTURE: 'amd64',
  VERITY_RELEASE_PUBLISHED_AT: '2026-08-10T10:00:00.000Z',
  ...overrides,
});

describe('releaseChannelMetadataFromEnv', () => {
  it('renders a document this build would itself accept', () => {
    const document = releaseChannelMetadataFromEnv(env(), stamped);
    const parsed = parseReleaseChannelMetadata(JSON.parse(document));
    expect(parsed).not.toBeNull();
    expect(parsed?.compatibility).toEqual(stamped);
    expect(parsed?.version).toBe('10.5.0');
    expect(parsed?.generation).toBe('stable-10.5.0');
    // The seed still ships inside the Server image, so there is no seed digest
    // to advertise and none may be invented.
    expect(parsed?.agentSeedImage).toBeNull();
  });

  it('advertises the compatibility window of the shipped build, not a copy of it', () => {
    const parsed = parseReleaseChannelMetadata(
      JSON.parse(releaseChannelMetadataFromEnv(env(), stamped)),
    );
    expect(parsed?.compatibility.schema).toEqual(SERVER_COMPAT.schema);
    expect(parsed?.compatibility.runner).toEqual(SERVER_COMPAT.runner);
  });

  it('refuses release facts that are missing or not what they claim to be', () => {
    expect(() =>
      releaseChannelMetadataFromEnv(
        env({ VERITY_RELEASE_SERVER_IMAGE: 'verity-server:latest' }),
        stamped,
      ),
    ).toThrow(/digest-pinned Server image/);
    expect(() =>
      releaseChannelMetadataFromEnv(env({ VERITY_RELEASE_REVISION: 'abc1234' }), stamped),
    ).toThrow(/full commit SHA/);
    expect(() =>
      releaseChannelMetadataFromEnv(env({ VERITY_RELEASE_ARCHITECTURE: 'riscv64' }), stamped),
    ).toThrow(/amd64, arm64/);
    expect(() =>
      releaseChannelMetadataFromEnv(env({ VERITY_RELEASE_PUBLISHED_AT: 'yesterday' }), stamped),
    ).toThrow(/RFC 3339/);
  });

  it('refuses to publish from an image that was never stamped with a version', () => {
    expect(() =>
      releaseChannelMetadataFromEnv(env(), {
        ...SERVER_COMPAT,
        serverVersion: '0.0.0-dev',
      }),
    ).toThrow(/not stamped with a release version/);
  });
});
