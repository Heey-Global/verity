import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { randomUUID } from 'expo-crypto';
import * as Clipboard from 'expo-clipboard';
import { AppState } from 'react-native';
import { CardRow } from '../premium/PremiumChrome';
import { selectedRecordingContext } from '../../lib/selectedRecordingContext';
import { selectedRecordingAttempt } from '../../lib/selectedRecordingAttempt';
import { getServerProfile } from '../../lib/serverProfile';

const prerequisiteMessages = new Set([
  'Select a paired direct HTTPS connection before testing.',
  'Unlock the paired direct connection before testing.',
  'The direct Core does not match the paired remote installation.',
  'Native connection test unsupported.',
  'An existing DATA tunnel must be stopped before testing.',
]);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;
export function SelectedConnectionTest({
  disabled,
  onBusy,
}: {
  disabled: boolean;
  onBusy: (busy: boolean) => boolean | void;
}) {
  const [message, setMessage] = useState(
    'One health request with up to 30 seconds of metadata. Requires a paired direct connection.',
  );
  const serverId = getServerProfile()?.serverId;
  const storageKey = serverId ? `verity.selectedConnectionTest.v1.${serverId}` : null;
  const [loaded, setLoaded] = useState(false);
  const [hasRun, setHasRun] = useState(false);
  const [busy, setBusy] = useState(false);
  const operation = useRef<AbortController | null>(null);
  const focused = useRef(false);
  const retained = useRef<string | null>(null);
  useEffect(() => {
    let current = true;
    setLoaded(false);
    retained.current = null;
    setHasRun(false);
    void (async () => {
      try {
        const value = storageKey ? await AsyncStorage.getItem(storageKey) : null;
        if (!current) return;
        if (value && !UUID.test(value)) throw new Error('Invalid saved run');
        retained.current = value;
        setHasRun(Boolean(value));
        setLoaded(true);
        onBusy(Boolean(value));
        if (value)
          setMessage('Saved bounded test available. Copy its report before starting another test.');
      } catch {
        if (current) setMessage('Saved test unavailable. Reopen Diagnostics before testing.');
      }
    })();
    return () => {
      current = false;
      operation.current?.abort();
    };
  }, [storageKey, onBusy]);
  useFocusEffect(
    useCallback(() => {
      focused.current = true;
      setBusy(operation.current !== null);
      const subscription = AppState.addEventListener('change', (state) => {
        if (state !== 'active') operation.current?.abort();
      });
      return () => {
        focused.current = false;
        operation.current?.abort();
        subscription.remove();
      };
    }, []),
  );
  const start = async () => {
    if (disabled || !loaded || retained.current || operation.current) return;
    const controller = new AbortController();
    operation.current = controller;
    setBusy(true);
    if (onBusy(true) === false) {
      operation.current = null;
      setBusy(false);
      return;
    }
    setMessage('Checking the paired direct connection…');
    let verified = false;
    let responseStatus: number | undefined;
    try {
      const context = selectedRecordingContext();
      const installationFingerprint = await context.verify();
      if (controller.signal.aborted) return;
      await context.assertInactive();
      if (controller.signal.aborted) return;
      verified = true;
      const runId = randomUUID();
      if (!storageKey) throw new Error('No paired storage');
      await AsyncStorage.setItem(storageKey, runId);
      retained.current = runId;
      if (focused.current) setHasRun(true);
      if (controller.signal.aborted) return;
      if (getServerProfile() !== context.profile) throw new Error('Pairing changed');
      setMessage('Confirming selected-session support and recording readiness…');
      const result = await selectedRecordingAttempt({
        ...context.options,
        installationFingerprint,
        runId,
        signal: controller.signal,
        onResponse: (status) => {
          responseStatus = status;
        },
      });
      if (focused.current)
        setMessage(
          `HTTP ${result.status}. Connection and recording Stop confirmed. Export remains separate.`,
        );
    } catch (error) {
      if (focused.current) {
        const cleanupFailed = error instanceof Error && error.message === 'Selected cleanup failed';
        const permissionDenied =
          error &&
          typeof error === 'object' &&
          'status' in error &&
          (error.status === 401 || error.status === 403);
        setMessage(
          cleanupFailed
            ? `${responseStatus === undefined ? 'No HTTP result confirmed.' : `HTTP ${responseStatus} received.`} Stop could not be confirmed. Do not start another test; collect the report after expiry.`
            : permissionDenied
              ? 'Administrator access on the paired direct Core is required before testing.'
              : responseStatus !== undefined
                ? `HTTP ${responseStatus} received. The health request failed; connection and recording Stop confirmed.`
                : !verified && error instanceof Error && prerequisiteMessages.has(error.message)
                  ? error.message
                  : 'Test stopped or unavailable. Check direct administrator access, V3 support and that no DATA tunnel is active. No successful result confirmed.',
        );
      }
    } finally {
      operation.current = null;
      if (focused.current) setBusy(false);
      onBusy(retained.current !== null);
    }
  };
  const collect = async () => {
    const saved = retained.current;
    if (disabled || !saved || operation.current) return;
    const controller = new AbortController();
    operation.current = controller;
    setBusy(true);
    if (onBusy(true) === false) {
      operation.current = null;
      setBusy(false);
      return;
    }
    let context: ReturnType<typeof selectedRecordingContext> | undefined;
    let exportRequested = false;
    let copied = false;
    try {
      context = selectedRecordingContext();
      const fingerprint = await context.verify();
      if (controller.signal.aborted) return;
      exportRequested = true;
      const report = await context.client.exportConnectionRecording(saved, 3);
      if (report.status.runId !== saved || report.status.installationFingerprint !== fingerprint)
        throw new Error('Installation changed');
      if (!focused.current || controller.signal.aborted) return;
      await Clipboard.setStringAsync(JSON.stringify(report));
      copied = true;
      if (
        report.status.core.state === 'stopped' &&
        report.status.uplink.state === 'stopped' &&
        ['stopped', 'expired'].includes(report.status.phase) &&
        report.status.error === null
      ) {
        await context.assertInactive();
        if (storageKey) await AsyncStorage.removeItem(storageKey);
        retained.current = null;
        if (focused.current) setHasRun(false);
      }
      if (focused.current)
        setMessage(
          'Validated report copied. Missing sources and capture gaps remain in the report.',
        );
    } catch (error) {
      // A rejected arming request may never have created a server recording.
      // An authenticated 404 and inactive native tunnel allow clearing that orphan reference.
      if (
        exportRequested &&
        context &&
        error &&
        typeof error === 'object' &&
        'status' in error &&
        error.status === 404
      ) {
        try {
          await context.assertInactive();
          if (!focused.current || controller.signal.aborted) return;
          if (storageKey) await AsyncStorage.removeItem(storageKey);
          retained.current = null;
          setHasRun(false);
          setMessage('Core has no report for this run. Local reference cleared; no report copied.');
          return;
        } catch {
          /* Keep the reference when native cleanup is unknown. */
        }
      }
      if (focused.current)
        setMessage(
          copied
            ? 'Report copied. Cleanup could not be confirmed; the saved run is retained.'
            : 'Export unavailable. The run is retained here for another collection attempt.',
        );
    } finally {
      operation.current = null;
      if (focused.current) setBusy(false);
      onBusy(retained.current !== null);
    }
  };
  return (
    <>
      <CardRow
        title="Run bounded connection test"
        subtitle={message}
        disabled={disabled || !loaded || busy || hasRun}
        onPress={() => void start()}
      />
      <CardRow
        title="Stop bounded test"
        disabled={!busy}
        onPress={() => operation.current?.abort()}
      />
      <CardRow
        title="Copy bounded test report"
        disabled={disabled || busy || !hasRun}
        onPress={() => void collect()}
      />
    </>
  );
}
