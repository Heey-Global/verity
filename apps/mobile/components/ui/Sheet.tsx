import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  AccessibilityInfo,
  Animated,
  Modal,
  PanResponder,
  Platform,
  Pressable,
  ScrollView,
  Text,
  View,
} from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Icon } from '../Icon';
import { Button } from './Button';

// How far the sheet has to be dragged down before letting go closes it.
const DISMISS_DISTANCE = 80;

/**
 * The one bottom sheet (docs/design-system.md § 5.6): a single scrim, a grab
 * handle, a title with a close control, content built from the same components
 * as screens, and an optional footer for at most one primary action. Tapping
 * the scrim, going back, dragging the handle down or pressing close all call
 * `onClose` — unless `dismissible` is false while something is running.
 */
export function Sheet({
  visible,
  title,
  onClose,
  children,
  footer,
  showClose = true,
  dismissible = true,
}: {
  visible: boolean;
  title: string;
  onClose: () => void;
  children?: ReactNode;
  footer?: ReactNode;
  showClose?: boolean;
  dismissible?: boolean;
}) {
  const insets = useSafeAreaInsets();
  const { theme } = useUnistyles();
  const drag = useRef(new Animated.Value(0)).current;
  const close = () => {
    if (dismissible) onClose();
  };
  const closeRef = useRef(close);
  closeRef.current = close;
  const pan = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, gesture) => gesture.dy > 4,
      onPanResponderMove: (_, gesture) => drag.setValue(Math.max(0, gesture.dy)),
      onPanResponderRelease: (_, gesture) => {
        if (gesture.dy > DISMISS_DISTANCE) closeRef.current();
        Animated.spring(drag, { toValue: 0, useNativeDriver: Platform.OS !== 'web' }).start();
      },
    }),
  ).current;

  return (
    // On Android a Modal is its own window; keyboard-controller only receives
    // the keyboard's insets there when the window draws behind the system bars.
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={close}
      statusBarTranslucent
      navigationBarTranslucent
    >
      <Pressable
        style={styles.scrim}
        onPress={close}
        accessibilityRole="button"
        accessibilityLabel="Close"
        testID="sheet-scrim"
      />
      <KeyboardAvoidingView behavior="padding" style={styles.anchor} pointerEvents="box-none">
        <Animated.View
          style={[
            styles.sheet,
            { paddingBottom: insets.bottom + theme.spacing.lg },
            { transform: [{ translateY: drag }] },
          ]}
          accessibilityViewIsModal
          onAccessibilityEscape={close}
        >
          <View {...pan.panHandlers} style={styles.grabArea}>
            <View style={styles.handle} />
            <View style={styles.header}>
              <Text style={styles.title} accessibilityRole="header">
                {title}
              </Text>
              {showClose ? (
                <Pressable
                  onPress={close}
                  disabled={!dismissible}
                  accessibilityRole="button"
                  accessibilityLabel="Close"
                  hitSlop={8}
                  style={styles.close}
                >
                  <Icon name="x" size={16} color={theme.colors.textMuted} />
                </Pressable>
              ) : null}
            </View>
          </View>
          {/* Tall content scrolls so the footer action stays reachable, also
              above the keyboard. */}
          <ScrollView
            style={styles.scroll}
            contentContainerStyle={styles.content}
            keyboardShouldPersistTaps="handled"
            bounces={false}
          >
            {children}
          </ScrollView>
          {footer !== undefined ? <View style={styles.footer}>{footer}</View> : null}
        </Animated.View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

/**
 * A confirmation as a compact sheet (§ 5.7): the question as the title, one
 * sentence about the consequence, Cancel and the action as a verb. Any way of
 * dismissing it cancels; only the action button confirms. While `onConfirm`
 * runs, its button spins and the sheet cannot be dismissed. If it throws, the
 * sheet stays open so the caller can show what went wrong.
 */
export function ConfirmSheet({
  visible,
  title,
  message,
  confirmLabel,
  destructive = false,
  onConfirm,
  onCancel,
}: {
  visible: boolean;
  /** The question: "Turn off Online sharing?" */
  title: string;
  /** One sentence about the consequence. */
  message: string;
  /** A verb: "Turn off", "Remove key". */
  confirmLabel: string;
  destructive?: boolean;
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
}) {
  // `running` follows the action, not visibility: a sheet reopened while its
  // previous action is still pending shows the spinner until that settles.
  const [running, setRunning] = useState(false);
  // State only locks the button after the next render; two taps delivered
  // before it would both start the action. The ref locks synchronously.
  const inFlight = useRef(false);
  useEffect(() => {
    if (visible) AccessibilityInfo.announceForAccessibility(`${title} ${message}`);
  }, [visible, title, message]);
  const confirm = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setRunning(true);
    try {
      await onConfirm();
    } catch {
      // The caller reports the failure; the sheet stays open for another try.
    } finally {
      inFlight.current = false;
      setRunning(false);
    }
  };
  return (
    <Sheet
      visible={visible}
      title={title}
      onClose={onCancel}
      showClose={false}
      dismissible={!running}
      footer={
        <View style={styles.confirmButtons}>
          <View style={styles.confirmButton}>
            <Button
              label="Cancel"
              variant="secondary"
              onPress={onCancel}
              disabled={running}
              fullWidth
            />
          </View>
          <View style={styles.confirmButton}>
            <Button
              label={confirmLabel}
              variant={destructive ? 'destructive' : 'primary'}
              onPress={() => void confirm()}
              loading={running}
              fullWidth
            />
          </View>
        </View>
      }
    >
      <Text style={styles.message}>{message}</Text>
    </Sheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  scrim: { ...StyleSheet.absoluteFillObject, backgroundColor: theme.colors.scrim },
  anchor: { flex: 1, justifyContent: 'flex-end' },
  sheet: {
    width: '100%',
    maxWidth: 760,
    alignSelf: 'center',
    maxHeight: '90%',
    backgroundColor: theme.colors.surface,
    borderTopLeftRadius: theme.radius.card,
    borderTopRightRadius: theme.radius.card,
    borderWidth: 1,
    borderBottomWidth: 0,
    borderColor: theme.colors.border,
    ...theme.elevation.floating,
    shadowOffset: { width: 0, height: -theme.elevation.floating.shadowOffset.height },
  },
  grabArea: { paddingTop: theme.spacing.sm, paddingHorizontal: theme.spacing.lg },
  handle: {
    width: 38,
    height: 5,
    borderRadius: 3,
    alignSelf: 'center',
    backgroundColor: theme.colors.border,
    marginBottom: theme.spacing.md,
  },
  header: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.md },
  title: { ...theme.typography.title, color: theme.colors.text, flex: 1 },
  close: {
    width: 32,
    height: 32,
    borderRadius: theme.radius.tile,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.surfaceAlt,
  },
  scroll: { flexGrow: 0, flexShrink: 1 },
  content: {
    paddingHorizontal: theme.spacing.lg,
    paddingTop: theme.spacing.md,
    gap: theme.spacing.md,
  },
  footer: { paddingHorizontal: theme.spacing.lg, paddingTop: theme.spacing.lg },
  message: { ...theme.typography.body, color: theme.colors.textMuted },
  confirmButtons: { flexDirection: 'row', gap: theme.spacing.sm },
  confirmButton: { flex: 1 },
}));
