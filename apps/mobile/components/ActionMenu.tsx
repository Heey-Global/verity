import { Icon, type IconName } from './Icon';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { AttachAnchor } from '../lib/attachMenu';

export interface ActionMenuItem {
  icon: IconName;
  title: string;
  subtitle: string;
  onPress: () => void;
  busy?: boolean;
  disabled?: boolean;
  destructive?: boolean;
}

const ACTION_MENU_ROW_HEIGHT = 56;

/**
 * The small "…" card used across the app: pinned to the button that opened it,
 * right-aligned with it, below when there is room and above otherwise. Each
 * action has a name and a one-line explanation, and every icon shares one muted
 * tint so no action is singled out by colour.
 */
export function ActionMenu({
  anchor,
  items,
  label,
  onClose,
}: {
  anchor: AttachAnchor;
  items: readonly ActionMenuItem[];
  label: string;
  onClose: () => void;
}) {
  const { width: winW, height: winH } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const gap = 6;
  const margin = 12;
  const width = Math.min(300, winW - 2 * margin);
  const right = Math.min(Math.max(margin, winW - (anchor.x + anchor.width)), winW - width - margin);
  // Only used to pick a side; the card itself sizes to its content.
  const estimatedHeight = items.length * ACTION_MENU_ROW_HEIGHT + 2 * gap;
  // Keep the card clear of the status bar / notch and the home indicator.
  const minTop = insets.top + margin;
  const maxBottom = winH - insets.bottom - margin;
  const below = anchor.y + anchor.height + gap + estimatedHeight <= maxBottom;
  const top = anchor.y + anchor.height + gap;
  const bottom = Math.min(
    Math.max(insets.bottom + margin, winH - anchor.y + gap),
    winH - minTop - estimatedHeight,
  );
  // The estimate can undershoot (large text grows the rows), so the card is also
  // capped to the room on its side and scrolls instead of running off screen.
  const position = below
    ? { top, maxHeight: maxBottom - top }
    : { bottom, maxHeight: winH - bottom - minTop };
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessible={false} />
      <View
        style={[styles.menu, { width, right }, position]}
        accessibilityRole="menu"
        accessibilityLabel={label}
        accessibilityViewIsModal
        onAccessibilityEscape={onClose}
      >
        <ScrollView bounces={false}>
          {items.map((item) => (
            <ActionMenuRow key={item.title} {...item} />
          ))}
        </ScrollView>
      </View>
    </Modal>
  );
}

function ActionMenuRow({
  icon,
  title,
  subtitle,
  onPress,
  busy = false,
  disabled = false,
  destructive = false,
}: ActionMenuItem) {
  const { theme } = useUnistyles();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || busy}
      accessibilityRole="menuitem"
      accessibilityLabel={title}
      accessibilityHint={subtitle}
      accessibilityState={{ disabled: disabled || busy }}
      style={({ pressed }) => [styles.row, pressed ? styles.rowPressed : null]}
    >
      <View style={styles.icon}>
        {busy ? (
          <ActivityIndicator size="small" color={theme.colors.accent} />
        ) : (
          <Icon
            name={icon}
            size={18}
            color={destructive ? theme.colors.tone.danger : theme.colors.textMuted}
          />
        )}
      </View>
      <View style={styles.text}>
        <Text
          style={[styles.title, destructive ? styles.titleDestructive : null]}
          numberOfLines={1}
        >
          {title}
        </Text>
        <Text style={styles.subtitle} numberOfLines={1}>
          {subtitle}
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  menu: {
    position: 'absolute',
    paddingVertical: 6,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.border,
    shadowColor: '#000000',
    shadowOpacity: 0.35,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 6 },
    elevation: 8,
  },
  row: {
    minHeight: ACTION_MENU_ROW_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.md,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
  },
  rowPressed: {
    backgroundColor: theme.colors.surfaceAlt,
  },
  icon: {
    width: 22,
    alignItems: 'center',
  },
  text: {
    flex: 1,
    gap: 1,
  },
  title: {
    color: theme.colors.text,
    fontSize: theme.text.sm,
    fontWeight: '600',
  },
  titleDestructive: {
    color: theme.colors.tone.danger,
  },
  subtitle: {
    color: theme.colors.textMuted,
    fontSize: theme.text.xs,
  },
}));
