// Verity design tokens. Colors are per-theme (light/dark); the spacing, radius
// and text scales are shared across both. The `tone` colors are the concrete
// palette behind the data layer's semantic badge tones (@verity/mobile
// `sessionBadge` → BadgeTone: idle | active | attention | done | danger) — the
// session-list slice resolves `theme.colors.tone[badge.tone]` to color a row.

const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;
const radius = { sm: 6, md: 10, lg: 16, pill: 999 } as const;
// The unscaled type ramp. The live theme's `text` is this ramp multiplied by the
// user's font-zoom factor (see lib/fontZoom.ts, applied via UnistylesRuntime).
// Typed as plain numbers (not `as const`) so the runtime can swap in scaled sizes.
export type TypeRamp = {
  micro: number;
  xs: number;
  sm: number;
  md: number;
  lg: number;
  xl: number;
};
const baseText: TypeRamp = { micro: 10, xs: 12, sm: 14, md: 16, lg: 20, xl: 28 };

// `fontScale` is the ⌘+/⌘−/⌘0 zoom factor (1 = default). It multiplies the type
// ramp above and every explicit `lineHeight`/`fontSize` literal in a themed
// StyleSheet, so text and its leading grow together. Both `text` and `fontScale`
// are mutable (no `as const`) so UnistylesRuntime.updateTheme can rewrite them.
const shared = { spacing, radius, text: baseText, fontScale: 1 };

const lightTheme = {
  ...shared,
  colors: {
    background: '#f5f6f8',
    surface: '#ffffff',
    surfaceAlt: '#eef0f3',
    // Translucent backdrop for floating overlays (e.g. the message-nav stack) so they
    // lift off the transcript text without fully masking it.
    scrim: 'rgba(255,255,255,0.82)',
    border: '#dfe3e8',
    text: '#11181c',
    textMuted: '#5b6770',
    textFaint: '#8a949c',
    primary: '#2f6fed',
    onPrimary: '#ffffff',
    // Magenta signature accent (duotone partner to `primary`). Darker on light.
    accent: '#c81d9e',
    tone: {
      idle: '#8a949c',
      active: '#2f6fed',
      attention: '#e8a33d',
      done: '#3aa657',
      // Raspberry rather than a harsh fire-red — warm enough to read as
      // danger/error, but tilted toward the magenta accent so it sits in the
      // palette instead of fighting it.
      danger: '#d84f74',
    },
  },
} as const;

// AMOLED neon dark theme: a true-black (#000000) background so OLED pixels switch
// fully off (battery saving on the operator's iPhone). Signature is magenta +
// electric blue — surfaces carry a faint violet tint that bridges the two, and
// the status tones are high-saturation neons tuned to glow against the black.
// No orange (operator preference).
const darkTheme = {
  ...shared,
  colors: {
    background: '#000000',
    surface: '#0a0b16',
    surfaceAlt: '#15132b',
    // Translucent backdrop for floating overlays (e.g. the message-nav stack) so they
    // lift off the transcript text without fully masking it.
    scrim: 'rgba(21,19,43,0.82)',
    border: '#2a2552',
    text: '#eef0ff',
    textMuted: '#9a9ec9',
    textFaint: '#5d6090',
    primary: '#2ab0ff',
    onPrimary: '#00111f',
    // Neon-magenta signature accent (duotone partner to the electric-blue primary).
    accent: '#ff35da',
    tone: {
      idle: '#5d6090',
      active: '#19c8ff',
      attention: '#ff35da',
      done: '#28e6a4',
      // Neon raspberry rather than a harsh fire-red — warm enough to read as
      // danger/error, but tilted toward the magenta accent so it glows in the
      // palette instead of fighting it.
      danger: '#ff5c8a',
    },
  },
} as const;

export { lightTheme, darkTheme, baseText };
