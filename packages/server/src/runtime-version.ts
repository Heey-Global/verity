import { readFileSync } from 'node:fs';

const DEV_VERSION_SENTINEL = '0.0.0-dev';
export const SERVER_VERSION_STAMP = '/app/.verity-server-version';

const RELEASE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/**
 * Read the immutable version baked into the Server image.
 *
 * Managed self-update candidates inherit selected environment from the sealed
 * deployment. An outgoing VERITY_SERVER_VERSION can therefore outlive its image;
 * the stamp cannot be overridden when Docker creates the next generation.
 * Development builds have no stamp and retain the environment fallback.
 */
export function runtimeServerVersion(
  readStamp: (path: string) => string = (path) => readFileSync(path, 'utf8'),
  environment: NodeJS.ProcessEnv = process.env,
): string {
  let stamped: string;
  try {
    stamped = readStamp(SERVER_VERSION_STAMP).trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return environment.VERITY_SERVER_VERSION ?? DEV_VERSION_SENTINEL;
  }
  if (!RELEASE_VERSION.test(stamped)) {
    throw new Error('Verity Server image carries an invalid version stamp');
  }
  return stamped;
}
