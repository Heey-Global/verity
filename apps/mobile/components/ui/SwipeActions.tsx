// The actions a row reveals when swiped, in one look for every list: a session
// row, a file, a Sources folder. Each action is a full-height lane with its
// icon above a short label (iOS list style), tinted at rest and drawn over the
// surface opaquely, because the lanes sit under the row that slides over them.
import { Pressable, Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Icon, type IconName } from '../Icon';

/** Width an action rests at after a short swipe. */
export const SWIPE_ACTION_WIDTH = 88;

/** Share of the tone laid over the surface for an action at rest. */
const REST_TINT = 0.16;

/** `tone` laid over `base` at `alpha`, as an opaque color. The action lanes sit
 *  under the row and must not let anything else show through them. */
export function mixColor(tone: string, base: string, alpha: number): string {
  // Theme tokens are `#rrggbb` today; anything else would blend to `#NaNNaNNaN`
  // and leave the lane without a background, so fall back to the opaque base.
  const rgbHex = /^#[0-9a-f]{6}$/i;
  if (!rgbHex.test(tone) || !rgbHex.test(base)) return base;
  const channel = (hex: string, i: number) => parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16);
  const mixed = [0, 1, 2].map((i) =>
    Math.round(channel(tone, i) * alpha + channel(base, i) * (1 - alpha))
      .toString(16)
      .padStart(2, '0'),
  );
  return `#${mixed.join('')}`;
}

export type SwipeActionTone = 'action' | 'destructive';

/**
 * One action in a swipe lane. `armed` draws it solid, for the moment a release
 * would fire it; `grow` lets the outermost action follow the finger, so a long
 * swipe fills the row with its color instead of opening a gap.
 */
export function SwipeActionButton({
  label,
  icon,
  tone,
  onPress,
  armed = false,
  grow = false,
}: {
  label: string;
  icon: IconName;
  tone: SwipeActionTone;
  onPress: () => void;
  armed?: boolean;
  grow?: boolean;
}) {
  const { theme } = useUnistyles();
  const color = tone === 'destructive' ? theme.colors.attention : theme.colors.action;
  const foreground = armed ? theme.colors.onAction : color;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={[
        styles.action,
        grow ? styles.grow : null,
        { backgroundColor: armed ? color : mixColor(color, theme.colors.surface, REST_TINT) },
      ]}
    >
      <Icon name={icon} size={20} color={foreground} />
      <Text style={[styles.label, { color: foreground }]} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

export interface SwipeLaneAction {
  key: string;
  label: string;
  icon: IconName;
  tone: SwipeActionTone;
  onPress: () => void;
}

/** A row's actions side by side at their resting width, innermost first. */
export function SwipeActionLane({ actions }: { actions: readonly SwipeLaneAction[] }) {
  return (
    <View style={[styles.lane, { width: SWIPE_ACTION_WIDTH * actions.length }]}>
      {actions.map((action) => (
        <SwipeActionButton
          key={action.key}
          label={action.label}
          icon={action.icon}
          tone={action.tone}
          onPress={action.onPress}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  lane: {
    height: '100%',
    flexDirection: 'row',
  },
  // Icon above a short label, centered in the resting width: side by side, a
  // label like "Unfavorite" does not fit and spills into the row.
  action: {
    height: '100%',
    width: SWIPE_ACTION_WIDTH,
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.spacing.xs,
    paddingHorizontal: theme.spacing.xs,
  },
  grow: {
    flexGrow: 1,
  },
  label: {
    fontSize: theme.typography.footnote.fontSize,
    fontFamily: theme.fonts.bold,
  },
}));
