// The fixed transparency steps of the design system (docs/design-system.md § 2):
// every tint is derived from a role color at one of these strengths, never freely.
const ALPHA = {
  /** Neutral tints: icon tiles, pressed rows, the neutral tag. */
  neutral: '0f',
  /** Tonal fills: primary button, tags, hint boxes. */
  fill: '24',
  /** Focus ring around a field. */
  ring: '33',
  /** Tonal borders: primary button, error field. */
  border: '59',
} as const;

export type TintStrength = keyof typeof ALPHA;

/**
 * A role color at one of the fixed transparency steps. Role colors are six-digit
 * hex on native and CSS variable references in web stylesheets. Unexpected
 * formats fail loudly instead of silently producing an invalid color.
 */
export function tint(color: string, strength: TintStrength): string {
  if (/^#[0-9a-f]{6}$/i.test(color)) {
    return `${color}${ALPHA[strength]}`;
  }
  if (/^var\(--[a-zA-Z_][a-zA-Z0-9_-]*\)$/.test(color)) {
    const percentage = Math.round((parseInt(ALPHA[strength], 16) / 255) * 100);
    return `color-mix(in srgb, ${color} ${percentage}%, transparent)`;
  }
  throw new Error(
    `tint() needs a six-digit hex role color or CSS variable reference, got ${color}`,
  );
}
