import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (path: string) => readFileSync(join(__dirname, '..', path), 'utf8');

it('uses the shared layout decision in every session entry route', () => {
  const home = read('app/index.tsx');
  expect(home).toMatch(/\{ wide, sidebarWidth \} = sessionLayout\(width\)/u);
  expect(home).toMatch(/useSessionLayoutNavigation\(wide, selectedId,/u);
  expect(home).toMatch(/styles\.leftPane, \{ width: sidebarWidth \}/u);
  for (const path of ['app/session/[id].tsx', 'app/new.tsx']) {
    const source = read(path);
    // A private cutoff silently sends tablet-sized sessions to a different
    // layout than the overview even while the layout helper's tests stay green.
    expect(source).toMatch(/import \{ SPLIT_SCREEN_MIN_WIDTH \} from '[^']*lib\/sessionLayout'/u);
    expect(source).not.toMatch(/const SPLIT_SCREEN_MIN_WIDTH\s*=/u);
    expect(source).toMatch(/width >= SPLIT_SCREEN_MIN_WIDTH/u);
  }
  expect(read('app/session/[id].tsx')).toContain('<SplitScreenRedirect');
});

it('keeps compact usage windows in one row and exposes reset details on tap', () => {
  const home = read('app/index.tsx');
  expect(home).toContain('compact={wide && sidebarWidth < 380}');
  expect(home).not.toContain('styles.limitSegmentsCompact');
  expect(home).toContain('{!compact ? (');
  expect(home).toContain('{compact || pace !== null ? (');
  expect(home).toContain('Resets {text}');
  expect(home).toContain('!compact && screenWidth >= WIDE_PROVIDER_LIMIT_MIN_WIDTH');
});

it('reclaims the empty chevron column only in the compact split sidebar', () => {
  const home = read('app/index.tsx');
  expect(home).toContain('const compactSidebar = layout.wide && layout.sidebarWidth < 380');
  expect(home).toContain('{!compactSidebar ? <View style={styles.colChevron} /> : null}');
  expect(home).toContain('compactSidebar ? styles.rowInnerCompact : null');
});
