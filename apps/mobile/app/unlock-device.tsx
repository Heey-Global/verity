import { MasterPasswordRoute } from './onboarding/master-password';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { unlockAuthTokenWithBiometrics, unlockServerSecretWithBiometrics } from '../lib/authToken';
import { createVerityClient, getVerityBaseUrl } from '../lib/client';
import { safeReturnTo } from '../lib/safeReturnTo';

export default function UnlockDevice() {
  const { theme } = useUnistyles();
  const params = useLocalSearchParams<{ returnTo?: string; serverSecret?: string }>();
  const returnTo = safeReturnTo(params.returnTo, '/') ?? '/';
  const mustUnlockServerSecret = params.serverSecret === '1';
  const tryBiometricTokenUnlock = !mustUnlockServerSecret;
  const tryBiometricSecretUnlock = mustUnlockServerSecret;
  const [checkingBiometrics, setCheckingBiometrics] = useState(
    tryBiometricTokenUnlock || tryBiometricSecretUnlock,
  );

  useEffect(() => {
    if (!tryBiometricTokenUnlock && !tryBiometricSecretUnlock) {
      setCheckingBiometrics(false);
      return;
    }
    let active = true;
    const baseUrl = getVerityBaseUrl();
    const attempt = tryBiometricSecretUnlock
      ? (() => {
          const client = createVerityClient();
          if (client === null) return Promise.resolve(false);
          return unlockServerSecretWithBiometrics(baseUrl, (password) =>
            client.unlockSecret(password),
          );
        })()
      : unlockAuthTokenWithBiometrics(baseUrl);
    void attempt
      .then((unlocked) => {
        if (!active) return;
        if (unlocked) {
          router.replace(returnTo);
          return;
        }
        setCheckingBiometrics(false);
      })
      .catch(() => {
        if (active) setCheckingBiometrics(false);
      });
    return () => {
      active = false;
    };
  }, [returnTo, tryBiometricSecretUnlock, tryBiometricTokenUnlock]);

  if (checkingBiometrics) {
    return (
      <View style={[styles.root, { backgroundColor: theme.colors.background }]}>
        <ActivityIndicator color={theme.colors.accent} />
      </View>
    );
  }

  return <MasterPasswordRoute returnTo={returnTo} />;
}

const styles = StyleSheet.create(() => ({
  root: {
    alignItems: 'center',
    flex: 1,
    justifyContent: 'center',
  },
}));
