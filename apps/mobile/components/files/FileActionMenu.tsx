import { Pressable, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { FileIcon as Icon, type IconName } from './FileIcon';

export interface FileAction {
  key: string;
  label: string;
  icon: IconName;
  destructive?: boolean;
  onPress: () => void;
}

/** The actions for one file, drawn over the sheet rather than as a system alert:
 * Android's alert holds three buttons at most, and this list is longer than that.
 * Destructive actions come last, after a divider, so the one that cannot be
 * undone is never where a hurried tap on the first item lands. Choosing an
 * action closes the menu before it runs. */
export function FileActionMenu({
  title,
  actions,
  onDismiss,
}: {
  title: string;
  actions: readonly FileAction[];
  onDismiss: () => void;
}) {
  const safe = actions.filter((action) => !action.destructive);
  const destructive = actions.filter((action) => action.destructive);
  const row = (action: FileAction) => (
    <Pressable
      key={action.key}
      onPress={() => {
        onDismiss();
        action.onPress();
      }}
      accessibilityRole="menuitem"
      accessibilityLabel={action.label}
      style={({ pressed }) => [styles.item, pressed ? styles.pressed : null]}
    >
      <Text style={[styles.itemLabel, action.destructive ? styles.destructive : null]}>
        {action.label}
      </Text>
      <Icon name={action.icon} size={18} color="#ffffff" />
    </Pressable>
  );
  return (
    <View style={styles.overlay}>
      <Pressable
        style={styles.backdrop}
        onPress={onDismiss}
        accessibilityRole="button"
        accessibilityLabel="Close menu"
      />
      <View style={styles.card} accessibilityRole="menu" accessibilityLabel={title}>
        <Text style={styles.title} numberOfLines={2}>
          {title}
        </Text>
        {safe.map(row)}
        {destructive.length > 0 ? <View style={styles.divider} /> : null}
        {destructive.map(row)}
        <View style={styles.divider} />
        <Pressable
          onPress={onDismiss}
          accessibilityRole="button"
          accessibilityLabel="Cancel"
          style={({ pressed }) => [styles.item, styles.cancel, pressed ? styles.pressed : null]}
        >
          <Text style={styles.cancelLabel}>Cancel</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  overlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    padding: theme.spacing.lg,
    zIndex: 10,
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  card: {
    width: '100%',
    maxWidth: 380,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceAlt,
    paddingVertical: theme.spacing.xs,
  },
  title: {
    color: theme.colors.textMuted,
    fontSize: theme.text.xs,
    fontWeight: '600',
    paddingHorizontal: theme.spacing.lg,
    paddingTop: theme.spacing.sm,
    paddingBottom: theme.spacing.xs,
  },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.spacing.md,
    minHeight: 44,
    paddingHorizontal: theme.spacing.lg,
  },
  pressed: { backgroundColor: theme.colors.surface },
  itemLabel: {
    flex: 1,
    color: theme.colors.text,
    fontSize: theme.text.md,
  },
  destructive: { color: theme.colors.tone.danger },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: theme.colors.border,
    marginVertical: theme.spacing.xs,
  },
  cancel: { justifyContent: 'center' },
  cancelLabel: {
    color: theme.colors.textMuted,
    fontSize: theme.text.md,
    fontWeight: '600',
  },
}));
