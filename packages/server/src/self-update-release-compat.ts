import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseServerCompat } from './self-update/compat.js';

type Docker = (args: string[]) => string;

const readCompatibility =
  "import { SERVER_COMPAT } from '/app/packages/server/dist/self-update/compat.js'; " +
  'process.stdout.write(JSON.stringify(SERVER_COMPAT));';

/** Run the shipped discovery policy: candidate code cannot certify an older client's admission. */
export function releaseDiscoveryProbe(
  compatibility: NonNullable<ReturnType<typeof parseServerCompat>>,
): string {
  return `
import { SERVER_COMPAT } from '/app/packages/server/dist/self-update/compat.js';
import { createReleaseChannelResolver } from '/app/packages/server/dist/self-update/release-channel.js';
const compatibility = ${JSON.stringify(compatibility)};
const metadata = {
  schemaVersion: 1, channel: 'stable', version: compatibility.serverVersion,
  revision: 'a'.repeat(40), architecture: 'amd64',
  serverImage: 'ghcr.io/heey-global/verity/verity-server@sha256:' + 'b'.repeat(64),
  agentSeedImage: null, compatibility, publishedAt: '2026-01-01T00:00:00Z', generation: 'release-probe',
};
// Artifact signatures are verified by publication; this offline probe isolates admission policy.
const resolver = createReleaseChannelResolver({
  managed: true, current: SERVER_COMPAT, architecture: 'amd64',
  load: async () => ({ payload: Buffer.from(JSON.stringify(metadata)).toString('base64'),
    signature: { kind: 'sigstore-bundle', bundle: Buffer.from('probe').toString('base64') } }),
  verify: async () => true,
});
process.stdout.write(JSON.stringify(await resolver.resolve()));
`;
}

/** The smoke's direct preparation path bypasses the discovery gate used by clients. */
export function checkReleaseImages(
  previous: string,
  candidate: string,
  docker: Docker = (args) =>
    execFileSync('docker', args, {
      encoding: 'utf8',
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
): void {
  for (const image of [previous, candidate]) {
    if (!image || image.startsWith('-')) throw new Error('Both Server images are required');
  }
  const probe = (image: string, source: string): unknown =>
    JSON.parse(
      docker([
        'run',
        '--rm',
        '--network',
        'none',
        '--read-only',
        '--entrypoint',
        'node',
        image,
        '--input-type=module',
        '--eval',
        source,
      ]),
    );
  const compatibility = parseServerCompat(probe(candidate, readCompatibility));
  if (compatibility === null) throw new Error(`Invalid Server compatibility from ${candidate}`);
  const result = probe(previous, releaseDiscoveryProbe(compatibility)) as {
    state?: string;
    reasons?: string[];
    reason?: string;
  } | null;
  if (result?.state !== 'available') {
    throw new Error(
      `Release is not reachable through self-update (${previous} -> ${candidate}):\n` +
        (result?.reasons?.join('\n') ?? result?.reason ?? `discovery returned ${result?.state}`),
    );
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    checkReleaseImages(process.argv[2] ?? '', process.argv[3] ?? '');
    process.stdout.write('Released predecessor and candidate are self-update compatible.\n');
  } catch (error) {
    console.error(String(error));
    process.exitCode = 1;
  }
}
