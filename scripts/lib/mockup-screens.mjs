// Finds the mockup screens of a spec in apps/mobile/mockups without loading the
// app: a screen is a `.tsx` file in the spec's folder with a default export,
// the same rule apps/mobile/__tests__/mockups.test.tsx holds the registry to.
// Helpers shared by the screens export only named members and are skipped.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_EXPORT = /^export default /m;

/**
 * @param {string} mockupsDir
 * @returns {string[]}
 */
export function listMockupSpecs(mockupsDir) {
  return readdirSync(mockupsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/**
 * @param {string} mockupsDir
 * @param {string} spec
 * @returns {string[]}
 */
export function listMockupScreens(mockupsDir, spec) {
  const dir = join(mockupsDir, spec);
  if (!/^[a-z0-9-]+$/.test(spec) || !existsSync(dir) || !statSync(dir).isDirectory())
    throw new Error(
      `Unknown mockup spec '${spec}'. Known: ${listMockupSpecs(mockupsDir).join(', ')}`,
    );
  return readdirSync(dir)
    .filter((file) => file.endsWith('.tsx') && !file.endsWith('.test.tsx'))
    .filter((file) => DEFAULT_EXPORT.test(readFileSync(join(dir, file), 'utf8')))
    .map((file) => file.replace(/\.tsx$/, ''))
    .sort();
}
