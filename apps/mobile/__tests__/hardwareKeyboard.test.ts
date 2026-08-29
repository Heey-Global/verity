// Unit tests for the iPad hardware-keyboard detection logic (#98). These exercise the
// platform-INDEPENDENT core — the height→"is a hardware keyboard attached" threshold
// and the resulting detection state — which is the part that could actually be wrong
// (comparison direction, threshold, default state). The iPad-only glue
// (`installHardwareKeyboardDetection` gating on `Platform.isPad` and wiring
// `Keyboard.addListener`) still needs a device/simulator to confirm that
// `keyboardWillShow` fires at all with a hardware keyboard — a unit test can't cover
// that, and this file does not claim to.
import {
  HARDWARE_KEYBOARD_MAX_HEIGHT,
  hardwareKeyboardDetection,
  isExternalKeyboardHeight,
  isHardwareKeyboardAttached,
  recordKeyboardHeight,
  shouldPreserveComposerFocus,
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
