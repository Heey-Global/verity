import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isCompatible, parseServerCompat } from './self-update/compat.js';

type Docker = (args: string[]) => string;

const readCompatibility =
  "import { SERVER_COMPAT } from '/app/packages/server/dist/self-update/compat.js'; " +
  'process.stdout.write(JSON.stringify(SERVER_COMPAT));';

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
  const compatibilities = [previous, candidate].map((image) => {
    if (!image || image.startsWith('-')) throw new Error('Both Server images are required');
    const compatibility = parseServerCompat(
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
          readCompatibility,
        ]),
      ),
    );
    if (compatibility === null) throw new Error(`Invalid Server compatibility from ${image}`);
    return compatibility;
  });
  const result = isCompatible(compatibilities[0]!, compatibilities[1]!);
  if (!result.compatible) {
    throw new Error(
      `Release is not reachable through self-update (${previous} -> ${candidate}):\n` +
        result.reasons.join('\n') +
        '\nPrepare and verify a compatible bridge before publishing this transition.',
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
