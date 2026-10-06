import type { LiveConnection } from '@verity/mobile';
import { useEffect } from 'react';
import { AppState, Platform } from 'react-native';
import { getAuthToken, subscribeAuthToken } from '../lib/authToken';
import { getVerityBaseUrl } from '../lib/client';
import { isDemoMode } from '../lib/demoMode';
import { browserCanPresentAlerts, presentLiveAlert } from '../lib/liveAlerts';
import { liveConnectionFor, stopLiveConnection } from '../lib/liveConnection';

/** Whether the user is looking at the app right now. A browser tab counts only
 * while visible, focused, and able to show an alert: otherwise the server would
 * keep a push from the phone for something nobody sees. */
function inForeground(): boolean {
  if (Platform.OS === 'web') {
    return (
      typeof document !== 'undefined' &&
      document.visibilityState === 'visible' &&
      document.hasFocus() &&
      browserCanPresentAlerts()
    );
  }
  return AppState.currentState === 'active';
}

/**
 * Owns the app's live connection: opens it once the device can authenticate
 * (a biometric unlock loads the bearer after mount), closes it in the
 * background — so the server stops counting this device as the one in use the
 * moment the user leaves — and reports whether the user is looking at it.
 * Alerts the server routes to this device are presented here.
 */
export function LiveConnectionLifecycle(): null {
  useEffect(() => {
    let current: { baseUrl: string; connection: LiveConnection; detach: () => void } | undefined;

    const sync = (): void => {
      const baseUrl = getVerityBaseUrl();
      if (current !== undefined && current.baseUrl !== baseUrl) {
        current.detach();
        stopLiveConnection(current.baseUrl);
        current = undefined;
      }
      if (baseUrl === null) return;
      if (current === undefined) {
        const connection = liveConnectionFor(baseUrl);
        const detach = connection.onAlert((alert) => {
          void presentLiveAlert(alert).catch(() => undefined);
        });
        current = { baseUrl, connection, detach };
      }
      const { connection } = current;
      // The browser authenticates with its session cookie; a native device waits
      // for its bearer, and the demo needs none.
      const canAuthenticate =
        isDemoMode() || Platform.OS === 'web' || getAuthToken(baseUrl) !== null;
      if (!canAuthenticate) {
        connection.pause();
        return;
      }
      connection.start();
      if (Platform.OS !== 'web' && AppState.currentState === 'background') {
        connection.pause();
        return;
      }
      connection.resume();
      connection.setForeground(inForeground());
    };

    sync();
    const unsubscribeAuth = subscribeAuthToken(sync);
    const appState = AppState.addEventListener('change', sync);
    const web = Platform.OS === 'web' && typeof window !== 'undefined';
    if (web) {
      document.addEventListener('visibilitychange', sync);
      window.addEventListener('focus', sync);
      window.addEventListener('blur', sync);
    }
    return () => {
      unsubscribeAuth();
      appState.remove();
      if (web) {
        document.removeEventListener('visibilitychange', sync);
        window.removeEventListener('focus', sync);
        window.removeEventListener('blur', sync);
      }
      // Paused, not stopped: a remount (the demo toggle remounts the whole tree)
      // renders its screens — which take this same connection — before this
      // cleanup runs, and resumes it on mount.
      current?.detach();
      current?.connection.pause();
    };
  }, []);
  return null;
}
