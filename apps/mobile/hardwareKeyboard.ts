// iPad hardware-keyboard detection, for composer autofocus (#98). React Native has no
// API for "is a physical keyboard attached", but a reliable proxy exists: when a field
// focuses with an external keyboard, iOS shows only the tiny accessory bar (or
// nothing), so the on-screen keyboard height stays near zero — a software keyboard is
// ~250px+. We infer presence from the keyboard-show height.
//
// The detection is GLOBAL (installed once at the app root, not per screen), so the
// keyboard type is learned from ANY field focus anywhere in the app — the new-session
// prompt autofocus, the rename modal, etc. — not just the session screen. That way
// opening a session can autofocus on the very first try, instead of only after the
// operator has already tapped the composer once.
//
// Deliberately IN-MEMORY only, NOT persisted. A persisted `true` would go stale the
// instant the keyboard is unplugged and then pop the software keyboard on the next
// cold start, before any event corrects it. In memory, the worst case is a single
// stale autofocus right after unplugging — the next keyboard-show event flips this
// back and it self-corrects. `null` = not yet observed this run.
import { Keyboard, type KeyboardEvent, Platform } from 'react-native';

// On-screen keyboard height (px) below which we treat an external keyboard as attached.
export const HARDWARE_KEYBOARD_MAX_HEIGHT = 120;

let detected: boolean | null = null;

export type HardwareKeyboardDetection = 'unknown' | 'hardware' | 'software';

/** Classify an on-screen keyboard height: below the threshold only the accessory bar
 * (or nothing) showed, which means a hardware keyboard is attached; a full software
 * keyboard is ~250px+. Pure, so the threshold logic is unit-testable without a device. */
export function isExternalKeyboardHeight(height: number): boolean {
  return height < HARDWARE_KEYBOARD_MAX_HEIGHT;
}

/** Whether an external keyboard has been positively observed this run. `false` covers
 * both "unknown" and "observed software keyboard"; use `hardwareKeyboardDetection`
 * or `shouldPreserveComposerFocus` when that distinction matters. */
export function isHardwareKeyboardAttached(): boolean {
  return detected === true;
}

export function hardwareKeyboardDetection(): HardwareKeyboardDetection {
  if (detected === true) return 'hardware';
  if (detected === false) return 'software';
  return 'unknown';
}

/** Whether the session composer should preserve focus on iPad. Unknown is treated
 * as "try": iOS may not emit a keyboard-show event for an already attached hardware
 * keyboard, so a strict observed-true gate can permanently disable the feature. A
 * later full software-keyboard event records `software` and turns this off. */
export function shouldPreserveComposerFocus(): boolean {
  return detected !== false;
}

/** Update the detected state from a keyboard-show height. Called by the listener; also
 * the seam the unit test drives to exercise the full state machine without a device. */
export function recordKeyboardHeight(height: number): void {
  detected = isExternalKeyboardHeight(height);
}

/** Install the global keyboard-height listener. Call once at the app root; the returned
 * function removes the listener. No-op off iPad (autofocus is iPad-only). */
export function installHardwareKeyboardDetection(): () => void {
  if (Platform.OS !== 'ios' || !Platform.isPad) return () => {};
  const sub = Keyboard.addListener('keyboardWillShow', (event: KeyboardEvent) => {
    recordKeyboardHeight(event.endCoordinates?.height ?? 0);
  });
  return () => sub.remove();
}
