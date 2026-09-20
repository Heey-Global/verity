// Reaching the settings fields while the keyboard is open.
//
// Settings is where the operator types credentials they can never re-read: the
// paste boxes are write-only, so a subscription key typed under the keyboard is
// not shown back anywhere. A plain ScrollView keeps its full height when the
// keyboard opens — the keyboard just covers the bottom of it, and the last
// group on a screen (Public Preview, on connected services) becomes unreachable
// with nothing to scroll into. Both tests here guard that: the scaffold scrolls
// a focused field clear of the keyboard, and no settings screen scrolls through
// anything else.
import { render, screen } from '@testing-library/react-native';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ScrollView, Text } from 'react-native';

jest.mock('expo-router', () => require('./support/settingsHarness').expoRouterMock());

import { SettingsScaffold } from '../components/settings/SettingsChrome';
import { KEYBOARD_BOTTOM_OFFSET } from '../lib/keyboardOffsets';
import { resetSettingsHarness } from './support/settingsHarness';

afterEach(() => resetSettingsHarness());

const MOBILE_ROOT = join(__dirname, '..');
/** The scaffold is the sanctioned scroll container — the one the first test
 *  pins. Every other settings source has to go through it. */
const SCAFFOLD = join(MOBILE_ROOT, 'components', 'settings', 'SettingsChrome.tsx');

/** Every `.tsx` below `dir`, read off disk so a screen or panel added later is
 *  covered without being listed here. Throws rather than returning nothing if
 *  the directory moved: an empty scan would pass the assertion below while
 *  guarding no files at all. */
function tsxFilesIn(dir: string): string[] {
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`settings sources are no longer at ${relative(MOBILE_ROOT, dir)}`);
  }
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return tsxFilesIn(path);
    return entry.isFile() && entry.name.endsWith('.tsx') ? [path] : [];
  });
}

/**
 * Whether a source mounts a scrolling container of its own.
 *
 * Matched against what the imports bind rather than against the JSX, so a
 * renamed import (`ScrollView as Scroller`), a list from another package
 * (FlashList), or a container pulled from reanimated counts — while prose in a
 * comment, a module path such as `./ScrollViewHelpers`, and a type-only import
 * of `FlatListProps` do not.
 */
const CONTAINER = /(ScrollView|FlatList|FlashList|SectionList|VirtualizedList)/;
function mountsOwnScrollContainer(source: string): boolean {
  const bindings = [...source.matchAll(/^\s*import\s+(?!type\b)([\s\S]*?)\sfrom\s+['"]/gm)].map(
    ([, clause]) => clause.replace(/\btype\s+\w+/g, ''),
  );
  return (
    bindings.some((clause) => CONTAINER.test(clause)) ||
    // `import Animated from 'react-native-reanimated'` names no container, so
    // its scrolling variants only show up at the use site.
    /Animated\.(ScrollView|FlatList|SectionList)/.test(source)
  );
}

describe('settings keyboard avoidance', () => {
  it('scrolls the scaffold so a focused field clears the keyboard', () => {
    render(
      <SettingsScaffold title="Services">
        <Text>field</Text>
      </SettingsScaffold>,
    );

    // `bottomOffset` only exists on the keyboard-aware scroll view — the
    // library's jest mock renders it as a plain RN `ScrollView`, so the prop is
    // what tells the two apart here. Swapped back to a plain one, the focused
    // box stays behind the keyboard and the operator types a credential blind,
    // into a field that never echoes it back.
    const scrollViews = screen.UNSAFE_getAllByType(ScrollView);
    expect(scrollViews.length).toBeGreaterThan(0);
    for (const scrollView of scrollViews) {
      expect(scrollView.props.bottomOffset).toBe(KEYBOARD_BOTTOM_OFFSET);
    }
  });

  it('keeps every settings screen and panel scrolling through that one scaffold', () => {
    const sources = [
      ...tsxFilesIn(join(MOBILE_ROOT, 'app', 'settings')),
      ...tsxFilesIn(join(MOBILE_ROOT, 'components', 'settings')),
    ].filter((file) => file !== SCAFFOLD && !file.endsWith('.test.tsx'));
    expect(sources.length).toBeGreaterThan(0);

    const own = sources
      .filter((file) => mountsOwnScrollContainer(readFileSync(file, 'utf8')))
      .map((file) => relative(MOBILE_ROOT, file));

    // A screen or panel that mounts its own scroll container silently opts out
    // of the inset above — it renders correctly, scrolls correctly, and only
    // fails once someone focuses a field near its bottom edge on a phone.
    expect(own).toEqual([]);
  });
});
