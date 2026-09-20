// How much room keyboard-aware views leave between the focused field and the
// top edge of the keyboard.
//
// One shared value rather than a number per screen: the gap is a visual
// constant, and a screen that picks its own drifts out of step with the rest of
// the app the moment this one is tuned. `KeyboardAwareScrollView`'s
// `bottomOffset` takes it directly. Screens with a pinned footer do not use it:
// they shrink the whole frame with a `KeyboardAvoidingView` instead, which
// leaves the gap to the footer's own padding.
export const KEYBOARD_BOTTOM_OFFSET = 24;
