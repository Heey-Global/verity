import { useCallback, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { Animated, PanResponder, View, useWindowDimensions, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet } from 'react-native-unistyles';

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

type PanHandlers = ReturnType<typeof PanResponder.create>['panHandlers'];

export function useResizableSheet(): {
  sheetStyle: Animated.WithAnimatedValue<ViewStyle>;
  panHandlers: PanHandlers;
} {
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const minSheetHeight = Math.min(windowHeight * 0.7, Math.max(300, windowHeight * 0.34));
  const maxSheetHeight = Math.max(minSheetHeight, windowHeight - insets.top - 12);
  const defaultSheetHeight = clamp(windowHeight * 0.7, minSheetHeight, maxSheetHeight);
  const sheetHeight = useRef(new Animated.Value(defaultSheetHeight)).current;
  const sheetHeightRef = useRef(defaultSheetHeight);
  const dragStartHeight = useRef(defaultSheetHeight);
  useEffect(() => {
    const next = clamp(sheetHeightRef.current, minSheetHeight, maxSheetHeight);
    sheetHeightRef.current = next;
    sheetHeight.setValue(next);
  }, [maxSheetHeight, minSheetHeight, sheetHeight]);
  const setClampedSheetHeight = useCallback(
    (next: number) => {
      const clamped = clamp(next, minSheetHeight, maxSheetHeight);
      sheetHeightRef.current = clamped;
      sheetHeight.setValue(clamped);
    },
    [maxSheetHeight, minSheetHeight, sheetHeight],
  );
  const settleSheetHeight = useCallback(
    (next: number) => {
      const clamped = clamp(next, minSheetHeight, maxSheetHeight);
      sheetHeightRef.current = clamped;
      Animated.spring(sheetHeight, {
        toValue: clamped,
        damping: 24,
        stiffness: 260,
        mass: 0.9,
        useNativeDriver: false,
      }).start();
    },
    [maxSheetHeight, minSheetHeight, sheetHeight],
  );
  const resizePan = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: (_event, gesture) => Math.abs(gesture.dy) > 2,
        onPanResponderGrant: () => {
          dragStartHeight.current = sheetHeightRef.current;
          sheetHeight.stopAnimation((height) => {
            sheetHeightRef.current = height;
            dragStartHeight.current = height;
          });
        },
        onPanResponderMove: (_event, gesture) => {
          setClampedSheetHeight(dragStartHeight.current - gesture.dy);
        },
        onPanResponderRelease: () => {
          settleSheetHeight(sheetHeightRef.current);
        },
        onPanResponderTerminate: () => {
          settleSheetHeight(sheetHeightRef.current);
        },
      }),
    [setClampedSheetHeight, settleSheetHeight, sheetHeight],
  );
  return {
    sheetStyle: {
      height: sheetHeight,
      maxHeight: maxSheetHeight,
      paddingBottom: insets.bottom + 12,
    },
    panHandlers: resizePan.panHandlers,
  };
}

export function SheetResizeHandle({ panHandlers }: { panHandlers: PanHandlers }) {
  return (
    <View
      style={styles.filesResizeHandle}
      {...panHandlers}
      accessibilityRole="adjustable"
      accessibilityLabel="Resize sheet"
    >
      <View style={styles.sheetHandle} />
    </View>
  );
}
/** The bottom sheet the session's lists open in — files, bookmarks and the
 *  other pickers: a surface that starts at 70% of the window and is resized by
 *  dragging its handle. The backdrop and the Modal stay with each caller, which
 *  decides what a tap outside means. */
export function ResizableSheetPanel({ children }: { children: ReactNode }) {
  const sheet = useResizableSheet();
  return (
    <Animated.View style={[styles.sheet, sheet.sheetStyle]}>
      <SheetResizeHandle panHandlers={sheet.panHandlers} />
      {children}
    </Animated.View>
  );
}

const styles = StyleSheet.create((theme) => ({
  sheet: {
    backgroundColor: theme.colors.surface,
    borderTopLeftRadius: theme.radius.lg,
    borderTopRightRadius: theme.radius.lg,
    borderTopWidth: 1,
    borderColor: theme.colors.border,
    paddingHorizontal: theme.spacing.lg,
    paddingTop: theme.spacing.sm,
    maxHeight: '70%',
  },
  sheetHandle: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: theme.radius.pill,
    backgroundColor: theme.colors.border,
    marginBottom: theme.spacing.sm,
  },
  filesResizeHandle: {
    alignItems: 'center',
    paddingTop: theme.spacing.xs,
    paddingBottom: theme.spacing.sm,
    marginTop: -theme.spacing.xs,
  },
}));
