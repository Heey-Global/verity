import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { AccessibilityInfo, Modal, Platform, View } from 'react-native';
import ReanimatedSwipeable, {
  type SwipeableMethods,
} from 'react-native-gesture-handler/ReanimatedSwipeable';
import { StyleSheet } from 'react-native-unistyles';

import { Button } from '../ui';
import { FileActionMenu } from './FileActionMenu';

/** File actions never fire on a full swipe: revealing the action and choosing
 * it are separate steps, including for folders. Navigation stays on the row. */
export function FileRowActions({
  children,
  label,
  onDelete,
  onMenu,
  onMove,
  moveLabel = 'Move',
  disabled = false,
  deleteLabel = 'Delete',
}: {
  children: ReactNode;
  label: string;
  onDelete?: (() => void) | undefined;
  onMenu?: (() => void) | undefined;
  onMove?: (() => void) | undefined;
  moveLabel?: string;
  disabled?: boolean;
  deleteLabel?: string;
}) {
  const target = useRef<View>(null);
  const swipeable = useRef<SwipeableMethods>(null);
  const [menu, setMenu] = useState(false);
  const [screenReader, setScreenReader] = useState(false);
  const available = !disabled && Boolean(onDelete || onMenu || onMove);
  const openMenu = useCallback(() => {
    if (!available) return;
    swipeable.current?.close();
    if (onMenu) onMenu();
    else setMenu(true);
  }, [available, onMenu]);
  const remove = useCallback(() => {
    if (!available) return;
    swipeable.current?.close();
    onDelete?.();
  }, [available, onDelete]);

  const move = useCallback(() => {
    if (!available) return;
    swipeable.current?.close();
    onMove?.();
  }, [available, onMove]);

  useEffect(() => {
    let active = true;
    void AccessibilityInfo.isScreenReaderEnabled().then((enabled) => {
      if (active) setScreenReader(enabled);
    });
    const subscription = AccessibilityInfo.addEventListener('screenReaderChanged', setScreenReader);
    return () => {
      active = false;
      subscription.remove();
    };
  }, []);
  useEffect(() => {
    if (!available) {
      setMenu(false);
      swipeable.current?.close();
    }
  }, [available]);
  useEffect(() => {
    if (Platform.OS !== 'web' || !available) return;
    const element = target.current as unknown as HTMLElement | null;
    if (!element?.addEventListener) return;
    return bindFileRowShortcuts(element, openMenu, onDelete ? remove : undefined);
  }, [available, onDelete, openMenu, remove]);

  return (
    <View ref={target} testID={`file-actions-${label}`}>
      {(onDelete || onMenu || onMove) && available && !screenReader ? (
        <ReanimatedSwipeable
          ref={swipeable}
          overshootRight={false}
          renderRightActions={() => (
            <View style={styles.deleteAction}>
              {onMove ? (
                <Button label={moveLabel} variant="secondary" size="compact" onPress={move} />
              ) : null}
              {onMenu ? (
                <Button label="Actions" variant="secondary" size="compact" onPress={openMenu} />
              ) : null}
              {onDelete ? (
                <Button label={deleteLabel} variant="destructive" size="compact" onPress={remove} />
              ) : null}
            </View>
          )}
        >
          {children}
        </ReanimatedSwipeable>
      ) : (
        children
      )}
      {screenReader && available ? (
        <Button label={`Actions for ${label}`} variant="text" size="compact" onPress={openMenu} />
      ) : null}
      {menu && available && onDelete ? (
        <Modal transparent visible onRequestClose={() => setMenu(false)} animationType="fade">
          <FileActionMenu
            title={label}
            actions={[
              ...(onMove
                ? [{ key: 'move', label: moveLabel, icon: 'folder' as const, onPress: move }]
                : []),
              {
                key: 'delete',
                label: deleteLabel,
                icon: 'trash-2',
                destructive: true,
                onPress: remove,
              },
            ]}
            onDismiss={() => setMenu(false)}
          />
        </Modal>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  deleteAction: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.xs,
    paddingHorizontal: theme.spacing.sm,
    backgroundColor: theme.colors.surface,
  },
}));

/** Attach to the row container so shortcuts also work while its child has focus. */
export function bindFileRowShortcuts(
  element: Pick<HTMLElement, 'addEventListener' | 'removeEventListener'>,
  openMenu: () => void,
  remove?: () => void,
): () => void {
  const context = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    openMenu();
  };
  const keyboard = (event: KeyboardEvent) => {
    // A text field inside a row must keep its normal editing shortcuts.
    const source = event.target as HTMLElement | null;
    if (source?.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(source?.tagName ?? ''))
      return;
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
      event.preventDefault();
      event.stopPropagation();
      openMenu();
    } else if (event.key === 'Delete' && remove && !event.repeat) {
      event.preventDefault();
      event.stopPropagation();
      remove();
    }
  };
  element.addEventListener('contextmenu', context);
  element.addEventListener('keydown', keyboard);
  return () => {
    element.removeEventListener('contextmenu', context);
    element.removeEventListener('keydown', keyboard);
  };
}
