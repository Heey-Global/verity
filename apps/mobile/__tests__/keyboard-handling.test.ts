// App-wide keyboard handling.
//
// Every keyboard-aware view in the app comes from react-native-keyboard-
// controller, and all of them read one React context that the root layout
// mounts. Both failures guarded here are silent: without the provider the
// library's components still render, still lay out, and simply never move for
// the keyboard; and React Native's own KeyboardAvoidingView renders happily
// inside a Modal while doing nothing at all, because a Modal is a separate host
// view its native measurements never reach into. Neither shows up until someone
// focuses a field on a device.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const MOBILE_ROOT = join(__dirname, '..');
const ROOT_LAYOUT = join(MOBILE_ROOT, 'app', '_layout.tsx');

/** Every `.tsx` below `dir`. Throws rather than returning nothing if the
 *  directory moved: an empty scan would pass every assertion below while
 *  guarding no files at all. */
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

/** What a source pulls out of `react-native` itself, with type-only specifiers
 *  dropped — `import type { KeyboardAvoidingViewProps }` costs nothing.
 *
 *  The clause cannot contain a `;`, which keeps a match inside one statement:
 *  spanning them would let the neighbouring
 *  `import { KeyboardAvoidingView } from 'react-native-keyboard-controller';`
 *  — the very thing this file asks for — be read as a react-native import. */
function reactNativeBindings(source: string): string {
  return [...source.matchAll(/^\s*import\s+(?!type\b)([^;]*?)\sfrom\s+'react-native';/gm)]
    .map(([, clause]) => clause.replace(/\btype\s+\w+/g, ''))
    .join('\n');
}

describe('keyboard handling', () => {
  it('mounts the keyboard provider around the navigator', () => {
    const layout = readFileSync(ROOT_LAYOUT, 'utf8');

    expect(layout).toMatch(
      /^\s*import\s*\{[^}]*\bKeyboardProvider\b[^}]*\}\s*from\s*'react-native-keyboard-controller';/m,
    );

    // Around the navigator, not beside it: a provider that does not enclose the
    // screens leaves every keyboard-aware view in the app reading a default
    // context — rendering normally and never following the keyboard.
    // Matched without the closing angle bracket so adding a prop (the Android
    // translucency flags, say) does not fail this for the wrong reason.
    const opened = layout.indexOf('<KeyboardProvider');
    const navigator = layout.indexOf('<Stack');
    const closed = layout.indexOf('</KeyboardProvider>');
    expect(opened).toBeGreaterThanOrEqual(0);
    expect(navigator).toBeGreaterThan(opened);
    expect(closed).toBeGreaterThan(navigator);
  });

  it('avoids the keyboard through the controller, never React Native directly', () => {
    const sources = [
      ...tsxFilesIn(join(MOBILE_ROOT, 'app')),
      ...tsxFilesIn(join(MOBILE_ROOT, 'components')),
    ].filter((file) => !file.endsWith('.test.tsx'));
    expect(sources.length).toBeGreaterThan(0);

    const rnAvoiders = sources
      .filter((file) =>
        /\bKeyboardAvoidingView\b/.test(reactNativeBindings(readFileSync(file, 'utf8'))),
      )
      .map((file) => relative(MOBILE_ROOT, file));

    // React Native's version is a drop-in match for the controller's, so this
    // swap is invisible in review and in the simulator's non-modal screens —
    // and dead inside every sheet the app puts a field in.
    expect(rnAvoiders).toEqual([]);
  });
});
