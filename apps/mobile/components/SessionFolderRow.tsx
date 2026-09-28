import { Pressable, Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Icon } from './Icon';

/** The worktree explorer's folder row, shared with static preview selection. */
export function SessionFolderRow({
  name,
  onPress,
  accessibilityLabel,
  parent = false,
}: {
  name: string;
  onPress: () => void;
  accessibilityLabel: string;
  parent?: boolean;
}) {
  const { theme } = useUnistyles();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      style={({ pressed }) => [styles.row, pressed ? styles.pressed : null]}
    >
      <Icon name={parent ? 'corner-up-left' : 'folder'} size={18} color={theme.colors.textMuted} />
      <View style={styles.main}>
        <Text style={styles.name} numberOfLines={2} ellipsizeMode="tail">
          {name}
        </Text>
      </View>
      {!parent ? <Icon name="chevron-right" size={17} color={theme.colors.textFaint} /> : null}
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
  main: { flex: 1, minWidth: 0 },
  name: { color: theme.colors.text, fontSize: theme.text.md, lineHeight: 22 * theme.fontScale },
}));
