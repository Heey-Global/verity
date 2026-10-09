import { Alert, Platform } from 'react-native';

/** React Native Web has no Alert dialog; retain every action, including cancellation. */
export function installBrowserAlerts(): void {
  if (Platform.OS !== 'web') return;
  Alert.alert = (title, message, buttons) => {
    const dialog = document.createElement('dialog');
    dialog.setAttribute('aria-label', title);
    const heading = document.createElement('h2');
    heading.textContent = title;
    const body = document.createElement('p');
    body.textContent = message ?? '';
    dialog.append(heading, body);
    const close = (): void => {
      dialog.close();
      dialog.remove();
    };
    for (const action of buttons ?? [{ text: 'OK' }]) {
      const button = document.createElement('button');
      button.textContent = action.text ?? 'OK';
      button.addEventListener('click', () => {
        close();
        action.onPress?.();
      });
      dialog.append(button);
    }
    dialog.addEventListener('cancel', () => {
      close();
      buttons?.find((action) => action.style === 'cancel')?.onPress?.();
    });
    document.body.append(dialog);
    dialog.showModal();
  };
}
