import { Alert, Platform } from 'react-native';

type AlertRequest = Parameters<typeof Alert.alert>;
const pending: AlertRequest[] = [];
const listeners = new Set<() => void>();
export function subscribeBrowserAlerts(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function currentBrowserAlert(): AlertRequest | undefined {
  return pending[0];
}
export function dismissBrowserAlert(): void {
  pending.shift();
  for (const listener of listeners) listener();
}

/** Keep web alerts inside the themed UI, including queued prompts and cancellation. */
export function installBrowserAlerts(): void {
  if (Platform.OS !== 'web') return;
  Alert.alert = (...request) => {
    pending.push(request);
    for (const listener of listeners) listener();
  };
}
