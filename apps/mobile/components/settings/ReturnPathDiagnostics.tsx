import type { ReturnPathStatus, VerityClient } from '@verity/mobile';
import { useFocusEffect } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { Alert, Text, TextInput } from 'react-native';
import { SettingsNavRow, SettingsPanel } from './SettingsChrome';
import { settingsStyles as styles } from './settingsStyles';

export function ReturnPathDiagnostics({ client }: { client: VerityClient }) {
  const [status, setStatus] = useState<ReturnPathStatus | null>(null);
  const [expiry, setExpiry] = useState('');
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [observedAt, setObservedAt] = useState(0);
  const [now, setNow] = useState(0);
  const focused = useRef(false);
  const operation = useRef(0);
  const changing = useRef(false);
  const refresh = useCallback(async () => {
    if (changing.current) return;
    const request = ++operation.current;
    try {
      const next = await client.getReturnPathStatus();
      if (focused.current && request === operation.current) {
        setObservedAt(performance.now());
        setNow(performance.now());
        setStatus(next);
        setError(false);
        setExpiry(
          (previous) =>
            previous || new Date(Date.parse(next.currentUtc) + 9 * 60_000).toISOString(),
        );
      }
    } catch {
      if (focused.current && request === operation.current) {
        setError(true);
        setStatus(null);
      }
    }
  }, [client]);
  useFocusEffect(
    useCallback(() => {
      focused.current = true;
      void refresh();
      const timer = setInterval(() => void refresh(), 5_000);
      const countdown = setInterval(() => setNow(performance.now()), 1_000);
      return () => {
        focused.current = false;
        operation.current++;
        clearInterval(timer);
        clearInterval(countdown);
      };
    }, [refresh]),
  );
  const change = async (start: boolean) => {
    if (changing.current) return;
    changing.current = true;
    const request = ++operation.current;
    setBusy(true);
    try {
      const next = start
        ? await client.startReturnPathDiagnostics(expiry)
        : await client.stopReturnPathDiagnostics();
      if (focused.current && request === operation.current) {
        setObservedAt(performance.now());
        setNow(performance.now());
        setStatus(next);
        setError(false);
      }
    } catch {
      if (!focused.current || request !== operation.current) return;
      setError(true);
      setStatus(null);
      Alert.alert(
        'Diagnosis unavailable',
        'Could not confirm the diagnostic state. Refresh before testing. An administrator and a connected Uplink are required to start.',
      );
    } finally {
      changing.current = false;
      if (focused.current) setBusy(false);
    }
  };
  const remainingMs = Math.max(0, (status?.remainingMs ?? 0) - Math.max(0, now - observedAt));
  return (
    <SettingsPanel>
      <Text style={styles.disclosureTitle}>Connection diagnosis</Text>
      <Text style={styles.reproSubtitle}>
        Collect connection metadata on this server for up to ten minutes. Uplink recording must be
        activated separately for a coordinated test.
      </Text>
      {error ? (
        <Text style={styles.fieldError}>Diagnostic status unavailable. Refresh to retry.</Text>
      ) : status ? (
        <Text style={styles.reproSubtitle}>
          {status.enabled
            ? `${remainingMs > 0 ? 'Active' : 'Expiry reached — refresh status'} · ${Math.ceil(remainingMs / 1000)} seconds remaining · ${status.matchedConnectors} connections · ${status.source === 'runtime' ? 'Started from app' : 'Server configuration'}\nInstallation ${status.installationFingerprint ?? 'unavailable'} · Ends ${status.expiresAt ?? 'unavailable'}`
            : 'Inactive'}
        </Text>
      ) : (
        <Text style={styles.reproSubtitle}>Loading diagnostic status…</Text>
      )}
      <TextInput
        accessibilityLabel="Diagnosis expiry UTC"
        value={expiry}
        onChangeText={setExpiry}
        editable={!busy && status?.enabled !== true}
        autoCapitalize="none"
        autoCorrect={false}
        placeholder="Agreed expiry: YYYY-MM-DDTHH:mm:ssZ"
      />
      <SettingsNavRow
        icon="play"
        title="Start connection diagnosis"
        disabled={busy || !status || status.enabled}
        onPress={() =>
          Alert.alert(
            'Start connection diagnosis?',
            `Collect server connection metadata until ${expiry}. Use the same expiry for Uplink.`,
            [
              { text: 'Cancel', style: 'cancel' },
              { text: 'Start', onPress: () => void change(true) },
            ],
          )
        }
      />
      <SettingsNavRow
        icon="square"
        title="Stop connection diagnosis"
        disabled={busy}
        onPress={() => void change(false)}
      />
      <SettingsNavRow
        icon="refresh-cw"
        title="Refresh diagnostic status"
        disabled={busy}
        onPress={() => void refresh()}
      />
    </SettingsPanel>
  );
}
