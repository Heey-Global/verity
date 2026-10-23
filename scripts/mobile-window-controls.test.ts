import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

it('measures corner intrusion at the header row instead of across the window', () => {
  const native = read('apps/mobile/native/VerityWindowControls.swift');
  // A window-wide measurement can report no intrusion at the buttons' height.
  expect(native).toMatch(
    /let adapted = edgeInsets\(for: \.margins\(cornerAdaptation: \.horizontal\)\)/u,
  );
  expect(native).not.toMatch(/window\.edgeInsets\(/u);
  expect(native).toMatch(/let base = layoutMargins/u);

  const header = read('apps/mobile/app/_layout.tsx');
  // Measuring the status-bar region as part of the row changes corner adaptation.
  expect(header).toMatch(
    /<View style=\{\[styles\.headerRow, headerRowInset\]\}>\s*<WindowControlsProbe onInset=\{trackWindowControls\} \/>/u,
  );
});
