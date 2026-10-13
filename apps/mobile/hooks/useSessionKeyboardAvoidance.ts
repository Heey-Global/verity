import { useCallback, useRef, useState } from 'react';
import {
  AppState,
  InteractionManager,
  Keyboard,
  findNodeHandle,
  Platform,
  TextInput,
  useWindowDimensions,
  type View,
} from 'react-native';
import { useFocusEffect } from 'expo-router';
import {
  KeyboardControllerNative,
  KeyboardEvents,
  useReanimatedKeyboardAnimation,
} from 'react-native-keyboard-controller';
import { useAnimatedStyle, useSharedValue } from 'react-native-reanimated';

function hasFocusedKeyboard(): boolean {
  // Visibility is cached from keyboard events. A detached/blurred field must
  // not keep an old "shown" value alive after navigation dismissed its keyboard.
  return Keyboard.isVisible() && TextInput.State.currentlyFocusedInput() != null;
}

export function useSessionKeyboardAvoidance() {
  const frameRef = useRef<View>(null);
  const { height: windowHeight } = useWindowDimensions();
  const frameBottom = useSharedValue(windowHeight);
  const { height } = useReanimatedKeyboardAnimation();
  const layoutRevision = useRef(0);
  const onLayout = useCallback(() => {
    // RN's parent-relative measurements can omit the navigation header.
    // The controller measures the native host directly in window coordinates.
    const revision = ++layoutRevision.current;
    if (Platform.OS === 'web') {
      frameRef.current?.measureInWindow((_x, y, _width, frameHeight) => {
        if (revision === layoutRevision.current) frameBottom.value = y + frameHeight;
      });
      return;
    }
    const tag = findNodeHandle(frameRef.current);
    if (tag === null) return;
    return KeyboardControllerNative.viewPositionInWindow(tag)
      .then(({ y, height: frameHeight }) => {
        if (revision === layoutRevision.current) frameBottom.value = y + frameHeight;
      })
      .catch(() => {
        // Keep the last valid window measurement if navigation detached the view.
      });
  }, [frameBottom]);

  // The controller can retain the previous screen's animated height while a
  // navigation transition dismisses its keyboard. Do not inherit that gap.
  const [enabled, setEnabled] = useState(hasFocusedKeyboard);

  useFocusEffect(
    useCallback(() => {
      let opening = false;
      const reconcile = () =>
        setEnabled(
          hasFocusedKeyboard() || (opening && TextInput.State.currentlyFocusedInput() != null),
        );
      const show = (
        Platform.OS === 'ios' ? ['keyboardWillShow', 'keyboardDidShow'] : ['keyboardDidShow']
      ).map((event) =>
        Keyboard.addListener(event as 'keyboardWillShow' | 'keyboardDidShow', () => {
          // RN's cached visibility stays false until did-show. A pending
          // navigation reconciliation must not disable an opening keyboard.
          opening = event === 'keyboardWillShow';
          setEnabled(true);
        }),
      );
      // Keep following the controller throughout the closing animation.
      const onHide = () => {
        opening = false;
        setEnabled(false);
      };
      const hide = Keyboard.addListener('keyboardDidHide', onHide);
      // Clearing/remounting the composer can lose RN's did-hide event. The
      // controller completes its own dismissal and must release the padding too.
      const controllerHide = KeyboardEvents.addListener('keyboardDidHide', onHide);
      const appState = AppState.addEventListener('change', (state) => {
        if (state === 'active') {
          opening = false;
          reconcile();
        }
      });
      reconcile();
      const transition = InteractionManager.runAfterInteractions(reconcile);
      return () => {
        transition.cancel();
        show.forEach((listener) => listener.remove());
        hide.remove();
        controllerHide.remove();
        appState.remove();
        setEnabled(false);
      };
    }, []),
  );

  // One worklet owns padding both while following the keyboard and while
  // clearing stale navigation height. Separate animated styles can overwrite
  // each other: releasing a zero with `undefined` can erase the live padding.
  const frameStyle = useAnimatedStyle(
    () => ({
      paddingBottom: enabled ? Math.max(0, frameBottom.value - windowHeight - height.value) : 0,
    }),
    [enabled, windowHeight],
  );
  return { enabled, frameRef, onLayout, frameStyle };
}
