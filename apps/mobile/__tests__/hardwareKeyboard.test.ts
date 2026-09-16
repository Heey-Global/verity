// Unit tests for the iPad hardware-keyboard detection logic (#98). These exercise the
// platform-INDEPENDENT core — the height→"is a hardware keyboard attached" threshold
// and the resulting detection state — which is the part that could actually be wrong
// (comparison direction, threshold, default state). The iPad-only glue
// (`installHardwareKeyboardDetection` gating on `Platform.isPad` and wiring
// `Keyboard.addListener`) still needs a device/simulator to confirm that
// `keyboardWillShow` fires at all with a hardware keyboard — a unit test can't cover
// that, and this file does not claim to.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  HARDWARE_KEYBOARD_MAX_HEIGHT,
  hardwareKeyboardDetection,
  isExternalKeyboardHeight,
  isHardwareKeyboardAttached,
  recordKeyboardHeight,
  shouldPreserveComposerFocus,
  shouldSubmitOnReturn,
} from '../hardwareKeyboard';

describe('isExternalKeyboardHeight (threshold)', () => {
  it('treats a near-zero / accessory-bar height as an external keyboard', () => {
    expect(isExternalKeyboardHeight(0)).toBe(true); // shortcut bar hidden
    expect(isExternalKeyboardHeight(55)).toBe(true); // shortcut bar only
    expect(isExternalKeyboardHeight(HARDWARE_KEYBOARD_MAX_HEIGHT - 1)).toBe(true);
  });

  it('treats a full software-keyboard height as NO external keyboard', () => {
    expect(isExternalKeyboardHeight(HARDWARE_KEYBOARD_MAX_HEIGHT)).toBe(false); // boundary
    expect(isExternalKeyboardHeight(300)).toBe(false); // typical iPad software keyboard
  });
});

describe('detection state machine', () => {
  it('defaults to not-attached before any keyboard has shown (safe default)', () => {
    // Fresh module import so the module-level `detected` is its initial null — the
    // touch-only-iPad and pre-first-focus state, which is not a confirmed keyboard.
    jest.isolateModules(() => {
      const mod = require('../hardwareKeyboard');
      expect(mod.isHardwareKeyboardAttached()).toBe(false);
      expect(mod.hardwareKeyboardDetection()).toBe('unknown');
      expect(mod.shouldPreserveComposerFocus()).toBe(true);
    });
  });

  it('flips to attached when a small (accessory-bar) keyboard shows', () => {
    recordKeyboardHeight(55);
    expect(isHardwareKeyboardAttached()).toBe(true);
    expect(hardwareKeyboardDetection()).toBe('hardware');
    expect(shouldPreserveComposerFocus()).toBe(true);
  });

  it('self-corrects to not-attached when a full software keyboard later shows', () => {
    recordKeyboardHeight(55);
    expect(isHardwareKeyboardAttached()).toBe(true);
    // e.g. the operator unplugged the keyboard and then focused a field.
    recordKeyboardHeight(320);
    expect(isHardwareKeyboardAttached()).toBe(false);
    expect(hardwareKeyboardDetection()).toBe('software');
    expect(shouldPreserveComposerFocus()).toBe(false);
  });
});

describe('shouldSubmitOnReturn (what the Return key does)', () => {
  // Each case is a device situation that reached an operator, not a state permutation.
  // The predicate reads only its argument — deliberately, since every situation below
  // except the last leaves the remembered detection absent or stale.
  it('sends with no keyboard on screen: Mac, or an iPad keyboard attached before focus', () => {
    // Neither emits a keyboard-show event, so nothing is ever learned about them and the
    // remembered detection stays `unknown` for the whole run. Whatever a stale detection
    // says, there is no keyboard on screen to type a newline on.
    recordKeyboardHeight(320);
    expect(hardwareKeyboardDetection()).toBe('software');
    expect(shouldSubmitOnReturn(null)).toBe(true);
  });

  it('sends while only the hardware shortcut bar is on screen', () => {
    // The bar IS a shown keyboard, so a plain "is a keyboard visible" check would treat
    // it like the touch keyboard — but there is nothing on it to type a newline with.
    expect(shouldSubmitOnReturn(55)).toBe(true);
    expect(shouldSubmitOnReturn(HARDWARE_KEYBOARD_MAX_HEIGHT - 1)).toBe(true);
  });

  it('inserts a newline while the touch keyboard is up', () => {
    // The only case where Return must NOT send: that keyboard is the operator's sole way
    // to type a newline, so sending makes multi-line messages impossible on a touch iPad.
    expect(shouldSubmitOnReturn(320)).toBe(false);
    expect(shouldSubmitOnReturn(HARDWARE_KEYBOARD_MAX_HEIGHT)).toBe(false);
  });

  it('sends again once the touch keyboard is put away for a hardware one', () => {
    // The recorded `software` outlives the touch keyboard — no new show event follows the
    // switch — so a gate reading the remembered detection stays wrong for the rest of the
    // run. Reading the live height recovers as soon as the keyboard is gone.
    recordKeyboardHeight(320);
    expect(hardwareKeyboardDetection()).toBe('software');
    expect(shouldSubmitOnReturn(null)).toBe(true);
  });
});

describe('composer Return handling', () => {
  // No test renders the session screen, so the predicate above can stay green while the
  // composer ignores it. These scan the real handler and the real prop wiring — the two
  // places where a plausible-looking edit silently kills the Return key again.
  const source = readFileSync(join(__dirname, '..', 'app', 'session', '[id].tsx'), 'utf8');
  const start = source.indexOf('const onComposerKeyPress = useCallback(');
  const end = source.indexOf('\n  );', start);
  const handler = start >= 0 && end > start ? source.slice(start, end) : '';

  it('has a Return key handler in the composer', () => {
    // Guards the two tests below: a renamed or restructured callback would otherwise
    // leave them asserting about an empty string, which passes the `not` case.
    expect(handler).not.toBe('');
    expect(handler).toContain("'Enter'");
  });

  it('gates Return-to-send on the live keyboard height, not on observed hardware', () => {
    expect(handler).toMatch(/shouldSubmitOnReturn\(\s*keyboardHeight\s*\)/);
    // `hardwareKeyboardDetection() !== 'hardware'` reads like the same check but is
    // never satisfied on a Mac, where no keyboard-show event is ever emitted.
    expect(handler).not.toContain('hardwareKeyboardDetection');
  });

  it('feeds the composer the height from the live keyboard event', () => {
    // A constant would type-check and read fine: `null` sends even under the touch
    // keyboard, a large value restores the dead Return key.
    expect(source).toMatch(/keyboardHeight=\{\s*keyboardHeight\s*\}/);
    expect(source).toMatch(/setKeyboardHeight\(\s*event\.endCoordinates\?\.height\s*\?\?\s*0\s*\)/);
    expect(source).toMatch(/setKeyboardHeight\(\s*null\s*\)/);
  });
});
