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
 * hex in both themes; anything else would silently produce an invalid color, so
 * it fails loudly instead.
 */
export function tint(color: string, strength: TintStrength): string {
  if (!/^#[0-9a-f]{6}$/i.test(color)) {
    throw new Error(`tint() needs a six-digit hex role color, got ${color}`);
  }
  return `${color}${ALPHA[strength]}`;
}
