// Quick actions on a session row in the overview list. Touch: swipe right to
// reveal "favorite" on the leading edge, swipe left to reveal "edit" and
// "delete" on the trailing edge (iOS Mail style) — a short swipe holds the
// actions open for a tap, a long swipe fires the outermost one directly.
// Browser: a right-click opens a small menu with the same actions plus "Edit…"
// (the existing session settings). The row owns Long-Press for reordering, or
// settings on servers without session ordering support.
import * as Haptics from 'expo-haptics';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { Modal, Platform, Pressable, Text, View, useWindowDimensions } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import ReanimatedSwipeable, {
  type SwipeableMethods,
} from 'react-native-gesture-handler/ReanimatedSwipeable';
import Reanimated, {
  runOnJS,
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
  type SharedValue,
} from 'react-native-reanimated';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import {
  gestureDiagnosticsEnabled,
  gestureRecordingGeneration,
  gestureRowNumber,
  recordGesture,
  subscribeGestureDiagnostics,
} from '../lib/gestureDiagnostics';
import { Icon, type IconName } from './Icon';
import { SWIPE_ACTION_WIDTH, SwipeActionButton } from './ui/SwipeActions';

/** Share of the row width past which releasing fires the action directly. */
const FULL_SWIPE_RATIO = 0.5;

type SwipeSide = 'favorite' | 'delete';

export function isFullSwipe(side: SwipeSide, translation: number, threshold: number): boolean {
  'worklet';
  return side === 'favorite' ? translation >= threshold : translation <= -threshold;
}

// Only one row may hold an action open; opening another closes it, like iOS lists.
let openRow: SwipeableMethods | null = null;

/** The action on the leading edge (swipe right): a session's favorite star by
 *  default, or another non-destructive action of the row's subject. */
export interface LeadingSwipeAction {
  /** Short, under the icon in the lane ("Favorite", "Done"). */
  label: string;
  /** The same action in the browser's context menu ("Add to favorites"). */
  menuLabel: string;
  icon: IconName;
  /** Drawn in the action color in the menu, for a state that is on. */
  active?: boolean;
  onPress: () => void;
}

/** A session's favorite star as the leading action. */
export function favoriteAction(favorite: boolean, onToggle: () => void): LeadingSwipeAction {
  return {
    label: favorite ? 'Unfavorite' : 'Favorite',
    menuLabel: favorite ? 'Remove from favorites' : 'Add to favorites',
    icon: 'star',
    active: favorite,
    onPress: onToggle,
  };
}

