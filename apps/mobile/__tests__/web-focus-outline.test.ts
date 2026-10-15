// Chromium draws the focus ring of a text field as `outline-style: auto`, and an
// auto outline ignores `outline-width`. `outlineWidth: 0` therefore looks like
// it removes the ring, passes review and every test, and the browser still
// draws a blue (or white) frame around the field. Only `outlineStyle: 'none'`
// removes it; apps/mobile/lib/webFocusRing.ts holds that style.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const MOBILE_ROOT = join(__dirname, '..');

/** Every non-test `.ts`/`.tsx` below `dir`; throws if the directory moved, since
 *  an empty scan would guard nothing. */
function sourcesIn(dir: string): string[] {
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`sources are no longer at ${relative(MOBILE_ROOT, dir)}`);
  }
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourcesIn(path);
    return entry.isFile() && /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)
      ? [path]
      : [];
  });
}

it('hides browser focus rings with outlineStyle, not outlineWidth', () => {
  const sources = ['app', 'components', 'lib'].flatMap((dir) => sourcesIn(join(MOBILE_ROOT, dir)));
  const offenders = sources
    .filter((file) => /\boutlineWidth:\s*0\b/.test(readFileSync(file, 'utf8')))
    .map((file) => relative(MOBILE_ROOT, file));
  expect(offenders).toEqual([]);
});
