// The app's single icon primitive: flat, monochrome Feather glyphs from
// @expo/vector-icons. Centralizing the set here means every icon is tintable and
// consistent — pass an explicit `color` (a theme color) per use site so weight and
// hue stay deliberate (e.g. pure `text` white, `accent`, or `textMuted`). This
// replaces the earlier ad-hoc text-glyph/emoji icons (which couldn't be tinted —
// the mic was the 🎤 emoji, hence never white).
import Feather from '@expo/vector-icons/Feather';
import type { ComponentProps } from 'react';

export type IconName = ComponentProps<typeof Feather>['name'];

export function Icon({ name, size = 20, color }: { name: IconName; size?: number; color: string }) {
  return <Feather name={name} size={size} color={color} />;
}