export function SwipeableSessionRow({
  favorite = false,
  label,
  onToggleFavorite,
  leading,
  onDelete,
  onEdit,
  children,
  disabled = false,
  diagnostics,
}: {
  favorite?: boolean;
  /** Session title, shown as the menu header. */
  label: string;
  onToggleFavorite?: () => void;
  /** Replaces the favorite star on the leading edge; a row with neither has none. */
  leading?: LeadingSwipeAction | undefined;
  onDelete: () => void;
  onEdit: () => void;
  children: ReactNode;
  disabled?: boolean;
  /** Identifies the row in gesture diagnostics; only read while recording is on. */
  diagnostics?: { rowKey: string; projectKind: string | undefined };
}) {
  const { theme } = useUnistyles();
  const primary: LeadingSwipeAction | undefined =
    leading ??
    (onToggleFavorite !== undefined ? favoriteAction(favorite, onToggleFavorite) : undefined);
  const onPrimary = primary?.onPress;
  const swipeable = useRef<SwipeableMethods>(null);
  const armed = useRef<SwipeSide | null>(null);
  const [width, setWidth] = useState(0);
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;
  const fullSwipe = Math.max(SWIPE_ACTION_WIDTH * 1.5, width * FULL_SWIPE_RATIO);
  // The trailing edge rests two actions wide; keep a full action's margin past that
  // rest, so dragging on to aim at Edit does not arm Delete.
  const fullSwipeTrailing = Math.max(SWIPE_ACTION_WIDTH * 3, width * FULL_SWIPE_RATIO);

  const run = useCallback(
    (side: SwipeSide) => {
      if (disabledRef.current) return;
      swipeable.current?.close();
      if (side === 'favorite') onPrimary?.();
      else onDelete();
    },
    [onDelete, onPrimary],
  );
  const onArm = useCallback((side: SwipeSide, on: boolean) => {
    if (disabledRef.current) return;
    armed.current = on ? side : armed.current === side ? null : armed.current;
    if (on) void Haptics.selectionAsync().catch(() => undefined);
  }, []);

  const container = useRef<View>(null);
  useContextMenu(container, setMenuAt);
  useEffect(() => {
    if (disabled) {
      armed.current = null;
      swipeable.current?.reset();
      setMenuAt(null);
    }
  }, [disabled]);

  const generation = useSyncExternalStore(
    subscribeGestureDiagnostics,
    gestureRecordingGeneration,
    gestureRecordingGeneration,
  );
  const recording = gestureDiagnosticsEnabled();
  const widthRef = useRef(width);
  widthRef.current = width;
  const diagnosticsRef = useRef(diagnostics);
  diagnosticsRef.current = diagnostics;
  const record = useCallback(
    (
      source: 'row' | 'swipe',
      event: string,
      extra?: { dx?: number; dy?: number; detail?: Record<string, string | number | boolean> },
    ) => {
      const tag = diagnosticsRef.current;
      // Swipe callbacks fire whether or not recording is on; keep them from
      // numbering rows outside a recording.
      if (!gestureDiagnosticsEnabled()) return;
      recordGesture({
        source,
        event,
        ...(tag ? { row: gestureRowNumber(tag.rowKey) } : {}),
        ...(tag?.projectKind ? { projectKind: tag.projectKind } : {}),
        ...extra,
      });
    },
    [],
  );
  const touchState = useSharedValue<{ x: number; y: number; reported: number } | null>(null);
  const observer = useMemo(
    () => rowTouchObserver(record, () => widthRef.current, touchState, recording, generation),
    [recording, record, touchState, generation],
  );
  // A locked row sets pointerEvents to none, so no touch reaches the observer
  // to report it; record the lock changes themselves instead.
  const lockedBefore = useRef(disabled);
  useEffect(() => {
    if (lockedBefore.current === disabled) return;
    lockedBefore.current = disabled;
    record('row', disabled ? 'locked' : 'unlocked');
  }, [disabled, record]);
  // Capture the instance before refs detach during unmount.
  useEffect(() => {
    const mounted = swipeable.current;
    return () => {
      if (openRow === mounted) openRow = null;
    };
  }, []);

  const row = (
    <View
      ref={container}
      // The observer below needs a native view to attach to.
      collapsable={Platform.OS !== 'web' ? false : undefined}
      pointerEvents={disabled ? 'none' : 'auto'}
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
    >
      <ReanimatedSwipeable
        enabled={!disabled}
        ref={swipeable}
        friction={1}
        leftThreshold={SWIPE_ACTION_WIDTH / 2}
        rightThreshold={SWIPE_ACTION_WIDTH / 2}
        dragOffsetFromLeftEdge={12}
        dragOffsetFromRightEdge={12}
        // The row slides over the action lanes, so it needs its own opaque
        // surface: on narrow screens it is a `<Link asChild>`, which drops the
        // row's style — background included — and would let the lanes and their
        // labels show through the session title.
        childrenContainerStyle={{ backgroundColor: theme.colors.surface }}
        onSwipeableOpenStartDrag={(direction) =>
          record('swipe', 'open-start-drag', { detail: { direction } })
        }
        onSwipeableCloseStartDrag={(direction) =>
          record('swipe', 'close-start-drag', { detail: { direction } })
        }
        onSwipeableWillOpen={(direction) => {
          record('swipe', 'will-open', { detail: { direction } });
          if (disabledRef.current) return;
          if (openRow && openRow !== swipeable.current) openRow.close();
          openRow = swipeable.current;
          const side = armed.current;
          armed.current = null;
          if (side) run(side);
        }}
        onSwipeableClose={() => {
          record('swipe', 'close');
          if (openRow === swipeable.current) openRow = null;
        }}
        {...(primary !== undefined
          ? {
              renderLeftActions: (
                _progress: SharedValue<number>,
                translation: SharedValue<number>,
              ) => (
                <SwipeAction
                  side="favorite"
                  label={primary.label}
                  icon={primary.icon}
                  translation={translation}
                  fullSwipe={fullSwipe}
                  onArm={onArm}
                  onPress={() => run('favorite')}
                />
              ),
            }
          : {})}
        renderRightActions={(_progress, translation) => (
          <SwipeAction
            side="delete"
            label="Delete"
            icon="trash-2"
            translation={translation}
            fullSwipe={fullSwipeTrailing}
            onArm={onArm}
            onPress={() => run('delete')}
            secondary={{
              label: 'Edit',
              icon: 'edit-2',
              onPress: () => {
                if (disabledRef.current) return;
                swipeable.current?.close();
                onEdit();
              },
            }}
          />
        )}
      >
        {children}
      </ReanimatedSwipeable>
      {menuAt ? (
        <SessionContextMenu
          at={menuAt}
          title={label}
          leading={primary}
          onClose={() => setMenuAt(null)}
          onEdit={onEdit}
          onDelete={onDelete}
        />
      ) : null}
    </View>
  );
  // Keep the swipeable's parent stable: toggling diagnostics must not remount
  // every row's animated state and gesture handlers.
  return Platform.OS !== 'web' ? <GestureDetector gesture={observer}>{row}</GestureDetector> : row;
}

/**
 * Records the touches a session row receives without ever activating, so it
 * cannot claim the touch from the swipe or reorder gestures. A recognizer that
 * activates on the same touch cancels it, which is itself recorded.
 */
