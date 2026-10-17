// New screens are built from the design system (docs/design-system.md): colors
// come from theme roles, text from the named type styles, weights from the Inter
// families. Code written before it is recorded per file and rule in
// design-system-debt.json, and that record may only shrink.
//
// Without this guard a screen with its own hex color or font size looks fine in
// review and in every test, and the app drifts away from the design system one
// screen at a time — which is how it got here.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import debt from './design-system-debt.json';

const MOBILE_ROOT = join(__dirname, '..');

const RULES = {
  // A hex or rgb() literal, or an alpha suffix glued onto a role
  // (`${theme.colors.text}33`). Roles come from the theme; transparencies
  // from `tint()` in components/ui/tint.ts.
  rawColor: /['"`]#[0-9a-fA-F]{3,8}['"`]|\brgba?\(|\}[0-9a-fA-F]{2}`/g,
  // A size not taken from a named type style (`...theme.typography.body`).
  fontSize: /\bfontSize:(?!\s*theme\.typography\.)/g,
  // Inter ships one family per weight; a fontWeight on top of it is
  // emboldened again by iOS and the browser.
  fontWeight: /\bfontWeight:/g,
} as const;

type Rule = keyof typeof RULES;
type Counts = Partial<Record<Rule, number>>;

// Deliberate exceptions, not debt: they stay when every screen is migrated.
const EXEMPT: Partial<Record<string, Counts>> = {
  // The switch knob is white with dark ink in both themes, not a theme role.
  'components/ui/Toggle.tsx': { rawColor: 2 },
  // A photo viewer: the image sits on near-black with white controls in
  // either theme, so the picture's own colours are not tinted by the theme.
  'components/ImageLightbox.tsx': { rawColor: 5 },
  // Not a colour: a doc comment shows an issue reference as `#123`.
  'components/SessionIssueRef.tsx': { rawColor: 1 },
  // The meeting wave runs from signature to action through a fixed violet
  // midpoint; a role in the middle would turn the gradient grey or pink.
  'components/meeting/MeetingUI.tsx': { rawColor: 1 },
  'components/meeting/MeetingWave.tsx': { rawColor: 1 },
  // A QR code needs a white quiet zone to stay scannable in either theme.
  'components/settings/settingsStyles.ts': { rawColor: 1 },
  // The pairing QR code itself: black modules on white, in either theme.
  'app/devices.tsx': { rawColor: 2 },
  // The camera scanner sits on the live camera image: black around it, a white
  // frame and white text on a dark veil stay readable over any picture, in
  // either theme.
  'app/onboarding/server-url.tsx': { rawColor: 4 },
};

/** Every non-test `.ts`/`.tsx` below `dir`. Throws rather than returning
 *  nothing if the directory moved: an empty scan would guard no files. */
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

function scan(): Record<string, Counts> {
  const found: Record<string, Counts> = {};
  for (const file of ['app', 'components'].flatMap((dir) => sourcesIn(join(MOBILE_ROOT, dir)))) {
    const source = readFileSync(file, 'utf8');
    const counts: Counts = {};
    for (const [rule, pattern] of Object.entries(RULES) as [Rule, RegExp][]) {
      const count = source.match(pattern)?.length ?? 0;
      if (count > 0) counts[rule] = count;
    }
    // Keyed with `/` on every platform, as in design-system-debt.json.
    if (Object.keys(counts).length > 0)
      found[relative(MOBILE_ROOT, file).split(sep).join('/')] = counts;
  }
  return found;
}

/** What is left once a file's exemptions are taken off. */
function withoutExemptions(found: Record<string, Counts>): Record<string, Counts> {
  const left: Record<string, Counts> = {};
  for (const [file, counts] of Object.entries(found)) {
    const exempt = EXEMPT[file] ?? {};
    const rest: Counts = {};
    for (const [rule, count] of Object.entries(counts) as [Rule, number][]) {
      const remaining = count - (exempt[rule] ?? 0);
      if (remaining > 0) rest[rule] = remaining;
    }
    if (Object.keys(rest).length > 0) left[file] = rest;
  }
  return left;
}

it('finds the sources it guards', () => {
  // A pattern that stopped matching would turn every count into zero and
  // fail only as "debt went down"; this keeps the scan itself honest.
  expect(Object.keys(scan()).length).toBeGreaterThan(0);
});

it('keeps design-system debt from growing and records every reduction', () => {
  // On failure: a file above its recorded count gained raw colors, legacy
  // color names, raw font sizes or font weights — use theme roles, `tint()`
  // and `theme.typography` instead. A file below its count, or missing here,
  // was cleaned up: lower or remove its entry in design-system-debt.json.
  expect(withoutExemptions(scan())).toEqual(debt);
});

it('only exempts what is still there', () => {
  const found = scan();
  for (const [file, counts] of Object.entries(EXEMPT)) {
    for (const [rule, count] of Object.entries(counts ?? {}) as [Rule, number][]) {
      expect({ file, rule, count: found[file]?.[rule] ?? 0 }).toEqual({ file, rule, count });
    }
  }
});
