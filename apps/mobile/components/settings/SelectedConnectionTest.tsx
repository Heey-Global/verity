import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { randomUUID } from 'expo-crypto';
import * as Clipboard from 'expo-clipboard';
import { Alert, AppState, Share } from 'react-native';
import {
  assertNativeTunnelInactive,
  selectedRecordingContext,
} from '../../lib/selectedRecordingContext';
import {
  Actions,
  Button,
  SourceTags,
  StatusLine,
  StepIndicator,
  TestCard,
  Toast,
  holdReason,
  useHold,
  useTransientMessage,
  completeness,
  formatReportTime,
  type StatusTone,
} from './DiagnosticsParts';
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
  type ConnectionDiagnosticReport,
} from '../../lib/connectionDiagnosticReport';
import type { ConnectionRecordingExport } from '@verity/mobile';

const prerequisiteMessages = new Set([
  'Select a paired direct HTTPS connection before testing.',
  'Unlock the paired direct connection before testing.',
  'The direct Core does not match the paired remote installation.',
  'Native connection test unsupported.',
  'An existing DATA tunnel must be stopped before testing.',
]);
/** The same prerequisites, said the way a user can act on them. */
const prerequisiteHelp: Record<string, string> = {
  'Select a paired direct HTTPS connection before testing.':
    'This test needs a direct connection to your Core. Select it in Connection settings.',
  'Unlock the paired direct connection before testing.':
    'Unlock the direct connection to your Core, then try again.',
  'The direct Core does not match the paired remote installation.':
    'The direct connection leads to a different Core than remote access. Check the pairing.',
  'Native connection test unsupported.': 'This device does not support the connection test.',
  'An existing DATA tunnel must be stopped before testing.':
    'Another connection test is still running on this device. Wait a moment and try again.',
};
type Result = { tone: StatusTone; title: string; detail: string };
// The quick test's server-side recording ends within 45 s of its start.
const QUICK_SERVER_EXPIRY_MS = 60_000;
const QUICK_STEPS = ['Testing the connection', 'Result'] as const;
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
  onCaptureBlocked,
  blockedReason,
}: {
  disabled: boolean;
  /** Why `disabled` holds, shown instead of a silently greyed-out button. */
  blockedReason?: string | undefined;
  onBusy: (busy: boolean) => boolean | void;
  visible?: boolean;
  onReport?: () => void;
  onCaptureBlocked?: (blocked: boolean) => void;
}) {
  const serverId = getServerProfile()?.serverId;
  const storageKey = serverId ? `verity.selectedConnectionTest.v1.${serverId}` : null;
  // Only actionable problems stay on screen; the outcome lives in `result`.
  const [message, setMessage] = useState('');
  const [result, setResult] = useState<Result | null>(null);
  const [toast, showToast] = useTransientMessage();
  const [holdLeft, holdUntil, held, holdLoaded] = useHold(
    serverId ? `verity.selectedConnectionTest.hold.v1.${serverId}` : null,
  );
  const [report, setReport] = useState<ConnectionDiagnosticReport | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [saved, setSaved] = useState<SavedTest | null>(null);
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState('Preparing');
  const [archived, setArchived] = useState(false);
  const [canStartAnother, setCanStartAnother] = useState(false);
  useEffect(() => {
    onCaptureBlocked?.(
      // Until the stored wait is read, a just-discarded run may still be recording.
      !loaded ||
        !holdLoaded ||
        busy ||
        holdLeft > 0 ||
        (saved !== null && !(archived && canStartAnother)),
    );
  }, [loaded, holdLoaded, busy, holdLeft, saved, archived, canStartAnother, onCaptureBlocked]);

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
    setMessage('');
    setResult(null);
    setReport(null);
    void (async () => {
      try {
        const value = parseSavedTest(storageKey ? await AsyncStorage.getItem(storageKey) : null);
        if (!current) return;
        retained.current = value;
        setSaved(value);
        setLoaded(true);
      } catch {
        if (current)
          setMessage('Could not read the last quick test. Close and reopen Diagnostics.');
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
    if (disabled || !loaded || retained.current || operation.current || held()) return;
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
    setMessage('');
    setResult(null);
    setReport(null);
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
        setResult(
          result.status < 400
            ? {
                tone: 'ok',
                title: 'Connection works',
                detail: `Your Core answered through Uplink (HTTP ${String(result.status)}).`,
              }
            : {
                tone: 'problem',
                title: 'Connection reached Core, but it returned an error',
                detail: `HTTP ${String(result.status)}. Collect the report to see the details.`,
              },
        );
    } catch (error) {
      if (attempt) {
        attempt = { ...attempt, outcome: controller.signal.aborted ? 'cancelled' : 'failed' };
        await persist(attempt).catch(() => undefined);
      }
      recordFailure(stage, error);
      if (focused.current && scope.current === storageKey)
        setResult(
          error instanceof Error && error.message === 'Selected cleanup failed'
            ? {
                tone: 'problem',
                title: 'The test may still be running',
                detail:
                  'The app could not confirm that it stopped. Collect the report to finish it.',
              }
            : !verified && error instanceof Error && prerequisiteMessages.has(error.message)
              ? {
                  tone: 'problem',
                  title: 'The test could not start',
                  detail: prerequisiteHelp[error.message] ?? error.message,
                }
              : responseStatus !== undefined
                ? {
                    tone: 'problem',
                    title: 'Connection interrupted',
                    detail: `Your Core answered (HTTP ${String(responseStatus)}), but the test did not finish cleanly.`,
                  }
                : controller.signal.aborted
                  ? { tone: 'neutral', title: 'Test cancelled', detail: '' }
                  : {
                      tone: 'problem',
                      title: 'Connection failed',
                      detail: 'The request did not get through. The report shows where it stopped.',
                    },
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
    let nativeInactive = false;
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
            nativeInactive = true;
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
        nativeInactive = true;
        stopped =
          ['stopped', 'expired'].includes(candidate.status.phase) &&
          candidate.status.core.state === 'stopped' &&
          candidate.status.uplink.state === 'stopped' &&
          candidate.status.error === null;
      } catch (error) {
        recordFailure(stage, error);
      }
      if (controller.signal.aborted || !focused.current) return;
      let bundle = createConnectionDiagnosticReport({
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
        const retainedReport = (await loadConnectionDiagnosticReports(serverId)).find(
          (entry) => entry.runId === value.runId,
        );
        if (!retainedReport) throw new Error('Saved report unavailable');
        bundle = retainedReport;
        if (scope.current === storageKey) {
          setReport(bundle);
          setArchived(true);
          setCanStartAnother(nativeInactive && (bundle.remote.stopped || absentOnVerifiedCore));
          onReport?.();
        }
      } catch {
        stored = false;
      }
      if (controller.signal.aborted || !focused.current || scope.current !== storageKey) return;
      await Clipboard.setStringAsync(JSON.stringify(bundle));
      if (focused.current && scope.current === storageKey) {
        if (!stored) setReport(bundle);
        showToast('Report copied to the clipboard.');
        setMessage(
          `${absentOnVerifiedCore ? 'Your Core no longer has data for this test. ' : ''}${stored ? '' : 'The report could not be saved on this device – paste it somewhere before leaving.'}`.trim(),
        );
      }
    } catch (error) {
      recordFailure('clipboard', error);
      if (focused.current && scope.current === storageKey)
        setMessage('Could not copy the report. The test is kept – try again.');
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
      setMessage(
        'The app could not confirm that the last test stopped. Collect again or discard it.',
      );
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
      setMessage('');
      setResult(null);
      setReport(null);
    } catch {
      if (current())
        setMessage(
          'The app could not confirm that the last test stopped on this device. Try again.',
        );
    } finally {
      operation.current = null;
      if (focused.current) setBusy(false);
      onBusy(false);
    }
  };
  const discard = async () => {
    const expected = retained.current;
    if (!expected || operation.current || !storageKey) return;
    const controller = new AbortController();
    operation.current = controller;
    setBusy(true);
    setPhase('Stopping');
    if (onBusy(true) === false) {
      operation.current = null;
      setBusy(false);
      setMessage('Finish the long test first.');
      return;
    }
    try {
      // Discarding never runs while this device might still be capturing.
      await assertNativeTunnelInactive();
      if (scope.current !== storageKey || retained.current?.runId !== expected.runId) return;
      // Without a confirmed Core/Uplink Stop the server may still record this run
      // until it expires; persist that wait before the run disappears. A legacy
      // run without a start time predates this app version and has long expired.
      const startedAt = expected.startedAt === null ? Number.NaN : Date.parse(expected.startedAt);
      if (!(archived && canStartAnother) && Number.isFinite(startedAt))
        await holdUntil(startedAt + QUICK_SERVER_EXPIRY_MS);
      await AsyncStorage.removeItem(storageKey);
      if (scope.current !== storageKey) return;
      retained.current = null;
      setSaved(null);
      setArchived(false);
      setCanStartAnother(false);
      setLocalFailure(null);
      setResult(null);
      setReport(null);
      setMessage('');
    } catch {
      if (focused.current && scope.current === storageKey)
        setMessage(
          'The app could not confirm that the test stopped on this device. Wait a moment and try again.',
        );
    } finally {
      operation.current = null;
      if (focused.current) setBusy(false);
      onBusy(false);
    }
  };
  const confirmDiscard = () =>
    Alert.alert(
      'Discard this quick test?',
      archived
        ? 'The unfinished test is removed from this device. Its saved report is kept.'
        : 'Its data has not been collected yet and will be lost. Other saved reports are kept.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Discard', style: 'destructive', onPress: () => void discard() },
      ],
    );
  if (!visible) return null;
  const collecting = busy && phase === 'Collecting';
  const running = busy && !collecting;
  const finished = saved !== null && !busy;
  const unfinished = finished && !archived;
  const blocked = finished && archived && !canStartAnother;
  const shown: Result | null = unfinished
    ? (result ?? {
        tone: 'neutral',
        title: 'A quick test has not been finished',
        detail: `${formatReportTime(saved.startedAt)}. Collect its report to finish it, or discard it.`,
      })
    : finished && archived && report
      ? {
          tone: report.complete ? (result?.tone ?? 'ok') : 'problem',
          title: result?.title ?? 'Report saved',
          detail: completeness(report),
        }
      : !saved && !busy
        ? result
        : null;
  return (
    <TestCard
      title="Quick test"
      description="Checks once whether the connection works right now · about 5 seconds"
      attention={shown?.tone === 'problem'}
    >
      {running || collecting || finished ? (
        <StepIndicator steps={QUICK_STEPS} current={running ? 0 : 1} />
      ) : null}
      {running ? (
        <StatusLine
          title={phase === 'Stopping' ? 'Stopping…' : 'Testing the connection…'}
          detail="One request to your Core through Uplink. Stops by itself."
        />
      ) : null}
      {collecting ? (
        <StatusLine title="Collecting the report…" detail="Gathering App, Core and Uplink data." />
      ) : null}
      {shown && !busy ? (
        <StatusLine title={shown.title} detail={shown.detail} tone={shown.tone} />
      ) : null}
      {finished && archived && report ? <SourceTags sources={report.sources} /> : null}
      {blocked ? (
        <StatusLine
          tone="problem"
          title="Not confirmed as stopped"
          detail="Turn VPN on and collect again, or discard this test to start over."
        />
      ) : null}
      {message ? <StatusLine tone="problem" title={message} /> : null}
      {!saved && !busy && holdLeft > 0 ? (
        <StatusLine title={holdReason(holdLeft)} />
      ) : !saved && !busy && disabled && blockedReason ? (
        <StatusLine title={blockedReason} />
      ) : null}
      <Actions>
        {!saved && !busy ? (
          <Button
            label="Start quick test"
            disabled={disabled || !loaded || holdLeft > 0}
            fullWidth
            onPress={() => void start()}
          />
        ) : null}
        {running ? (
          <Button
            label={phase === 'Stopping' ? 'Stopping…' : 'Stop test'}
            variant="secondary"
            disabled={phase === 'Stopping'}
            fullWidth
            onPress={() => {
              setPhase('Stopping');
              operation.current?.abort();
            }}
          />
        ) : null}
        {unfinished || (finished && archived) ? (
          <Button
            label={unfinished ? 'Collect report' : 'Collect again'}
            variant={unfinished || blocked ? 'primary' : 'text'}
            disabled={disabled}
            fullWidth
            onPress={() => void collect()}
          />
        ) : null}
        {finished && archived && report ? (
          <Button
            label="Share report"
            variant={canStartAnother ? 'secondary' : 'primary'}
            fullWidth
            onPress={() => {
              Share.share({ message: JSON.stringify(report) }).catch(() =>
                showToast('Sharing is unavailable. Use Collect again to copy it.'),
              );
            }}
          />
        ) : null}
        {finished && archived && canStartAnother ? (
          <Button
            label="Start new quick test"
            disabled={disabled}
            fullWidth
            onPress={() => void another()}
          />
        ) : null}
        {unfinished || blocked ? (
          <Button
            label="Discard and start over"
            variant="text"
            fullWidth
            onPress={confirmDiscard}
          />
        ) : null}
        {localFailure && !busy ? (
          <Button
            label="Copy technical failure details"
            variant="text"
            fullWidth
            onPress={() => {
              void Clipboard.setStringAsync(JSON.stringify(localFailure)).then(
                () => showToast('Failure details copied. This is not the full report.'),
                () => setMessage('Clipboard unavailable.'),
              );
            }}
          />
        ) : null}
      </Actions>
      <Toast message={toast} />
    </TestCard>
  );
}
