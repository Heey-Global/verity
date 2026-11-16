// The render script finds mockup screens without loading the app, by the same
// rule the app's registry test applies: a `.tsx` with a default export. If the
// two rules drift, the script renders helpers as screens, or skips a screen the
// registry serves and an approval goes out without its image.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { listMockupScreens, listMockupSpecs } from './lib/mockup-screens.mjs';

let dir = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mockups-'));
  mkdirSync(join(dir, 'pricing'));
  writeFileSync(join(dir, 'pricing', 'home.tsx'), 'export default function Home() {}\n');
  writeFileSync(join(dir, 'pricing', 'detail.tsx'), 'const A = 1;\nexport default A;\n');
  writeFileSync(join(dir, 'pricing', 'parts.tsx'), 'export function Thumb() {}\n');
  writeFileSync(join(dir, 'pricing', 'index.ts'), 'export default {};\n');
  writeFileSync(join(dir, 'pricing', 'home.test.tsx'), 'export default 1;\n');
  writeFileSync(join(dir, 'registry.ts'), 'export const X = 1;\n');
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('mockup screens', () => {
  it('lists spec folders, not files beside them', () => {
    expect(listMockupSpecs(dir)).toEqual(['pricing']);
  });

  it('takes .tsx files with a default export as screens, skipping helpers and tests', () => {
    expect(listMockupScreens(dir, 'pricing')).toEqual(['detail', 'home']);
  });

  it('names the known specs when the requested one does not exist', () => {
    expect(() => listMockupScreens(dir, 'checkout')).toThrow('Known: pricing');
  });

  it('refuses a spec name that would leave the mockups folder', () => {
    expect(() => listMockupScreens(dir, '../pricing')).toThrow('Unknown mockup spec');
  });
});

it("finds the screens of the app's own mockups", () => {
  // Anchors the helper on the real folder, so a moved mockups directory fails here.
  const real = join(import.meta.dirname, '..', 'apps', 'mobile', 'mockups');
  expect(listMockupSpecs(real).length).toBeGreaterThan(0);
  for (const spec of listMockupSpecs(real)) expect(listMockupScreens(real, spec)).not.toEqual([]);
});
