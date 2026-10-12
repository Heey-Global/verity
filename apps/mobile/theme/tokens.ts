// Verity design tokens, as specified in docs/design-system.md. Colors are
// per-theme (light/dark); the spacing, radius, elevation and text scales are
// shared across both. The `tone` colors are the concrete palette behind the data
// layer's semantic badge tones (@verity/mobile `sessionBadge` → BadgeTone:
// idle | active | attention | done | danger) — the session-list slice resolves
// `theme.colors.tone[badge.tone]` to color a row.
//
// Components use the role keys (`action`, `signature`, `success`, `attention`,
// …). The older keys below them (`primary`, `onPrimary`, `accent`, `setup.*`,
// `tone.*`) are kept as aliases of those roles while screens migrate, so the
// whole app already renders the design-system palette; they are removed once no
// screen reads them.

// 2 and 48 complete the design-system spacing scale (2 · 4 · 8 · 12 · 16 · 24 · 32 · 48).
const spacing = { xxs: 2, xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32, xxxl: 48 } as const;
// `sm`/`md`/`lg` predate the design system; the named radii are what new code uses.
const radius = {
  sm: 6,
  md: 10,
  lg: 16,
  pill: 999,
  tag: 6,
  tile: 10,
  control: 12,
  card: 16,
} as const;
// Floating: sheets, menus and dialogs. Glow is drawn per use with the role color
// it belongs to (signature for brand moments, action for the selected card,
// success/attention for status dots), in the dark theme only.
const elevation = {
  floating: {
    shadowColor: '#000000',
    shadowOpacity: 0.6,
    shadowRadius: 25,
    shadowOffset: { width: 0, height: 18 },
    elevation: 12,
  },
  glow: { shadowOpacity: 0.35, shadowRadius: 23, shadowOffset: { width: 0, height: 0 } },
} as const;
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
const shared = { spacing, radius, elevation, text: baseText, fontScale: 1 };

// Light is derived from the same roles and only has to stay readable: action,
// signature, success and attention are darker so text on them reaches 4.5:1.
const lightRoles = {
  background: '#f6f7fa',
  surface: '#ffffff',
  surfaceAlt: '#eef0f5',
  border: '#dde1ea',
  text: '#0d0f17',
  textMuted: '#4a4f62',
  textFaint: '#62677c',
  action: '#066a8c',
  actionLabel: '#055a78',
  onAction: '#ffffff',
  signature: '#b0107d',
  success: '#13744f',
  attention: '#5b4bc4',
  scrim: 'rgba(10,12,20,0.40)',
} as const;

// Dark is the designed theme: the website's neutrals, cyan for everything that
// can be tapped, pink only as the brand signature, lavender instead of red or
// amber for problems.
const darkRoles = {
  background: '#07080d',
  surface: '#0c0e17',
  surfaceAlt: '#111422',
  border: '#22263a',
  text: '#f5f5f8',
  textMuted: '#a5a8b8',
  textFaint: '#80849a',
  action: '#18c8f5',
  actionLabel: '#6fdcf8',
  onAction: '#03141a',
  signature: '#ff18b7',
  success: '#2ee6a6',
  attention: '#a99bff',
  scrim: 'rgba(3,4,8,0.72)',
} as const;

const lightTheme = {
  ...shared,
  colors: {
    ...lightRoles,
    // Aliases of the roles above, kept until every screen reads the roles.
    setup: {
      surface: lightRoles.surface,
      surfaceAlt: lightRoles.surfaceAlt,
      border: lightRoles.border,
      text: lightRoles.text,
      textMuted: lightRoles.textMuted,
    },
    primary: lightRoles.action,
    onPrimary: lightRoles.onAction,
    accent: lightRoles.signature,
    linked: '#64748b',
    tone: {
      idle: lightRoles.textFaint,
      active: lightRoles.action,
      // Amber and raspberry are retired; both former tones now read as attention.
      attention: lightRoles.attention,
      done: lightRoles.success,
      danger: lightRoles.attention,
    },
  },
} as const;

const darkTheme = {
  ...shared,
  colors: {
    ...darkRoles,
    // Aliases of the roles above, kept until every screen reads the roles.
    setup: {
      surface: darkRoles.surface,
      surfaceAlt: darkRoles.surfaceAlt,
      border: darkRoles.border,
      text: darkRoles.text,
      textMuted: darkRoles.textMuted,
    },
    primary: darkRoles.action,
    onPrimary: darkRoles.onAction,
    accent: darkRoles.signature,
    linked: '#cbd5e1',
    tone: {
      idle: darkRoles.textFaint,
      active: darkRoles.action,
      // Amber and raspberry are retired; both former tones now read as attention.
      attention: darkRoles.attention,
      done: darkRoles.success,
      danger: darkRoles.attention,
    },
  },
} as const;

export { lightTheme, darkTheme, baseText };
