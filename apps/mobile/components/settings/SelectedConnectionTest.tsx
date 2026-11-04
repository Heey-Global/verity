import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { randomUUID } from 'expo-crypto';
import * as Clipboard from 'expo-clipboard';
import { AppState } from 'react-native';
import { CardRow } from '../premium/PremiumChrome';
import { selectedRecordingContext } from '../../lib/selectedRecordingContext';
import {
  selectedRecordingAttempt,
  type SelectedLocalRecording,
} from '../../lib/selectedRecordingAttempt';
import { getServerProfile } from '../../lib/serverProfile';
import { validateStoredRemoteRecording } from '../../lib/remoteDataDiagnostics';
import {
  createConnectionDiagnosticReport,
  saveConnectionDiagnosticReport,
  loadConnectionDiagnosticReports,
} from '../../lib/connectionDiagnosticReport';
import type { ConnectionRecordingExport } from '@verity/mobile';

const prerequisiteMessages = new Set([
  'Select a paired direct HTTPS connection before testing.',
  'Unlock the paired direct connection before testing.',
  'The direct Core does not match the paired remote installation.',
  'Native connection test unsupported.',
  'An existing DATA tunnel must be stopped before testing.',
]);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;
type SavedTest = {
  runId: string;
  startedAt: string | null;
  local: string | null;
  localStatus: SelectedLocalRecording['status'] | 'legacy' | 'pending';
  localStopped: boolean;
  outcome: 'completed' | 'cancelled' | 'failed' | 'unknown';
};
function parseSavedTest(raw: string | null): SavedTest | null {
  if (!raw) return null;
  if (UUID.test(raw))
    return {
      runId: raw,
      startedAt: null,
      local: null,
      localStatus: 'legacy',
      localStopped: false,
      outcome: 'unknown',
    };
  if (raw.length > 210000) throw new Error('Invalid saved test');
  const value = JSON.parse(raw) as SavedTest;
  if (
    !UUID.test(value.runId) ||
    (value.startedAt !== null &&
      (!Number.isFinite(Date.parse(value.startedAt)) ||
        new Date(value.startedAt).toISOString() !== value.startedAt)) ||
    ![
      'ready',
      'unsupported',
      'empty',
      'invalid',
      'failed',
      'unmatched',
      'ambiguous',
      'legacy',
      'pending',
    ].includes(value.localStatus) ||
    !['completed', 'cancelled', 'failed', 'unknown'].includes(value.outcome) ||
    typeof value.localStopped !== 'boolean' ||
    !(value.local === null || typeof value.local === 'string')
  )
    throw new Error('Invalid saved test');
  return {
    runId: value.runId,
    startedAt: value.startedAt,
    local: value.local === null ? null : validateStoredRemoteRecording(value.local),
    localStatus: value.localStatus,
    localStopped: value.localStopped,
    outcome: value.outcome,
  };
}
export function SelectedConnectionTest({
  disabled,
  onBusy,
  visible = true,
  onReport,
}: {
  disabled: boolean;
  onBusy: (busy: boolean) => boolean | void;
  visible?: boolean;
  onReport?: () => void;
}) {
  const serverId = getServerProfile()?.serverId;
  const storageKey = serverId ? `verity.selectedConnectionTest.v1.${serverId}` : null;
  const [message, setMessage] = useState(
    'One health request. Ends automatically after the response; metadata capture is limited to 30 seconds. Requires a paired direct connection.',
  );
  const [loaded, setLoaded] = useState(false);
  const [saved, setSaved] = useState<SavedTest | null>(null);
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState('Preparing');
  const [archived, setArchived] = useState(false);
  const [canStartAnother, setCanStartAnother] = useState(false);
  const [localFailure, setLocalFailure] = useState<{
    kind: string;
    stage: string;
    httpStatus: number | null;
    runId: string | null;
  } | null>(null);
  const retained = useRef<SavedTest | null>(null);
  const operation = useRef<AbortController | null>(null);
  const focused = useRef(false);
  const scope = useRef(storageKey);
  scope.current = storageKey;
  const writes = useRef<Promise<void>>(Promise.resolve());
  const persist = async (value: SavedTest) => {
    if (scope.current === storageKey) {
      retained.current = value;
      if (focused.current && scope.current === storageKey) setSaved({ ...value });
    }
    const write = writes.current
      .catch(() => undefined)
      .then(async () => {
        if (!storageKey) throw new Error('No paired storage');
        await AsyncStorage.setItem(storageKey, JSON.stringify(value));
      });
    writes.current = write;
    await write;
  };
  useEffect(() => {
    let current = true;
    setLoaded(false);
    retained.current = null;
    setSaved(null);
    setArchived(false);
    setCanStartAnother(false);
    setLocalFailure(null);
    setBusy(operation.current !== null);
    setPhase(operation.current ? 'Stopping' : 'Preparing');
    setMessage(
      'One health request. Ends automatically after the response; metadata capture is limited to 30 seconds. Requires a paired direct connection.',
    );
    void (async () => {
      try {
        const value = parseSavedTest(storageKey ? await AsyncStorage.getItem(storageKey) : null);
        if (!current) return;
        retained.current = value;
        setSaved(value);
        setLoaded(true);
        if (value)
          setMessage(
            'Saved quick test. Collect this run’s report; starting another test will not recover missing evidence.',
          );
      } catch {
        if (current) setMessage('Saved test unavailable. Reopen Diagnostics before testing.');
      }
    })();
    return () => {
      current = false;
      operation.current?.abort();
    };
  }, [storageKey]);
  useFocusEffect(
    useCallback(() => {
      focused.current = true;
      setBusy(operation.current !== null);
      setSaved(retained.current);
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
  const recordFailure = (stage: string, error: unknown) => {
    const status = error && typeof error === 'object' && 'status' in error ? error.status : null;
    if (focused.current && scope.current === storageKey)
      setLocalFailure({
        kind: 'selected-test-local-failure',
        stage,
        httpStatus:
          typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599
            ? status
            : null,
        runId: retained.current?.runId ?? null,
      });
  };
  const start = async () => {
    if (disabled || !loaded || retained.current || operation.current) return;
    const controller = new AbortController();
    operation.current = controller;
    setBusy(true);
    setPhase('Preparing');
    setArchived(false);
    if (onBusy(true) === false) {
      operation.current = null;
      setBusy(false);
      return;
    }
    let attempt: SavedTest | null = null;
    let stage = 'direct-context';
    let verified = false;
    let responseStatus: number | undefined;
    setLocalFailure(null);
    setMessage('Checking the paired direct connection…');
    try {
      const context = selectedRecordingContext();
      stage = 'direct-descriptor';
      const fingerprint = await context.verify();
      if (controller.signal.aborted) return;
      stage = 'native-inactive';
      await context.assertInactive();
      if (controller.signal.aborted) return;
      verified = true;
      stage = 'save-run';
      attempt = {
        runId: randomUUID(),
        startedAt: new Date().toISOString(),
        local: null,
        localStatus: 'pending',
        localStopped: false,
        outcome: 'unknown',
      };
      await persist(attempt);
      if (controller.signal.aborted) return;
      if (getServerProfile() !== context.profile) throw new Error('Pairing changed');
      stage = 'bounded-attempt';
      const result = await selectedRecordingAttempt({
        ...context.options,
        installationFingerprint: fingerprint,
        runId: attempt.runId,
        signal: controller.signal,
        onResponse: (status) => {
          responseStatus = status;
        },
        onPhase: (next) => {
          if (focused.current && scope.current === storageKey)
            setPhase(
              next === 'running' ? 'Running' : next === 'stopping' ? 'Stopping' : 'Preparing',
            );
        },
        onLocalRecording: async (evidence) => {
          if (!attempt) return;
          attempt = {
            ...attempt,
            // A failed persistence callback may be followed by an unavailable
            // notification. Keep the evidence already collected in memory.
            local: evidence.recording ?? attempt.local,
            localStatus:
              evidence.recording || !attempt.local ? evidence.status : attempt.localStatus,
            localStopped: evidence.stopped || attempt.localStopped,
          };
          await persist(attempt);
        },
      });
      if (attempt) {
        attempt = { ...attempt, outcome: 'completed' };
        await persist(attempt);
      }
      if (focused.current && scope.current === storageKey)
        setMessage(
          `HTTP ${result.status}. Test ended automatically after the response. Collect the App, Core and Uplink report.`,
        );
    } catch (error) {
      if (attempt) {
        attempt = { ...attempt, outcome: controller.signal.aborted ? 'cancelled' : 'failed' };
        await persist(attempt).catch(() => undefined);
      }
      recordFailure(stage, error);
      if (focused.current && scope.current === storageKey)
        setMessage(
          error instanceof Error && error.message === 'Selected cleanup failed'
            ? 'Stop could not be confirmed. Collect available evidence; do not start another test.'
            : !verified && error instanceof Error && prerequisiteMessages.has(error.message)
              ? error.message
              : responseStatus !== undefined
                ? `HTTP ${responseStatus} received. Test ended; collect the report for result and Stop status.`
                : controller.signal.aborted
                  ? 'Test cancelled. Collect any available evidence.'
                  : 'Test failed during preparation or request. Collect available evidence. No successful result confirmed.',
        );
    } finally {
      if (attempt?.localStatus === 'pending')
        await persist({
          ...attempt,
          localStatus: 'empty',
          outcome: controller.signal.aborted ? 'cancelled' : 'failed',
        }).catch(() => undefined);
      operation.current = null;
      if (focused.current) setBusy(false);
      onBusy(false);
    }
  };
  const collect = async () => {
    const value = retained.current;
    if (disabled || !value || operation.current || !serverId) return;
    const controller = new AbortController();
    operation.current = controller;
    setBusy(true);
    setPhase('Collecting');
    if (onBusy(true) === false) {
      operation.current = null;
      setBusy(false);
      return;
    }
    let remote: ConnectionRecordingExport | null = null;
    let stopped = false;
    let absentOnVerifiedCore = false;
    let stage = 'export-direct-context';
    try {
      try {
        const context = selectedRecordingContext();
        stage = 'export-direct-descriptor';
        const fingerprint = await context.verify();
        if (controller.signal.aborted) return;
        stage = 'server-export';
        let candidate: ConnectionRecordingExport;
        try {
          candidate = await context.client.exportConnectionRecording(value.runId, 3);
        } catch (error) {
          if (error && typeof error === 'object' && 'status' in error && error.status === 404) {
            await context.assertInactive();
            absentOnVerifiedCore = true;
          }
          throw error;
        }
        stage = 'export-identity';
        if (
          candidate.status.runId !== value.runId ||
          candidate.status.installationFingerprint !== fingerprint
        )
          throw new Error('Installation changed');
        remote = candidate;
        await context.assertInactive();
        stopped =
          ['stopped', 'expired'].includes(candidate.status.phase) &&
          candidate.status.core.state === 'stopped' &&
          candidate.status.uplink.state === 'stopped' &&
          candidate.status.error === null;
      } catch (error) {
        recordFailure(stage, error);
      }
      if (controller.signal.aborted || !focused.current) return;
      const bundle = createConnectionDiagnosticReport({
        runId: value.runId,
        startedAt: value.startedAt,
        testType: 'quick_test',
        outcome: value.outcome,
        local: value.local,
        localStopped: value.localStopped,
        localUnavailableReason: value.localStatus === 'ready' ? 'unavailable' : value.localStatus,
        remote,
        remoteStopped: stopped,
      });
      let stored = true;
      try {
        await saveConnectionDiagnosticReport(serverId, bundle);
        if (scope.current === storageKey) {
          setArchived(true);
          setCanStartAnother(stopped || absentOnVerifiedCore);
          onReport?.();
        }
      } catch {
        stored = false;
      }
      if (controller.signal.aborted || !focused.current || scope.current !== storageKey) return;
      await Clipboard.setStringAsync(JSON.stringify(bundle));
      if (focused.current && scope.current === storageKey)
        setMessage(
          `${bundle.complete ? 'Complete report copied.' : 'Partial report copied. Missing sources or unconfirmed Stop are listed in the report.'}${absentOnVerifiedCore ? ' Core has no retained report for this run.' : ''}${stored ? ' This run is retained in Saved reports.' : ' Saving failed or Saved reports is full; keep this run and copy its report before leaving.'}`,
        );
    } catch (error) {
      recordFailure('clipboard', error);
      if (focused.current && scope.current === storageKey)
        setMessage('Could not copy the report. This run is retained; retry collection.');
    } finally {
      operation.current = null;
      if (focused.current) setBusy(false);
      onBusy(false);
    }
  };
  const another = async () => {
    const expected = retained.current;
    if (!expected || !archived || operation.current || !storageKey || disabled) return;
    if (!canStartAnother) {
      setMessage('Cannot start another test while Stop is unconfirmed.');
      return;
    }
    const controller = new AbortController();
    operation.current = controller;
    setBusy(true);
    setPhase('Preparing');
    if (onBusy(true) === false) {
      operation.current = null;
      setBusy(false);
      return;
    }
    const current = () =>
      !controller.signal.aborted &&
      scope.current === storageKey &&
      retained.current?.runId === expected.runId;
    try {
      await selectedRecordingContext().assertInactive();
      if (!current()) return;
      if (
        !serverId ||
        !(await loadConnectionDiagnosticReports(serverId)).some(
          (report) => report.runId === expected.runId,
        )
      )
        throw new Error('Saved copy missing');
      if (!current()) return;
      await AsyncStorage.removeItem(storageKey);
      if (!current()) return;
      retained.current = null;
      setSaved(null);
      setArchived(false);
      setCanStartAnother(false);
      setLocalFailure(null);
      setMessage(
        'Previous report retained in Saved reports. Ready for one health request with automatic Stop.',
      );
    } catch {
      if (current()) setMessage('Cannot start another test while native Stop is unconfirmed.');
    } finally {
      operation.current = null;
      if (focused.current) setBusy(false);
      onBusy(false);
    }
  };
  if (!visible) return null;
  return (
    <>
      <CardRow title="Quick test status" subtitle={message} chevron={false} />
      {saved ? (
        <CardRow
          title={`Quick test · ${saved.runId.slice(0, 8)}`}
          subtitle={`${saved.startedAt ?? 'Older saved run — start time unavailable'} · ${busy ? phase : saved.outcome === 'unknown' ? 'Result unknown' : 'Ended'}`}
          chevron={false}
        />
      ) : null}
      {!saved ? (
        <CardRow
          title="Start quick test"
          disabled={disabled || !loaded || busy}
          onPress={() => void start()}
        />
      ) : null}
      {busy ? (
        <CardRow
          title={
            phase === 'Collecting'
              ? 'Collecting report…'
              : phase === 'Stopping'
                ? 'Stopping…'
                : 'Stop test'
          }
          disabled={phase === 'Stopping' || phase === 'Collecting'}
          onPress={() => {
            setPhase('Stopping');
            operation.current?.abort();
          }}
        />
      ) : null}
      {saved && !busy ? (
        <CardRow
          title="Copy report"
          subtitle="App, Core and Uplink for this quick test. Missing evidence is identified."
          disabled={disabled}
          onPress={() => void collect()}
        />
      ) : null}
      {archived && !busy ? (
        <CardRow
          title="Start another quick test"
          subtitle="The previous report remains in Saved reports."
          disabled={disabled}
          onPress={() => void another()}
        />
      ) : null}
      {localFailure && !busy ? (
        <CardRow
          title="Copy local test failure"
          subtitle={`Failed step: ${localFailure.stage}. Stop remains unconfirmed unless recorded in the combined report.`}
          onPress={() => {
            void Clipboard.setStringAsync(JSON.stringify(localFailure)).then(
              () => setMessage('Local failure copied. This is not the combined report.'),
              () => setMessage('Clipboard unavailable.'),
            );
          }}
        />
      ) : null}
    </>
  );
}
