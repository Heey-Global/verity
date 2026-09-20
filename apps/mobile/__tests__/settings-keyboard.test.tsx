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
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ScrollView, Text } from 'react-native';

jest.mock('expo-router', () => require('./support/settingsHarness').expoRouterMock());

import { SettingsScaffold } from '../components/settings/SettingsChrome';
import { resetSettingsHarness } from './support/settingsHarness';

afterEach(() => resetSettingsHarness());

/** Every `.tsx` under `app/settings`, plus the screens' shared chrome. Read off
 *  disk so a route added later is covered without being listed here. */
function settingsSourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return settingsSourceFiles(path);
    return entry.isFile() && entry.name.endsWith('.tsx') ? [path] : [];
  });
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
    expect(screen.UNSAFE_getByType(ScrollView).props.automaticallyAdjustKeyboardInsets).toBe(true);
  });

  it('keeps every settings screen scrolling through that one scaffold', () => {
    const own = settingsSourceFiles(join(__dirname, '..', 'app', 'settings')).filter((file) =>
      /<(ScrollView|FlatList|SectionList|KeyboardAwareScrollView)[\s/>]/.test(
        readFileSync(file, 'utf8'),
      ),
    );

    // A screen that mounts its own scroll container silently opts out of the
    // inset above — it renders correctly, scrolls correctly, and only fails once
    // someone focuses a field near its bottom edge on a phone.
    expect(own).toEqual([]);
  });
});
