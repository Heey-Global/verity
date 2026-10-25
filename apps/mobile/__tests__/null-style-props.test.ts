// No component receives `null` as its whole style prop.
//
// The Unistyles Babel plugin swaps React Native's components for its own, and
// the native Pressable reads `Object.keys(style)` behind a default parameter
// that only covers `undefined`. A conditional `style={cond ? styles.x : null}`
// therefore throws "Cannot convert null value to object" the moment the
// condition is false — on iOS and Android only. The web build ships a
// different Pressable, and Jest renders React Native's own, so the tree stays
// green while the app aborts on a device. Use `undefined` for "no style", or
// keep the null inside an array, which Unistyles flattens safely.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const MOBILE_ROOT = join(__dirname, '..');

/** Every `.tsx` below `dir`. Throws rather than returning nothing if the
 *  directory moved: an empty scan would pass while guarding no files at all. */
function tsxFilesIn(dir: string): string[] {
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`sources are no longer at ${relative(MOBILE_ROOT, dir)}`);
  }
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return tsxFilesIn(path);
    return entry.isFile() && entry.name.endsWith('.tsx') ? [path] : [];
  });
}

// A style expression without nested braces or brackets whose top-level value
// can be `null`: `style={null}` or `style={a ? b : null}`.
const NULL_STYLE = /\bstyle=\{(?:null|[^{}[\]]*:\s*null)\s*\}/g;

it('never passes null as a whole style prop', () => {
  const offenders = ['app', 'components'].flatMap((dir) =>
    tsxFilesIn(join(MOBILE_ROOT, dir)).flatMap((file) =>
      [...readFileSync(file, 'utf8').matchAll(NULL_STYLE)].map(
        (match) => `${relative(MOBILE_ROOT, file)}: ${match[0]}`,
      ),
    ),
  );
  expect(offenders).toEqual([]);
});