function rowTouchObserver(
  record: (
    source: 'row',
    event: string,
    extra?: { dx?: number; dy?: number; detail?: Record<string, string | number | boolean> },
  ) => void,
  width: () => number,
  state: SharedValue<{ x: number; y: number; reported: number } | null>,
  enabled: boolean,
  generation: number,
) {
  const deliver = (
    event: string,
    dx: number | null,
    dy: number | null,
    uiReceivedWallMs: number | null,
  ) => {
    if (!gestureDiagnosticsEnabled() || gestureRecordingGeneration() !== generation) return;
    record('row', event, {
      ...(dx !== null && dy !== null ? { dx, dy } : {}),
      ...(uiReceivedWallMs !== null
        ? {
            detail: {
              ...(event === 'touch-down' ? { width: Math.round(width()) } : {}),
              uiReceivedWallMs,
              jsReceivedWallMs: Date.now(),
            },
          }
        : {}),
    });
  };
  return Gesture.Manual()
    .enabled(enabled)
    .onTouchesDown((event) => {
      'worklet';
      const touch = event.allTouches[0];
      state.value = touch ? { x: touch.absoluteX, y: touch.absoluteY, reported: 0 } : null;
      runOnJS(deliver)('touch-down', null, null, Date.now());
    })
    .onTouchesMove((event) => {
      'worklet';
      const touch = event.allTouches[0];
      const origin = state.value;
      if (!touch || !origin) return;
      const dx = Math.round(touch.absoluteX - origin.x);
      const dy = Math.round(touch.absoluteY - origin.y);
      const distance = Math.max(Math.abs(dx), Math.abs(dy));
      const marks = [6, 12, 24, 48];
      let reported = origin.reported;
      while (reported < marks.length && distance >= marks[reported]!) {
        runOnJS(deliver)(`move-${String(marks[reported])}`, dx, dy, null);
        reported++;
      }
      if (reported !== origin.reported) state.value = { ...origin, reported };
    })
    .onTouchesUp((event, manager) => {
      'worklet';
      const touch = event.changedTouches[0];
      const origin = state.value;
      runOnJS(deliver)(
        'touch-up',
        touch && origin ? Math.round(touch.absoluteX - origin.x) : null,
        touch && origin ? Math.round(touch.absoluteY - origin.y) : null,
        Date.now(),
      );
      if (event.numberOfTouches === 0) {
        state.value = null;
        manager.fail();
      }
    })
    .onTouchesCancelled((event, manager) => {
      'worklet';
      const touch = event.changedTouches[0];
      const origin = state.value;
      runOnJS(deliver)(
        'touch-cancelled',
        touch && origin ? Math.round(touch.absoluteX - origin.x) : null,
        touch && origin ? Math.round(touch.absoluteY - origin.y) : null,
        Date.now(),
      );
      state.value = null;
      manager.fail();
    });
}

function SwipeAction({
  side,
  label,
  icon,
  translation,
  fullSwipe,
  onArm,
  onPress,
  secondary,
}: {
  side: SwipeSide;
  label: string;
  icon: IconName;
  translation: SharedValue<number>;
  fullSwipe: number;
  onArm: (side: SwipeSide, on: boolean) => void;
  onPress: () => void;
  /** A second, non-destructive action resting between the row and this one. */
  secondary?: { label: string; icon: IconName; onPress: () => void };
}) {
  const tone = side === 'favorite' ? 'action' : 'destructive';
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
  const rest = SWIPE_ACTION_WIDTH * (secondary ? 2 : 1);
  // The lane follows the finger past its resting width; the outermost action
  // grows with it, so a long swipe fills the row with its color instead of
  // opening a gap.
  const lane = useAnimatedStyle(() => ({
    width: Math.max(rest, Math.abs(translation.value)),
  }));
  return (
    <Reanimated.View style={[styles.lane, lane]}>
      {secondary && !isArmed ? (
        <SwipeActionButton
          label={secondary.label}
          icon={secondary.icon}
          tone="action"
          onPress={secondary.onPress}
        />
      ) : null}
      <SwipeActionButton
        label={label}
        icon={icon}
        tone={tone}
        armed={isArmed}
        onPress={onPress}
        grow
      />
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
  leading,
  onClose,
  onEdit,
  onDelete,
}: {
  at: { x: number; y: number };
  title: string;
  leading: LeadingSwipeAction | undefined;
  onClose: () => void;
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
        {leading !== undefined ? (
          <MenuItem
            icon={leading.icon}
            label={leading.menuLabel}
            color={leading.active === true ? theme.colors.action : theme.colors.text}
            onPress={pick(leading.onPress)}
          />
        ) : null}
        <MenuItem icon="edit-2" label="Edit…" color={theme.colors.text} onPress={pick(onEdit)} />
        <View style={styles.menuDivider} />
        <MenuItem
          icon="trash-2"
          label="Delete…"
          color={theme.colors.attention}
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
    flexDirection: 'row',
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
    shadowColor: theme.elevation.floating.shadowColor,
    shadowOpacity: 0.35,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
    elevation: 12,
  },
  menuTitle: {
    color: theme.colors.textMuted,
    fontFamily: theme.fonts.regular,
    fontSize: theme.typography.footnote.fontSize,
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
    fontFamily: theme.fonts.regular,
    fontSize: theme.typography.bodySmall.fontSize,
  },
  menuDivider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: theme.colors.border,
    marginVertical: theme.spacing.xs,
    marginHorizontal: theme.spacing.xs + 2,
  },
}));
