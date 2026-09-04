import type { PairedDevice } from '@verity/mobile';
import * as Clipboard from 'expo-clipboard';
import { Stack, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, Text, View } from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { createVerityClient } from '../lib/client';
import { createPairingUri } from '../lib/pairing';
import { getServerProfile } from '../lib/serverProfile';

export default function DevicesScreen() {
  const { theme } = useUnistyles();
  const insets = useSafeAreaInsets();
  const client = useMemo(() => {
    const configured = createVerityClient();
    if (configured === null) throw new Error('No Verity server is configured.');
    return configured;
  }, []);
  const [devices, setDevices] = useState<PairedDevice[]>([]);
  const [pairingInvitation, setPairingInvitation] = useState<{
    link: string;
    expiresAt: number;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    void client
      .listPairedDevices()
      .then(setDevices)
      .catch((caught: unknown) =>
        setError(caught instanceof Error ? caught.message : 'Could not load paired devices.'),
      )
      .finally(() => setLoading(false));
  }, [client]);
  useFocusEffect(load);

  useEffect(() => {
    if (pairingInvitation === null) return;
    const remaining = pairingInvitation.expiresAt - Date.now();
    if (remaining <= 0) {
      setPairingInvitation(null);
      return;
    }
    const timeout = setTimeout(() => setPairingInvitation(null), remaining);
    return () => clearTimeout(timeout);
  }, [pairingInvitation]);

  const createInvitation = () => {
    const profile = getServerProfile();
    const direct =
      profile?.endpoints.find(
        (endpoint) =>
          endpoint.url === profile.activeUrl && endpoint.transport === 'direct' && endpoint.tlsPin,
      ) ??
      profile?.endpoints.find((endpoint) => endpoint.transport === 'direct' && endpoint.tlsPin);
    if (profile === null || profile === undefined || direct?.tlsPin === undefined) {
      setError('A directly paired server profile is required to add another device.');
      return;
    }
    setWorking(true);
    setError(null);
    void client
      .createPairingInvitation()
      .then((invitation) => {
        const expiresAt = Date.parse(invitation.expiresAt);
        if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
          throw new Error('The server returned an expired pairing code.');
        }
        setPairingInvitation({
          link: createPairingUri({
            version: 1,
            kind: 'device',
            serverId: profile.serverId,
            identityKey: profile.identityKey,
            tlsPin: direct.tlsPin!,
            pairingCode: invitation.code,
            suggestedUrl: direct.url,
            expiresAt: invitation.expiresAt,
          }),
          expiresAt,
        });
      })
      .catch((caught: unknown) =>
        setError(caught instanceof Error ? caught.message : 'Could not create a pairing code.'),
      )
      .finally(() => setWorking(false));
  };

  const revoke = (device: PairedDevice) => {
    Alert.alert(
      'Remove paired device?',
      device.label ?? 'This device will lose access to Verity.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: () => {
            setWorking(true);
            void client
              .revokePairedDevice(device.id)
              .then(load)
              .catch((caught: unknown) =>
                setError(caught instanceof Error ? caught.message : 'Could not remove the device.'),
              )
              .finally(() => setWorking(false));
          },
        },
      ],
    );
  };

  return (
    <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 24 }]}>
      <Stack.Screen options={{ title: 'Devices' }} />
      <Text style={styles.lead}>
        Pair another phone, tablet, or the iPad app on a Mac. Each device receives its own revocable
        access token.
      </Text>
      <View style={styles.panel}>
        <Text style={styles.title}>Add a device</Text>
        {pairingInvitation ? (
          <>
            <View style={styles.qr}>
              <QRCode
                value={pairingInvitation.link}
                size={220}
                backgroundColor="#ffffff"
                color="#000000"
              />
            </View>
            <Text style={styles.hint}>This code expires after five minutes and works once.</Text>
            <Pressable
              style={({ pressed }) => [styles.secondaryButton, pressed ? styles.pressed : null]}
              onPress={() => void Clipboard.setStringAsync(pairingInvitation.link)}
              accessibilityRole="button"
              accessibilityLabel="Copy pairing link"
            >
              <Text style={styles.secondaryLabel}>Copy pairing link</Text>
            </Pressable>
          </>
        ) : null}
        <Pressable
          style={({ pressed }) => [styles.primaryButton, pressed ? styles.pressed : null]}
          onPress={createInvitation}
          disabled={working}
          accessibilityRole="button"
          accessibilityLabel="Pair another device"
        >
          {working ? <ActivityIndicator color={theme.colors.background} /> : null}
          <Text style={styles.primaryLabel}>
            {pairingInvitation ? 'Create a new code' : 'Pair another device'}
          </Text>
        </Pressable>
      </View>

      <View style={styles.panel}>
        <Text style={styles.title}>Paired devices</Text>
        {loading ? <ActivityIndicator color={theme.colors.accent} /> : null}
        {devices.map((device) => (
          <View key={device.id} style={styles.deviceRow}>
            <View style={styles.deviceText}>
              <Text style={styles.deviceName}>{device.label ?? 'Verity device'}</Text>
              <Text style={styles.hint}>
                {device.isCurrent ? 'This device' : new Date(device.createdAt).toLocaleDateString()}
              </Text>
            </View>
            {!device.isCurrent ? (
              <Pressable onPress={() => revoke(device)} accessibilityRole="button">
                <Text style={styles.remove}>Remove</Text>
              </Pressable>
            ) : null}
          </View>
        ))}
      </View>
      {error ? (
        <Text style={styles.error} accessibilityRole="alert">
          {error}
        </Text>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create((theme) => ({
  content: { padding: theme.spacing.lg, gap: theme.spacing.lg },
  lead: {
    color: theme.colors.textMuted,
    fontSize: theme.text.md,
    lineHeight: 22 * theme.fontScale,
  },
  panel: {
    padding: theme.spacing.lg,
    gap: theme.spacing.md,
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  title: { color: theme.colors.text, fontSize: theme.text.lg, fontWeight: '800' },
  qr: {
    alignSelf: 'center',
    padding: theme.spacing.md,
    backgroundColor: '#ffffff',
    borderRadius: theme.radius.md,
  },
  hint: { color: theme.colors.textMuted, fontSize: theme.text.sm },
  primaryButton: {
    minHeight: 48,
    flexDirection: 'row',
    gap: theme.spacing.sm,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: theme.radius.pill,
    backgroundColor: theme.colors.accent,
  },
  primaryLabel: { color: theme.colors.background, fontSize: theme.text.md, fontWeight: '800' },
  secondaryButton: { minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  secondaryLabel: { color: theme.colors.accent, fontSize: theme.text.sm, fontWeight: '800' },
  deviceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
  },
  deviceText: { flex: 1, gap: 2 },
  deviceName: { color: theme.colors.text, fontSize: theme.text.md, fontWeight: '700' },
  remove: { color: theme.colors.tone.danger, fontSize: theme.text.sm, fontWeight: '700' },
  error: { color: theme.colors.tone.danger, fontSize: theme.text.sm, fontWeight: '600' },
  pressed: { opacity: 0.62 },
}));
