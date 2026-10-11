import { useCallback, useState } from 'react';
import { AppState, InteractionManager, Keyboard, Platform, TextInput } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { useAnimatedStyle } from 'react-native-reanimated';

function hasFocusedKeyboard(): boolean {
  // Visibility is cached from keyboard events. A detached/blurred field must
  // not keep an old "shown" value alive after navigation dismissed its keyboard.
  return Keyboard.isVisible() && TextInput.State.currentlyFocusedInput() != null;
}

export function useSessionKeyboardAvoidance() {
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
      const hide = Keyboard.addListener('keyboardDidHide', () => {
        opening = false;
        setEnabled(false);
      });
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
        appState.remove();
        setEnabled(false);
      };
    }, []),
  );

  // Disabling the controller returns an empty animated style, which does not
  // unset padding already written by Reanimated on a retained screen.
  // Returning {} again would retain our zero and compete with the controller
  // when the keyboard opens. Explicitly release the animated override.
  const resetStyle = useAnimatedStyle(
    () => ({ paddingBottom: enabled ? undefined : 0 }),
    [enabled],
  );
  return { enabled, resetStyle };
}
