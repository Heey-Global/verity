import {
  VerityApiError,
  type RemoteStreamRecord,
  type UplinkDiagnostics,
  type VerityClient,
} from '@verity/mobile';
import * as Clipboard from 'expo-clipboard';
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { getServerProfile } from '../../lib/serverProfile';
import { exportRemoteDataDiagnostics } from '../../lib/remoteDataDiagnostics';
import {
  remoteControlFailureForUrl,
  remoteDataRecordingRemainingMs,
  stopRemoteDataRecording,
  testRemoteControlForUrl,
} from '../../lib/remoteControlTransport';
import { CardRow, DotValue, Eyebrow, RowCard, type DotTone } from '../premium/PremiumChrome';
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
  if (value.control === 'idle') return value.entitlement === 'checked' ? 'On demand' : 'Idle';
  if (value.control === 'connected') return 'Connected';
  if (value.control === 'rejected') {
    return value.reason === 'revoked'
      ? 'Key revoked'
      : value.reason === 'expired'
        ? 'Key expired'
        : 'Key rejected';
  }
  if (value.control === 'disabled') return 'Disabled';
  return value.control === 'connecting' ? 'Connecting' : 'Reconnecting';
}

/**
 * The Connection and Tests sections of Settings › Diagnostics: Uplink and the
 * two Premium features as status dots, then the Remote access round trip and
 * its connection recording. One component because a test refreshes the status.
 */
