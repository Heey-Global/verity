// Quick actions on a session row in the overview list. Touch: swipe right to
// reveal "favorite" on the leading edge, swipe left to reveal "delete" on the
// trailing edge — a short swipe holds the action open for a tap, a long swipe
// fires it directly. Browser: a right-click opens a small menu with the same
// actions plus "Edit…" (the existing session settings). Long-press stays with
// the row itself and keeps opening the settings directly.
import * as Haptics from 'expo-haptics';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Modal, Platform, Pressable, Text, View, useWindowDimensions } from 'react-native';
import ReanimatedSwipeable, {
  type SwipeableMethods,
} from 'react-native-gesture-handler/ReanimatedSwipeable';
import Reanimated, {
  runOnJS,
  useAnimatedReaction,
  useAnimatedStyle,
  type SharedValue,
} from 'react-native-reanimated';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Icon, type IconName } from './Icon';

/** Width an action rests at after a short swipe. */
const SWIPE_ACTION_WIDTH = 96;
/** Share of the row width past which releasing fires the action directly. */
const FULL_SWIPE_RATIO = 0.5;

type SwipeSide = 'favorite' | 'delete';

export function isFullSwipe(side: SwipeSide, translation: number, threshold: number): boolean {
  'worklet';
  return side === 'favorite' ? translation >= threshold : translation <= -threshold;
}

// Only one row may hold an action open; opening another closes it, like iOS lists.
let openRow: SwipeableMethods | null = null;

export function SwipeableSessionRow({
  favorite,
  label,
  onToggleFavorite,
  onDelete,
  onEdit,
  children,
}: {
  favorite: boolean;
  /** Session title, shown as the menu header. */
  label: string;
  onToggleFavorite: () => void;
  onDelete: () => void;
  onEdit: () => void;
  children: ReactNode;
}) {
  const swipeable = useRef<SwipeableMethods>(null);
  const armed = useRef<SwipeSide | null>(null);
  const [width, setWidth] = useState(0);
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const fullSwipe = Math.max(SWIPE_ACTION_WIDTH * 1.5, width * FULL_SWIPE_RATIO);

  const run = useCallback(
    (side: SwipeSide) => {
      swipeable.current?.close();
      if (side === 'favorite') onToggleFavorite();
      else onDelete();
    },
    [onDelete, onToggleFavorite],
  );
  const onArm = useCallback((side: SwipeSide, on: boolean) => {
    armed.current = on ? side : armed.current === side ? null : armed.current;
    if (on) void Haptics.selectionAsync().catch(() => undefined);
  }, []);

  const container = useRef<View>(null);
  useContextMenu(container, setMenuAt);

  return (
    <View ref={container} onLayout={(event) => setWidth(event.nativeEvent.layout.width)}>
      <ReanimatedSwipeable
        ref={swipeable}
        friction={1}
        leftThreshold={SWIPE_ACTION_WIDTH / 2}
        rightThreshold={SWIPE_ACTION_WIDTH / 2}
        dragOffsetFromLeftEdge={12}
        dragOffsetFromRightEdge={12}
        onSwipeableWillOpen={() => {
          if (openRow && openRow !== swipeable.current) openRow.close();
          openRow = swipeable.current;
          const side = armed.current;
          armed.current = null;
          if (side) run(side);
        }}
        onSwipeableClose={() => {
          if (openRow === swipeable.current) openRow = null;
        }}
        renderLeftActions={(_progress, translation) => (
          <SwipeAction
            side="favorite"
            label={favorite ? 'Unfavorite' : 'Favorite'}
            icon="star"
            translation={translation}
            fullSwipe={fullSwipe}
            onArm={onArm}
            onPress={() => run('favorite')}
          />
        )}
        renderRightActions={(_progress, translation) => (
          <SwipeAction
            side="delete"
            label="Delete"
            icon="trash-2"
            translation={translation}
            fullSwipe={fullSwipe}
            onArm={onArm}
            onPress={() => run('delete')}
          />
        )}
      >
        {children}
      </ReanimatedSwipeable>
      {menuAt ? (
        <SessionContextMenu
          at={menuAt}
          title={label}
          favorite={favorite}
          onClose={() => setMenuAt(null)}
          onToggleFavorite={onToggleFavorite}
          onEdit={onEdit}
          onDelete={onDelete}
        />
      ) : null}
    </View>
  );
}

function SwipeAction({
  side,
  label,
  icon,
  translation,
  fullSwipe,
  onArm,
  onPress,
}: {
  side: SwipeSide;
  label: string;
  icon: IconName;
  translation: SharedValue<number>;
  fullSwipe: number;
  onArm: (side: SwipeSide, on: boolean) => void;
  onPress: () => void;
}) {
  const { theme } = useUnistyles();
  const tone = side === 'favorite' ? theme.colors.accent : theme.colors.tone.danger;
  const [isArmed, setArmed] = useState(false);
  const arm = useCallback(
    (on: boolean) => {
      setArmed(on);
      onArm(side, on);
    },
    [onArm, side],
  );
  useAnimatedReaction(
    () => isFullSwipe(side, translation.value, fullSwipe),
    (on, previous) => {
      if (on !== previous) runOnJS(arm)(on);
    },
    [fullSwipe, side],
  );
  // The lane follows the finger past its resting width, so a long swipe fills the
  // row with the action color instead of opening a gap.
  const lane = useAnimatedStyle(() => ({
    width: Math.max(SWIPE_ACTION_WIDTH, Math.abs(translation.value)),
  }));
  const color = isArmed ? theme.colors.onPrimary : tone;
  return (
    <Reanimated.View
      style={[
        styles.lane,
        side === 'favorite' ? styles.laneLeading : styles.laneTrailing,
        // Tinted like the status pill at rest; solid once a release would fire it.
        { backgroundColor: isArmed ? tone : `${tone}24` },
        lane,
      ]}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        onPress={onPress}
        style={[styles.action, side === 'favorite' ? styles.actionLeading : styles.actionTrailing]}
      >
        <Icon name={icon} size={20} color={color} />
        <Text style={[styles.actionLabel, { color }]}>{label}</Text>
      </Pressable>
    </Reanimated.View>
  );
}

