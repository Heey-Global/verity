import { APP_HELP_TOPICS } from '@verity/events';
import { MasterPasswordRoute } from './onboarding/master-password';
import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import {
  canUseBiometricUnlock,
  isBiometricUnlockEnabled,
  unlockAuthTokenWithBiometrics,
  unlockServerSecretWithBiometrics,
} from '../lib/authToken';
import { createVerityClient, getVerityBaseUrl } from '../lib/client';
import { safeReturnTo } from '../lib/safeReturnTo';

export default function UnlockDevice() {
  const { theme } = useUnistyles();
  const params = useLocalSearchParams<{ returnTo?: string; serverSecret?: string }>();
  const returnTo = safeReturnTo(params.returnTo, '/') ?? '/';
  const mustUnlockServerSecret = params.serverSecret === '1';
  const [checkingBiometrics, setCheckingBiometrics] = useState(true);
  const [biometricRetry, setBiometricRetry] = useState(false);
  const attemptRef = useRef(0);

  const attemptBiometrics = useCallback(() => {
    const attemptId = ++attemptRef.current;
    const current = () => attemptRef.current === attemptId;
    setCheckingBiometrics(true);
    const baseUrl = getVerityBaseUrl();
    const attempt = mustUnlockServerSecret
      ? (async () => {
          const client = createVerityClient();
          const unlocked =
            client === null
              ? false
              : await unlockServerSecretWithBiometrics(baseUrl, (password) =>
                  client.unlockSecret(password),
                );
          if (unlocked) return true;
          // The store is still sealed and this device holds no Face ID-protected
          // master password — a QR-paired device never sees one. Load its bearer
          // so the manual unlock below can prove the device: /secret/unlock
          // rejects an unproven device before it ever compares the password, and
          // the form can only report that as a wrong password.
          await unlockAuthTokenWithBiometrics(baseUrl);
          return false;
        })()
      : unlockAuthTokenWithBiometrics(baseUrl);
    void attempt
      .catch(() => false)
      .then(async (unlocked) => {
        if (!current()) return;
        if (unlocked) {
          router.replace(returnTo);
          return;
        }
        // One failed read (a cancelled prompt, an unmatched face, an interrupted
        // launch) must not strand the device on a password form that cannot
        // prove it: offer the read again instead of requiring an app restart.
        const retry = await Promise.all([
          isBiometricUnlockEnabled(baseUrl),
          canUseBiometricUnlock(),
        ]).then(
          ([enabled, canUse]) => enabled && canUse,
          () => false,
        );
        if (!current()) return;
        setBiometricRetry(retry);
        setCheckingBiometrics(false);
      });
  }, [mustUnlockServerSecret, returnTo]);

  useEffect(() => {
    attemptBiometrics();
    return () => {
      attemptRef.current++;
    };
  }, [attemptBiometrics]);

  // Returning from the background retries the read. Only a real background
  // transition counts: the Face ID sheet itself moves the app through
  // `inactive`, and retrying on that would re-open a prompt the user cancelled.
  useEffect(() => {
    if (!biometricRetry || checkingBiometrics) return;
    let previous = AppState.currentState;
    const subscription = AppState.addEventListener('change', (next) => {
      const fromBackground = previous === 'background';
      previous = next;
      if (next === 'active' && fromBackground) attemptBiometrics();
    });
    return () => subscription.remove();
  }, [attemptBiometrics, biometricRetry, checkingBiometrics]);

  if (checkingBiometrics) {
    return (
      <View style={[styles.root, { backgroundColor: theme.colors.background }]}>
        <ActivityIndicator color={theme.colors.textMuted} />
      </View>
    );
  }

  return (
    <MasterPasswordRoute
      returnTo={returnTo}
      restartExplanation={
        mustUnlockServerSecret
          ? APP_HELP_TOPICS.find((topic) => topic.id === 'secrets-storage')?.emptyState
          : undefined
      }
      onBiometricUnlock={biometricRetry ? attemptBiometrics : undefined}
    />
  );
}

const styles = StyleSheet.create(() => ({
  root: {
    alignItems: 'center',
    flex: 1,
    justifyContent: 'center',
  },
}));
