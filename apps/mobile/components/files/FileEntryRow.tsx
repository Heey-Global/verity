import { Pressable, Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Icon, type IconName } from '../Icon';

/**
 * One entry in a file explorer — Code, Wiki, Sources, Shared or Google Drive —
 * so every place that lists files draws them the same way: a glyph, the name
 * over an optional line of detail, and a chevron for a folder. While selecting,
 * the chevron gives way to a check circle; an inert row is dimmed.
 */
export function FileEntryRow({
  name,
  icon,
  meta,
  folder = false,
  selecting = false,
  picked = false,
  inert = false,
  onPress,
  onLongPress,
  accessibilityLabel,
}: {
  name: string;
  icon: IconName;
  meta?: string | undefined;
  folder?: boolean;
  selecting?: boolean;
  picked?: boolean;
  inert?: boolean;
  onPress: () => void;
  onLongPress?: (() => void) | undefined;
  accessibilityLabel?: string;
}) {
  const { theme } = useUnistyles();
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      disabled={inert}
      accessibilityRole={selecting ? 'checkbox' : 'button'}
      accessibilityLabel={accessibilityLabel ?? name}
      accessibilityState={selecting ? { checked: picked } : undefined}
      style={({ pressed }) => [
        styles.row,
        pressed || picked ? styles.pressed : null,
        inert ? styles.inert : null,
      ]}
    >
      <Icon name={icon} size={18} color={theme.colors.textMuted} />
      <View style={styles.main}>
        <Text style={styles.name} numberOfLines={2} ellipsizeMode="tail">
          {name}
        </Text>
        {meta ? (
          <Text style={styles.meta} numberOfLines={1}>
            {meta}
          </Text>
        ) : null}
      </View>
      {selecting ? (
        <View style={styles.check}>
          <Icon
            name={picked ? 'check-circle' : 'circle'}
            size={18}
            color={picked ? theme.colors.action : theme.colors.textFaint}
          />
        </View>
      ) : folder ? (
        <Icon name="chevron-right" size={17} color={theme.colors.textFaint} />
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    minHeight: 46,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
    paddingVertical: theme.spacing.sm,
    paddingHorizontal: theme.spacing.xs,
    borderRadius: theme.radius.md,
  },
  pressed: { backgroundColor: theme.colors.surfaceAlt },
  inert: { opacity: 0.55 },
  main: { flex: 1, minWidth: 0 },
  name: {
    flex: 1,
    color: theme.colors.text,
    fontFamily: theme.fonts.regular,
    fontSize: theme.typography.row.fontSize,
    lineHeight: 22 * theme.fontScale,
  },
  meta: {
    color: theme.colors.textFaint,
    fontFamily: theme.fonts.regular,
    fontSize: theme.typography.footnote.fontSize,
    marginTop: 1,
  },
  check: {
    width: 34,
    height: 34,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: theme.radius.md,
  },
}));
