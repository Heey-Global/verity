import { choiceCategorySpec, type LiveAlert } from '@verity/mobile';
import { CryptoDigestAlgorithm, digestStringAsync } from 'expo-crypto';
import * as Notifications from 'expo-notifications';
import { router } from 'expo-router';
import { Platform } from 'react-native';
import { toExpoActions } from './pushNotifications';

/** Whether this browser can show an alert in place of a push. Without it, a
 * focused tab must not claim the user's attention: the server would hold the
 * push back from their phone for something the browser cannot show. */
export function browserCanPresentAlerts(): boolean {
  return (
    Platform.OS === 'web' &&
    typeof Notification !== 'undefined' &&
    Notification.permission === 'granted'
  );
}

/** Native foreground alerts use local notifications and require presentation permission. */
export async function nativeCanPresentAlerts(): Promise<boolean> {
  return (await Notifications.getPermissionsAsync()).granted;
}

/**
 * Show a live alert — something the user has to act on, sent to this device
 * because it is the one in front of them. On iOS it is a local notification with
 * the same category, and therefore the same quick actions, as the push it
 * replaces; the foreground handler presents it as a banner with sound, and a tap
 * or an action is routed like any push response. A question with fixed options
 * gets a category with those options as buttons.
 */
export async function presentLiveAlert(alert: LiveAlert): Promise<void> {
  if (Platform.OS === 'web') {
    if (!browserCanPresentAlerts()) return;
    const notification = new Notification(alert.title, { body: alert.body, tag: alert.sessionId });
    notification.onclick = () => {
      window.focus();
      router.push({ pathname: '/session/[id]', params: { id: alert.sessionId } });
      notification.close();
    };
    return;
  }
  let categoryIdentifier = alert.categoryId;
  if (alert.kind === 'question' && alert.choices !== undefined && alert.choices.length > 0) {
    // Each notification keeps its own category so later questions cannot replace its labels.
    const spec = choiceCategorySpec(alert.choices);
    categoryIdentifier = `${spec.identifier}_${await digestStringAsync(CryptoDigestAlgorithm.SHA256, JSON.stringify(spec.actions))}`;
    await Notifications.setNotificationCategoryAsync(categoryIdentifier, toExpoActions(spec));
  }
  await Notifications.scheduleNotificationAsync({
    content: {
      title: alert.title,
      body: alert.body,
      sound: 'default',
      categoryIdentifier,
      data: {
        sessionId: alert.sessionId,
        kind: alert.kind,
        ...(alert.toolUseId !== undefined ? { toolUseId: alert.toolUseId } : {}),
        ...(alert.choices !== undefined ? { choices: alert.choices } : {}),
      },
    },
    trigger: null,
  });
}
