import { useCallback, useState } from 'react';
import { AppState, InteractionManager, Keyboard, Platform } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { useAnimatedStyle } from 'react-native-reanimated';

export function useSessionKeyboardAvoidance() {
  // The controller can retain the previous screen's animated height while a
  // navigation transition dismisses its keyboard. Do not inherit that gap.
  const [enabled, setEnabled] = useState(() => Keyboard.isVisible());

  useFocusEffect(
    useCallback(() => {
      const reconcile = () => setEnabled(Keyboard.isVisible());
      const show = (
        Platform.OS === 'ios' ? ['keyboardWillShow', 'keyboardDidShow'] : ['keyboardDidShow']
      ).map((event) =>
        Keyboard.addListener(event as 'keyboardWillShow' | 'keyboardDidShow', () =>
          setEnabled(true),
        ),
      );
      // Keep following the controller throughout the closing animation.
      const hide = Keyboard.addListener('keyboardDidHide', () => setEnabled(false));
      const appState = AppState.addEventListener('change', (state) => {
        if (state === 'active') reconcile();
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
  const resetStyle = useAnimatedStyle(() => (enabled ? {} : { paddingBottom: 0 }), [enabled]);
  return { enabled, resetStyle };
}
