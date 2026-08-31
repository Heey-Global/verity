// The project overview's container-state indicator. Sessions and projects share the
// same leading dot gutter, so this deliberately reuses the session vocabulary
// instead of inventing a second one: magenta + pulsing (the very same `WorkingDot`)
// means "work in progress", green means healthy, raspberry means the operator must
// repair, grey means deliberately paused. Blue stays reserved for the session
// unread dot. The mapping itself lives in `@verity/mobile`'s `projectBadge` — this
// component only resolves a tone to a theme color.
import type { ProjectBadge } from '@verity/mobile';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { WorkingDot } from './WorkingDot';

export function ProjectStatusDot({ badge, size = 8 }: { badge: ProjectBadge; size?: number }) {
  const { theme } = useUnistyles();
  if (badge.pulsing) return <WorkingDot size={size + 1} label={badge.label} />;
  const color =
    badge.tone === 'done'
      ? theme.colors.tone.done
      : badge.tone === 'danger'
        ? theme.colors.tone.danger
        : theme.colors.tone.idle;
  return (
    <View
      accessibilityRole="image"
      accessibilityLabel={badge.label}
      style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color }}
    />
  );
}
