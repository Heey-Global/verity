import { readFileSync } from 'node:fs';

const SCHEMA_FORWARD_MAX_STAMP = '/app/.verity-schema-forward-max';
const MIGRATION_KEY = /^\d{4}_[a-z0-9_]+$/;

/**
 * Read a release-controlled forward-compatibility promise baked into the image.
 * Most builds omit it and advertise only their current generation. A bridge
 * release may name a later additive generation after that exact transition has
 * been reviewed, without allowing deployment environment to widen the promise.
 */
export function runtimeSchemaForwardMax(
  current: string,
  readStamp: (path: string) => string = (path) => readFileSync(path, 'utf8'),
): string {
  let stamped: string;
  try {
    stamped = readStamp(SCHEMA_FORWARD_MAX_STAMP).trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return current;
    throw error;
  }
  if (!MIGRATION_KEY.test(stamped) || stamped < current)
    throw new Error('Verity Server image carries an invalid schema forward-compatibility stamp');
  return stamped;
}
