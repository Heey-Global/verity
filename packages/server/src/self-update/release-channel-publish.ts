import { SERVER_COMPAT, type ServerCompat } from './compat.js';
import {
  isRfc3339Timestamp,
  OFFICIAL_SERVER_IMAGE,
  parseReleaseChannelMetadata,
  RELEASE_CHANNEL_SCHEMA_VERSION,
  type ReleaseArchitecture,
  type ReleaseChannelMetadata,
} from './release-channel.js';

interface ReleaseChannelPublishInput {
  /** Digest-pinned reference to the image this release publishes. */
  readonly serverImage: string;
  /** Full commit SHA the release was built from. */
  readonly revision: string;
  readonly architecture: ReleaseArchitecture;
  readonly publishedAt: string;
  /** The compatibility surface of the build being published. Always
   *  {@link SERVER_COMPAT} in production; a parameter so the renderer can be
   *  exercised against a stamped build without a stamped process. */
  readonly compatibility: ServerCompat;
}

/**
 * Render the channel document that release CI signs.
 *
 * This runs *inside the freshly built Server image* rather than in workflow YAML
 * so the advertised compatibility window is literally {@link SERVER_COMPAT} from
 * the shipped build. A hand-maintained copy in the workflow would be a second
 * source of truth for the one field whose whole purpose is to describe what the
 * image can coexist with, and it would drift silently.
 *
 * The returned string is the byte sequence that gets signed and published — the
 * signature covers exactly this, never a re-serialization.
 */
function renderReleaseChannelMetadata(input: ReleaseChannelPublishInput): string {
  const metadata: ReleaseChannelMetadata = {
    schemaVersion: RELEASE_CHANNEL_SCHEMA_VERSION,
    channel: 'stable',
    version: input.compatibility.serverVersion,
    revision: input.revision,
    architecture: input.architecture,
    serverImage: input.serverImage,
    // The agent seed ships inside the Server image today; there is no separately
    // published seed digest to advertise. See ReleaseChannelMetadata.
    agentSeedImage: null,
    compatibility: input.compatibility,
    publishedAt: input.publishedAt,
    generation: `stable-${input.compatibility.serverVersion}`,
  };
  const document = JSON.stringify(metadata);
  // Publish only what this build would itself accept. Without this, a release
  // could ship a document that every deployment silently refuses, and the first
  // symptom would be "no updates available" months later.
  if (parseReleaseChannelMetadata(JSON.parse(document)) === null) {
    throw new Error('rendered release channel document is not accepted by this Server build');
  }
  return document;
}

const ARCHITECTURES: readonly string[] = ['amd64', 'arm64'];

/**
 * `main.js release-channel-metadata` — the release-CI entrypoint. Reads the
 * release facts from the environment and writes the document to stdout.
 */
export function releaseChannelMetadataFromEnv(
  env: NodeJS.ProcessEnv,
  compatibility: ServerCompat = SERVER_COMPAT,
): string {
  const serverImage = env.VERITY_RELEASE_SERVER_IMAGE ?? '';
  const revision = env.VERITY_RELEASE_REVISION ?? '';
  const architecture = env.VERITY_RELEASE_ARCHITECTURE ?? '';
  const publishedAt = env.VERITY_RELEASE_PUBLISHED_AT ?? '';
  if (!serverImage.startsWith(`${OFFICIAL_SERVER_IMAGE}@sha256:`)) {
    throw new Error('VERITY_RELEASE_SERVER_IMAGE must be the official digest-pinned Server image');
  }
  if (!/^[a-f0-9]{40}$/.test(revision)) {
    throw new Error('VERITY_RELEASE_REVISION must be a full commit SHA');
  }
  if (!ARCHITECTURES.includes(architecture)) {
    throw new Error(`VERITY_RELEASE_ARCHITECTURE must be one of ${ARCHITECTURES.join(', ')}`);
  }
  if (!isRfc3339Timestamp(publishedAt)) {
    throw new Error('VERITY_RELEASE_PUBLISHED_AT must be an RFC 3339 timestamp');
  }
  // The image stamps its own version at build time (deploy/Dockerfile:
  // VERITY_SERVER_VERSION). An unstamped image cannot publish a release, and
  // saying so here is far clearer than the schema rejection it would otherwise
  // produce three lines later.
  if (compatibility.serverVersion === '0.0.0-dev') {
    throw new Error('this Server image was not stamped with a release version');
  }
  return renderReleaseChannelMetadata({
    serverImage,
    revision,
    architecture: architecture as ReleaseArchitecture,
    publishedAt,
    compatibility,
  });
}