export function PublicPreviewDiagnostics({
  client,
  keyConfigured,
  children,
}: {
  client: VerityClient | null;
  children?: ReactNode;
  keyConfigured: boolean | undefined;
}) {
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [status, setStatus] = useState<UplinkDiagnostics | null>(null);
  const [statusError, setStatusError] = useState<'unsupported' | 'unavailable' | null>(null);
  const [checking, setChecking] = useState(false);
  const [rightsChecking, setRightsChecking] = useState(false);
  const [rightsFailed, setRightsFailed] = useState(false);
  const [exportStatus, setExportStatus] = useState<string | null>(null);
  const [recordingTest, setRecordingTest] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const recordingReadRevision = useRef(0);
  const [recordingRemaining, setRecordingRemaining] = useState<number | null>(null);
  const [recordingStopFailed, setRecordingStopFailed] = useState(false);
  useEffect(() => {
    let mounted = true;
    const refreshRecording = async () => {
      const revision = recordingReadRevision.current;
      const remaining = await remoteDataRecordingRemainingMs();
      if (mounted && revision === recordingReadRevision.current) setRecordingRemaining(remaining);
    };
    void refreshRecording();
    const timer = setInterval(() => void refreshRecording(), 1_000);
    return () => {
      mounted = false;
      clearInterval(timer);
    };
  }, []);
  const stopRecording = async () => {
    recordingReadRevision.current++;
    const stopped = await stopRemoteDataRecording();
    recordingReadRevision.current++;
    setRecordingStopFailed(!stopped);
    if (stopped) setRecordingRemaining(0);
  };
  const refresh = useCallback(async () => {
    if (!client) {
      setStatusError('unavailable');
      return;
    }
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
    setRecordingTest(capture);
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

  const uplink: { tone: DotTone; label: string; subtitle?: string | undefined } =
    keyConfigured === false
      ? { tone: 'off', label: 'Off', subtitle: 'No subscription key' }
      : status
        ? {
            tone:
              status.control === 'connected' ||
              (status.control === 'idle' && status.entitlement === 'checked')
                ? 'ok'
                : status.control === 'rejected'
                  ? 'error'
                  : 'off',
            label: controlLabel(status),
            // Uplink connects only while a share or Remote access needs it.
            subtitle:
              status.control === 'idle'
                ? status.entitlement === 'checked'
                  ? 'Connects when a feature is in use'
                  : 'Rights are checked when a feature is first used'
                : undefined,
          }
        : statusError === 'unsupported'
          ? { tone: 'error', label: 'Update server' }
          : statusError === 'unavailable'
            ? {
                tone: 'error',
                label: 'Unavailable',
                subtitle:
                  (profile ? remoteControlFailureForUrl(profile.activeUrl) : null) ??
                  'Core did not answer; use the Remote access test to locate the failure.',
              }
            : { tone: 'off', label: 'Checking…' };
  const details = [
    status?.lastCloseCode !== undefined ? `Last Uplink close code: ${status.lastCloseCode}` : null,
    status?.remoteStreams !== undefined
      ? `Core streams: ${
          status.remoteStreams.length === 0
            ? 'none since Core started'
            : status.remoteStreams.map(streamLine).join('\n')
        }`
      : null,
  ].filter((line): line is string => line !== null);

  const checkRights = () => {
    if (!client) return;
    setRightsChecking(true);
    setRightsFailed(false);
    void client
      .checkUplinkEntitlements()
      .then((value) => {
        setStatus(value);
        setStatusError(null);
      })
      .catch(() => setRightsFailed(true))
      .finally(() => setRightsChecking(false));
  };
  const checkRow = (
    <CardRow
      title="Check subscription rights"
      subtitle={
        rightsChecking
          ? 'Checking…'
          : rightsFailed
            ? 'Could not reach Uplink. Try again.'
            : 'Asks Uplink which features your key includes'
      }
      disabled={!client || rightsChecking || checking || keyConfigured !== true}
      onPress={checkRights}
    />
  );

  return (
    <>
      <View style={styles.section}>
        <Eyebrow>Connection</Eyebrow>
        <RowCard>
          <CardRow
            title="Uplink"
            subtitle={uplink.subtitle}
            trailing={<DotValue tone={uplink.tone} label={uplink.label} />}
          />
          {premiumFeatures
            .filter((feature) => feature.id !== 'teams')
            .map((feature) => {
              const state = status?.features?.[feature.id];
              const ready =
                feature.id === 'sharing'
                  ? status?.sharing === 'ready'
                  : status?.remoteControl === 'ready';
              const notIncluded =
                (status?.control === 'connected' || status?.entitlement === 'checked') &&
                state?.granted === false;
              // Only sharing dials Uplink on demand; Remote access keeps the
              // channel up while it is usable, so an idle channel means it is not.
              const onDemand =
                feature.id === 'sharing' &&
                !ready &&
                status?.control === 'idle' &&
                status.entitlement === 'checked' &&
                state?.granted === true &&
                state.enabled !== false;
              return (
                <CardRow
                  key={feature.id}
                  title={feature.name}
                  subtitle={
                    state?.enabled === false
                      ? 'Switched off in Verity Premium'
                      : notIncluded
                        ? 'Not included in your subscription'
                        : undefined
                  }
                  trailing={
                    <DotValue
                      tone={
                        (ready || onDemand) && state?.enabled !== false && !notIncluded
                          ? 'ok'
                          : 'off'
                      }
                      label={
                        state?.enabled === false || notIncluded
                          ? 'Off'
                          : ready
                            ? 'On'
                            : onDemand
                              ? 'On demand'
                              : status?.control === 'idle' && status.entitlement === 'unchecked'
                                ? 'Not checked'
                                : '–'
                      }
                    />
                  }
                />
              );
            })}
        </RowCard>
        {statusError === 'unavailable' ? (
          <RowCard>
            <CardRow
              title="Try again"
              subtitle="Reload the Uplink status"
              onPress={() => void refresh()}
            />
          </RowCard>
        ) : null}
      </View>
      <View style={styles.section}>
        <Eyebrow>Connection recording</Eyebrow>
        <RowCard>
          <CardRow
            title="Local connection recording"
            subtitle={
              recordingRemaining === null
                ? 'Recording status unavailable in this app build.'
                : recordingRemaining > 0
                  ? `Recording · ${String(Math.ceil(recordingRemaining / 1000))} seconds remaining`
                  : 'Not recording'
            }
            chevron={false}
          />
          {profile && route ? (
            <CardRow
              title="Record connection test"
              subtitle={
                checking && recordingTest
                  ? 'Testing the connection… Recording can be stopped below.'
                  : ((recordingTest ? testResult : null) ??
                    'Tests the connection and records this iPhone for up to two minutes. Interrupts current remote requests.')
              }
              accessibilityLabel="Record Remote access connection test"
              disabled={checking || rightsChecking || (recordingRemaining ?? 0) > 0}
              onPress={() => void runTest(true)}
            />
          ) : (
            <CardRow
              title="Recording test unavailable"
              subtitle="Connect through your local network or VPN once to enable a new test. Saved recordings can still be copied below."
              chevron={false}
            />
          )}
          <CardRow
            title="Stop local recording"
            subtitle={
              recordingStopFailed
                ? 'Could not confirm recording stopped.'
                : 'Stops this iPhone’s recording. Keeps the saved recording.'
            }
            onPress={() => void stopRecording()}
          />
          <CardRow
            title="Copy last recording"
            subtitle={
              exportStatus ?? 'Copies the saved iPhone recording for support. Works offline.'
            }
            accessibilityLabel="Copy connection recording"
            onPress={() => void copyCapture()}
          />
        </RowCard>
      </View>
      <RowCard>
        <CardRow
          title={showAdvanced ? 'Hide advanced diagnostics' : 'Advanced diagnostics'}
          subtitle="Server recording, technical details and other tools"
          onPress={() => setShowAdvanced((shown) => !shown)}
        />
      </RowCard>
      {showAdvanced ? (
        <>
          <View style={styles.section}>
            <Eyebrow>Technical details</Eyebrow>
            <RowCard>
              {checkRow}
              {profile && route ? (
                <CardRow
                  title="Test remote access"
                  subtitle={
                    checking && !recordingTest
                      ? 'Testing…'
                      : ((!recordingTest ? testResult : null) ??
                        'Connection check without recording')
                  }
                  accessibilityLabel="Test Remote access through Uplink"
                  disabled={checking || rightsChecking}
                  onPress={() => void runTest()}
                />
              ) : null}
            </RowCard>
            {details.map((line, index) => (
              <Text key={index} style={styles.footnote}>
                {line}
              </Text>
            ))}
          </View>
          {children}
        </>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  section: { gap: theme.spacing.sm },
  footnote: {
    color: theme.colors.textFaint,
    fontSize: theme.text.xs,
    lineHeight: 17 * theme.fontScale,
    marginHorizontal: 2,
  },
}));
