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
