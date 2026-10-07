# Prompt composer keyboard handling

On iPad and Macs running the iPad app, an unmodified hardware Return sends the
prompt when the on-screen keyboard is absent or only its shortcut bar is visible.
Shift+Return inserts a newline using native text editing. With the full software
keyboard visible, Return inserts a newline. Android and web retain multiline
Return behavior and use the send button to submit.

React Native's iOS `onKeyPress` event exposes the inserted key without modifiers,
so it cannot distinguish Return from Shift+Return. `VerityComposerKeys` uses a
hardware-only UIKit key command for unmodified Return, scoped to the focused
composer. Native submission is disabled during marked-text composition. Text
changes go directly to the draft without suppressing inserted newlines.

This change requires a new native iOS build. Binaries without `VerityComposerKeys`
keep Return as a newline and can submit using the send button.

## Device verification

Automated component tests cover draft/newline retention, submission dispatch,
software-keyboard disabling, and the fallback without the native module. Source
guards cover the native command's modifiers and responder scope. These checks do
not execute UIKit or verify physical keyboard routing.

A physical iPad with a hardware keyboard and native UIKit compilation were not
available during implementation. Before release, verify with the new native build:

- Plain Return sends once with the shortcut bar visible and hidden, retaining focus.
- Shift+Return inserts a newline at the caret and over a selection without sending
  or losing draft text; subsequent typing and undo still work.
- Software-keyboard Return inserts a newline, including after switching keyboards.
- Marked-text composition can be committed without sending the unfinished prompt.
- Return in other text fields never sends the session prompt.
- Repeat hardware Return and Shift+Return on a Mac running the iPad app, including
  with Caps Lock enabled.
