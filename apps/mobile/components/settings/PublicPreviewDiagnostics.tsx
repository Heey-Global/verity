import { VerityApiError, type UplinkDiagnostics, type VerityClient } from '@verity/mobile';
import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, Text } from 'react-native';

import { getServerProfile } from '../../lib/serverProfile';
import {
  remoteControlFailureForUrl,
  testRemoteControlForUrl,
} from '../../lib/remoteControlTransport';
import { settingsStyles as styles } from './settingsStyles';
import { SettingsPanel } from './SettingsChrome';

function controlLabel(value: UplinkDiagnostics): string {
  if (value.control === 'connected') return 'Connected to Uplink';
  if (value.control === 'rejected') {
    return value.reason === 'revoked'
      ? 'Subscription key revoked'
      : value.reason === 'expired'
        ? 'Subscription key expired'
        : 'Subscription key rejected';
  }
  if (value.control === 'disabled') return 'Uplink is disabled on Core';
  return value.control === 'connecting' ? 'Connecting to Uplink' : 'Reconnecting to Uplink';
}

export function PublicPreviewDiagnostics({
  client,
  keyConfigured,
}: {
  client: VerityClient;
  keyConfigured: boolean | undefined;
}) {
  const [status, setStatus] = useState<UplinkDiagnostics | null>(null);
  const [statusError, setStatusError] = useState<'unsupported' | 'unavailable' | null>(null);
  const [checking, setChecking] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try {
      setStatus(await client.getUplinkDiagnostics());
      setStatusError(null);
    } catch (error) {
      setStatus(null);
      setStatusError(
        error instanceof VerityApiError && error.status === 404 ? 'unsupported' : 'unavailable',
      );
    }
  }, [client]);
  useFocusEffect(
    useCallback(() => {
      void refresh();
    }, [refresh]),
  );

  const profile = getServerProfile();
  const route = profile?.remoteControl;
  const runTest = async () => {
    if (profile === null) return;
    setChecking(true);
    setTestResult(null);
    try {
      const result = await testRemoteControlForUrl(profile.activeUrl);
      setTestResult(
        result.ready
          ? 'Remote Control works: the iPhone reached Core through Uplink.'
          : `Remote Control failed at ${result.detail}.`,
      );
      // Core status can stall when the paired address is unreachable. The
      // independent status refresh must not keep the tunnel test spinner open.
      void refresh();
    } catch {
      setTestResult('Remote Control test failed before the connection could be checked.');
    } finally {
      setChecking(false);
    }
  };

  return (
    <SettingsPanel>
      <Text style={styles.disclosureTitle}>Connection diagnostics</Text>
      <Text style={styles.reproHint}>
        Uplink:{' '}
        {keyConfigured === false
          ? 'No subscription key configured'
          : status
            ? controlLabel(status)
            : statusError
              ? statusError === 'unsupported'
                ? 'Update Core to show connection status'
                : 'Core status unavailable'
              : 'Checking…'}
      </Text>
      <Text style={styles.reproHint}>
        Sharing:{' '}
        {status
          ? status.sharing === 'ready'
            ? 'Granted by Uplink'
            : status.control === 'connected'
              ? 'Not granted by Uplink'
              : 'Waiting for Uplink'
          : 'Unknown'}
      </Text>
      <Text style={styles.reproHint}>
        Remote Control:{' '}
        {status
          ? status.remoteControl === 'ready'
            ? 'Offered by Core'
            : status.control === 'connected'
              ? 'Not offered by Core'
              : 'Waiting for Uplink'
          : 'Unknown'}
      </Text>
      <Text style={styles.reproHint}>
        iPhone route: {route ? 'Saved' : 'Missing — connect through VPN to refresh it'}
      </Text>
      {status?.lastCloseCode !== undefined ? (
        <Text style={styles.reproHint}>Last Uplink close code: {status.lastCloseCode}</Text>
      ) : null}
      {profile && route ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Test Remote Control through Uplink"
          disabled={checking}
          onPress={() => void runTest()}
          style={[styles.retryButton, styles.selfStart, checking ? styles.buttonDisabled : null]}
        >
          <Text style={styles.retryButtonLabel}>
            {checking ? 'Testing Remote Control…' : 'Test Remote Control'}
          </Text>
        </Pressable>
      ) : null}
      {testResult ? <Text style={styles.reproHint}>{testResult}</Text> : null}
      <Text style={styles.reproHint}>
        Sharing status reports the granted capability. Creating a public preview checks the full
        sharing path.
      </Text>
      {statusError === 'unavailable' && profile ? (
        <Text style={styles.reproHint}>
          {remoteControlFailureForUrl(profile.activeUrl) ??
            'Core did not answer; use the Remote Control test to locate the failure.'}
        </Text>
      ) : null}
      <Pressable accessibilityRole="button" onPress={() => void refresh()}>
        <Text style={styles.linkText}>Refresh status</Text>
      </Pressable>
    </SettingsPanel>
  );
}
