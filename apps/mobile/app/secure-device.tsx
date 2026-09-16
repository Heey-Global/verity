// Face ID opt-in for a device that was paired from an already-paired device.
// QR pairing mints this device's bearer without ever showing the master-password
// step — which is the only other place the opt-in is offered — so a paired iPad
// would otherwise reach its first cold start with no biometric credential and no
// local master password: the unlock screen can then only offer the password form,
// and the server rejects it for want of a device bearer.
//
// Reached with `?returnTo=`; it decides silently and forwards whenever there is
// nothing to ask (already enabled, or no biometric hardware/enrollment).
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { BiometricConsent } from '../components/BiometricConsent';
import {
  canUseBiometricUnlock,
  disableBiometricUnlock,
  enableBiometricUnlock,
  isBiometricUnlockEnabled,
} from '../lib/authToken';
import { getVerityBaseUrl } from '../lib/client';
import { safeReturnTo } from '../lib/safeReturnTo';

export default function SecureDevice() {
  const { theme } = useUnistyles();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ returnTo?: string }>();
  const returnTo = safeReturnTo(params.returnTo, '/') ?? '/';
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    void Promise.all([isBiometricUnlockEnabled(getVerityBaseUrl()), canUseBiometricUnlock()])
      .then(([enabled, canUse]) => {
        if (!active) return;
        if (!enabled && canUse) {
          setAsking(true);
          return;
        }
        router.replace(returnTo);
      })
      .catch(() => {
        // Never strand the operator on this screen: the pairing already succeeded
        // and the device holds a usable token either way.
        if (active) router.replace(returnTo);
      });
    return () => {
      active = false;
    };
  }, [returnTo]);

  // A declined or failed prompt is not an error here — it only means the token
  // stays unprotected, which the launch restore handles.
  const answer = (enable: boolean) => {
    if (busy) return;
    setBusy(true);
    const baseUrl = getVerityBaseUrl();
    void (enable ? enableBiometricUnlock(baseUrl) : disableBiometricUnlock(baseUrl))
      .catch(() => undefined)
      .finally(() => {
        setBusy(false);
        router.replace(returnTo);
      });
  };

  if (!asking) {
    return (
      <View style={[styles.root, styles.center]}>
        <ActivityIndicator color={theme.colors.accent} />
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <ScrollView contentContainerStyle={[styles.content, { paddingTop: insets.top + 32 }]}>
        <Text style={styles.eyebrow}>Device paired</Text>
        <Text style={styles.title} accessibilityRole="header">
          Secure this device
        </Text>
        <BiometricConsent busy={busy} onEnable={() => answer(true)} onSkip={() => answer(false)} />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  center: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  content: {
    flexGrow: 1,
    width: '100%',
    maxWidth: 760,
    alignSelf: 'center',
    gap: theme.spacing.md,
    justifyContent: 'center',
    paddingHorizontal: theme.spacing.lg,
    paddingBottom: theme.spacing.xl,
  },
  eyebrow: {
    color: theme.colors.accent,
    fontSize: theme.text.xs,
    fontWeight: '800',
    textTransform: 'uppercase',
  },
  title: {
    color: theme.colors.text,
    fontSize: theme.text.xl,
    fontWeight: '800',
  },
}));