/** Opens the menu on a browser right-click; native has no secondary click here. */
function useContextMenu(
  target: React.RefObject<View | null>,
  open: (at: { x: number; y: number }) => void,
): void {
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    // On react-native-web a View ref is its DOM element.
    const element = target.current as unknown as HTMLElement | null;
    if (!element?.addEventListener) return;
    const onContextMenu = (event: MouseEvent) => {
      event.preventDefault();
      open({ x: event.clientX, y: event.clientY });
    };
    element.addEventListener('contextmenu', onContextMenu);
    return () => element.removeEventListener('contextmenu', onContextMenu);
  }, [open, target]);
}

const MENU_WIDTH = 240;
const MENU_HEIGHT = 168;

export function SessionContextMenu({
  at,
  title,
  favorite,
  onClose,
  onToggleFavorite,
  onEdit,
  onDelete,
}: {
  at: { x: number; y: number };
  title: string;
  favorite: boolean;
  onClose: () => void;
  onToggleFavorite: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { theme } = useUnistyles();
  const window = useWindowDimensions();
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  const pick = (action: () => void) => () => {
    onClose();
    action();
  };
  const left = Math.max(8, Math.min(at.x, window.width - MENU_WIDTH - 8));
  const top = Math.max(8, Math.min(at.y, window.height - MENU_HEIGHT - 8));
  return (
    <Modal transparent visible animationType="none" onRequestClose={onClose}>
      <Pressable
        style={styles.backdrop}
        onPress={onClose}
        accessibilityLabel="Close menu"
        accessibilityRole="button"
      />
      <View style={[styles.menu, { left, top }]} accessibilityRole="menu">
        <Text style={styles.menuTitle} numberOfLines={1}>
          {title}
        </Text>
        <MenuItem
          icon="star"
          label={favorite ? 'Remove from favorites' : 'Add to favorites'}
          color={favorite ? theme.colors.accent : theme.colors.text}
          onPress={pick(onToggleFavorite)}
        />
        <MenuItem icon="edit-2" label="Edit…" color={theme.colors.text} onPress={pick(onEdit)} />
        <View style={styles.menuDivider} />
        <MenuItem
          icon="trash-2"
          label="Delete…"
          color={theme.colors.tone.danger}
          onPress={pick(onDelete)}
        />
      </View>
    </Modal>
  );
}

function MenuItem({
  icon,
  label,
  color,
  onPress,
}: {
  icon: IconName;
  label: string;
  color: string;
  onPress: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <Pressable
      accessibilityRole="menuitem"
      accessibilityLabel={label}
      onPress={onPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      style={[styles.menuItem, hovered ? styles.menuItemHovered : null]}
    >
      <Icon name={icon} size={16} color={color} />
      <Text style={[styles.menuLabel, { color }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  lane: {
    height: '100%',
    justifyContent: 'center',
  },
  laneLeading: {
    alignItems: 'flex-start',
  },
  laneTrailing: {
    alignItems: 'flex-end',
  },
  action: {
    height: '100%',
    width: SWIPE_ACTION_WIDTH,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
  },
  actionLeading: {
    justifyContent: 'flex-start',
    paddingLeft: theme.spacing.lg,
  },
  actionTrailing: {
    justifyContent: 'flex-end',
    paddingRight: theme.spacing.lg,
  },
  actionLabel: {
    fontSize: theme.text.xs,
    fontWeight: '800',
  },
  backdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  menu: {
    position: 'absolute',
    width: MENU_WIDTH,
    padding: theme.spacing.xs,
    borderRadius: theme.radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceAlt,
    shadowColor: '#000',
    shadowOpacity: 0.35,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
    elevation: 12,
  },
  menuTitle: {
    color: theme.colors.textMuted,
    fontSize: theme.text.xs,
    paddingHorizontal: theme.spacing.sm + 2,
    paddingTop: theme.spacing.xs + 2,
    paddingBottom: theme.spacing.xs,
  },
  menuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm + 2,
    paddingHorizontal: theme.spacing.sm + 2,
    paddingVertical: theme.spacing.sm,
    borderRadius: theme.radius.sm,
  },
  menuItemHovered: {
    backgroundColor: theme.colors.surface,
  },
  menuLabel: {
    fontSize: theme.text.sm,
  },
  menuDivider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: theme.colors.border,
    marginVertical: theme.spacing.xs,
    marginHorizontal: theme.spacing.xs + 2,
  },
}));
