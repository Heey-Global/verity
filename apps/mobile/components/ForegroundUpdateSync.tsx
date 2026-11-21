import { useEffect } from 'react';
import { AppState } from 'react-native';
import { downloadAppUpdate } from '../lib/automaticUpdates';

const FOREGROUND_UPDATE_POLL_MS = 30_000;

export function ForegroundUpdateSync() {
  useEffect(() => {
    let appState = AppState.currentState;
    const checkIfActive = (): void => {
      if (AppState.currentState === 'active') void downloadAppUpdate();
    };
    const subscription = AppState.addEventListener('change', (nextState) => {
      const becameActive = nextState === 'active' && appState !== 'active';
      appState = nextState;
      if (becameActive) void downloadAppUpdate();
    });
    checkIfActive();
    const timer = setInterval(checkIfActive, FOREGROUND_UPDATE_POLL_MS);
    return () => {
      subscription.remove();
      clearInterval(timer);
    };
  }, []);

  return null;
}
