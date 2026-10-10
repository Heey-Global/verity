import {
  VerityApiError,
  type RemoteStreamRecord,
  type UplinkDiagnostics,
  type VerityClient,
} from '@verity/mobile';
import * as Clipboard from 'expo-clipboard';
import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { getServerProfile } from '../../lib/serverProfile';
import { exportRemoteDataDiagnostics } from '../../lib/remoteDataDiagnostics';
import {
  remoteControlFailureForUrl,
  testRemoteControlForUrl,
} from '../../lib/remoteControlTransport';
import { settingsStyles as styles } from './settingsStyles';
import { SettingsPanel } from './SettingsChrome';
import { StatusPill } from '../StatusPill';
import { premiumFeatures } from '../premium/premiumFeatures';

// One line per stream, in Core's words: what arrived from the phone, what the
// local TLS ingress answered, and what went back out. Read beside the phone's
// own `streams=` trace (matched by the stream key) it shows which hop lost a
// reply, which otherwise only the server log could tell.
function streamLine(record: RemoteStreamRecord): string {
  const seconds = (record.durationMs / 1000).toFixed(1);
  const reply =
    record.firstLocalReplyMs === null
      ? 'Core never answered'
      : `Core answered after ${String(record.firstLocalReplyMs)} ms`;
  return (
    `${record.streamId}: from phone ${String(record.receivedFromAppBytes)} B, ` +
    `to Core ${String(record.writtenToLocalBytes)} B, ${reply}, ` +
    `from Core ${String(record.receivedFromLocalBytes)} B, ` +
    `accepted by Core transport ${String(record.sentToUplinkBytes)} B` +
    (record.framesToApp === undefined
      ? ''
      : ` in ${String(record.framesToApp)} attempted frames (${String(record.framesFromApp ?? 0)} from phone)`) +
    `, ${record.state}, ${seconds} s`
  );
}

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
  const [exportStatus, setExportStatus] = useState<string | null>(null);
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
  const runTest = async (capture = false) => {
    if (profile === null) return;
    setChecking(true);
    setTestResult(null);
    try {
      const result = await testRemoteControlForUrl(profile.activeUrl, capture);
      setTestResult(
        result.ready
          ? 'Remote access works: the iPhone reached Core through Uplink.'
          : `Remote access failed at ${result.detail}.`,
      );
      // Core status can stall when the paired address is unreachable. The
      // independent status refresh must not keep the tunnel test spinner open.
      void refresh();
    } catch {
      setTestResult('Remote access test failed before the connection could be checked.');
    } finally {
      setChecking(false);
    }
  };

  const copyCapture = async () => {
    try {
      const capture = await exportRemoteDataDiagnostics();
      if (capture.status !== 'ready') {
        const messages = {
          unsupported: 'This app build does not support connection recording export.',
          empty: 'No connection recording was retained. Use Record connection test to create one.',
          invalid: 'The recording could not be copied because its format failed validation.',
          failed: 'The app could not read the connection recording.',
        };
        setExportStatus(messages[capture.status]);
        return;
      }
      await Clipboard.setStringAsync(capture.recording);
      setExportStatus('Connection recording copied.');
    } catch {
      setExportStatus('Could not copy the connection recording.');
    }
  };

  return (
    <SettingsPanel>
      <View style={styles.secretLabelRow}>
        <Text style={styles.pathLabel}>Uplink</Text>
        <StatusPill
          quiet
          intent={
            keyConfigured === false
              ? 'optional'
              : status?.control === 'connected'
                ? 'ready'
                : status?.control === 'rejected' || statusError
                  ? 'needsSetup'
                  : 'transient'
          }
          label={
            keyConfigured === false
              ? 'No subscription'
              : status
                ? controlLabel(status)
                : statusError === 'unsupported'
                  ? 'Update server'
                  : statusError
                    ? 'Unavailable'
                    : 'Checking…'
          }
        />
      </View>
      {premiumFeatures
        .filter((feature) => feature.id !== 'teams')
        .map((feature) => {
          const state = status?.features?.[feature.id];
          const ready =
            feature.id === 'sharing'
              ? status?.sharing === 'ready'
              : status?.remoteControl === 'ready';
          const label =
            state?.enabled === false
              ? 'Off'
              : ready
                ? 'Ready'
                : status?.control === 'connected' && state?.granted === false
                  ? 'Not included'
                  : 'Unavailable';
          return (
            <View key={feature.id} style={styles.secretLabelRow}>
              <Text style={styles.pathLabel}>{feature.name}</Text>
              <StatusPill quiet intent={ready ? 'ready' : 'optional'} label={label} />
            </View>
          );
        })}
      <Text style={styles.reproHint}>
        iPhone route: {route ? 'Saved' : 'Missing — connect through VPN to refresh it'}
      </Text>
      {status?.lastCloseCode !== undefined ? (
        <Text style={styles.reproHint}>Last Uplink close code: {status.lastCloseCode}</Text>
      ) : null}
      {profile && route ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Test Remote access through Uplink"
          disabled={checking}
          onPress={() => void runTest()}
          style={[styles.retryButton, styles.selfStart, checking ? styles.buttonDisabled : null]}
        >
          <Text style={styles.retryButtonLabel}>
            {checking ? 'Testing Remote access…' : 'Test Remote access'}
          </Text>
        </Pressable>
      ) : null}
      {profile && route ? (
        <>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Record Remote access connection test"
            disabled={checking}
            onPress={() => void runTest(true)}
          >
            <Text style={styles.linkText}>Record connection test</Text>
          </Pressable>
          <Text style={styles.reproHint}>
            Starts a fresh connection and records events and counters for up to two minutes.
            Interrupts current remote requests. No addresses, credentials or content are recorded.
          </Text>
          <Pressable accessibilityRole="button" onPress={() => void copyCapture()}>
            <Text style={styles.linkText}>Copy connection recording</Text>
          </Pressable>
        </>
      ) : null}
      {exportStatus ? <Text style={styles.reproHint}>{exportStatus}</Text> : null}
      {testResult ? <Text style={styles.reproHint}>{testResult}</Text> : null}
      {status?.remoteStreams !== undefined ? (
        <Text style={styles.reproHint}>
          Core streams:{' '}
          {status.remoteStreams.length === 0
            ? 'none since Core started'
            : status.remoteStreams.map(streamLine).join('\n')}
        </Text>
      ) : null}
      <Text style={styles.reproHint}>
        Online sharing status reports the effective capability. Creating a public preview checks the
        full sharing path.
      </Text>
      {statusError === 'unavailable' && profile ? (
        <Text style={styles.reproHint}>
          {remoteControlFailureForUrl(profile.activeUrl) ??
            'Core did not answer; use the Remote access test to locate the failure.'}
        </Text>
      ) : null}
      <Pressable accessibilityRole="button" onPress={() => void refresh()}>
        <Text style={styles.linkText}>Refresh status</Text>
      </Pressable>
    </SettingsPanel>
  );
}
