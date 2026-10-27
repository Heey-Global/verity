import { useSyncExternalStore } from 'react';
import { Platform, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import {
  currentBrowserAlert,
  dismissBrowserAlert,
  subscribeBrowserAlerts,
} from '../../lib/browserAlerts';
import { Button } from './Button';
import { Sheet } from './Sheet';

/** Render every browser Alert through the same controls as native app sheets. */
export function BrowserAlertHost() {
  const request = useSyncExternalStore(
    subscribeBrowserAlerts,
    currentBrowserAlert,
    () => undefined,
  );
  if (Platform.OS !== 'web' || !request) return null;
  const [title, message, buttons, options] = request;
  const actions = buttons?.length ? buttons : [{ text: 'OK' }];
  const cancel = () => {
    dismissBrowserAlert();
    const action = actions.find((action) => action.style === 'cancel');
    if (action) action.onPress?.();
    else options?.onDismiss?.();
  };
  return (
    <Sheet
      visible
      title={title}
      onClose={cancel}
      dismissible={options?.cancelable !== false}
      footer={
        <View style={styles.actions}>
          {actions.map((action, index) => (
            <Button
              key={index}
              label={action.text ?? 'OK'}
              variant={
                action.style === 'destructive'
                  ? 'destructive'
                  : action.style === 'cancel'
                    ? 'secondary'
                    : 'primary'
              }
              onPress={() => {
                dismissBrowserAlert();
                action.onPress?.();
              }}
            />
          ))}
        </View>
      }
    >
      {message ? <Text style={styles.message}>{message}</Text> : null}
    </Sheet>
  );
}
const styles = StyleSheet.create((theme) => ({
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.sm },
  message: { ...theme.typography.body, color: theme.colors.textMuted },
}));
