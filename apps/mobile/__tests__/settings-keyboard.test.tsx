// Reaching the settings fields while the keyboard is open.
//
// Settings is where the operator types credentials they can never re-read: the
// paste boxes are write-only, so a subscription key typed under the keyboard is
// not shown back anywhere. On iOS a ScrollView keeps its full height when the
// keyboard opens — the keyboard just covers the bottom of it, and the last
// group on a screen (Public Preview, on connected services) becomes unreachable
// with nothing to scroll into. Both tests here guard that: the scaffold asks for
// the keyboard inset, and no settings screen scrolls through anything else.
import { render, screen } from '@testing-library/react-native';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ScrollView, Text } from 'react-native';

jest.mock('expo-router', () => require('./support/settingsHarness').expoRouterMock());

import { SettingsScaffold } from '../components/settings/SettingsChrome';
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
 * Matched against the import statements rather than the JSX, so a renamed
 * import (`ScrollView as Scroller`), a list from another package (FlashList),
 * or a container pulled from reanimated counts — and so prose in a comment
 * about the scaffold's scroll view does not.
 */
const CONTAINER = /(ScrollView|FlatList|SectionList|VirtualizedList)/;
function mountsOwnScrollContainer(source: string): boolean {
  const imports = source.match(/import[\s\S]*?from\s+['"][^'"]+['"]/g) ?? [];
  return (
    imports.some((statement) => CONTAINER.test(statement)) ||
    // `import Animated from 'react-native-reanimated'` names no container, so
    // its scrolling variants only show up at the use site.
    /Animated\.(ScrollView|FlatList|SectionList)/.test(source)
  );
}

describe('settings keyboard avoidance', () => {
  it('adjusts the scaffold for the keyboard so a focused field can scroll clear of it', () => {
    render(
      <SettingsScaffold title="Services">
        <Text>field</Text>
      </SettingsScaffold>,
    );

    // Without this the scroll view has no room below its content to scroll
    // into, and iOS leaves the focused box behind the keyboard: the operator
    // pastes or types a credential blind, into a field that never echoes it.
    const scrollViews = screen.UNSAFE_getAllByType(ScrollView);
    expect(scrollViews.length).toBeGreaterThan(0);
    for (const scrollView of scrollViews) {
      expect(scrollView.props.automaticallyAdjustKeyboardInsets).toBe(true);
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
