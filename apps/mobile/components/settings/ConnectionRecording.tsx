import {
  createConnectionDiagnosticReport,
  loadConnectionDiagnosticReports,
  saveConnectionDiagnosticReport,
  removeConnectionDiagnosticReport,
  type ConnectionDiagnosticReport,
} from '../../lib/connectionDiagnosticReport';
import { SelectedConnectionTest } from './SelectedConnectionTest';
import type { ConnectionRecordingExport, VerityClient } from '@verity/mobile';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Clipboard from 'expo-clipboard';
import { randomUUID, digestStringAsync, CryptoDigestAlgorithm } from 'expo-crypto';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Share, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { CardRow, Eyebrow, RowCard } from '../premium/PremiumChrome';
import {
  Actions,
  Button,
  SourceTags,
  StatusLine,
  StepIndicator,
  TestCard,
  Toast,
  completeness,
  formatReportTime,
  testName,
  holdReason,
  useHold,
  useTransientMessage,
} from './DiagnosticsParts';
import { Text } from '../ui';
import {
  assertNativeTunnelInactive,
  selectedRecordingContext,
} from '../../lib/selectedRecordingContext';
import { getServerProfile } from '../../lib/serverProfile';
import {
  exportRemoteDataDiagnostics,
  validateStoredRemoteRecording,
  selectRemoteRecording,
} from '../../lib/remoteDataDiagnostics';
import {
  remoteDataRecordingRemainingMs,
  startRemoteDataRecording,
  stopRemoteDataRecording,
} from '../../lib/remoteControlTransport';

const preparationStages = [
  'storage',
  'local-and-admission',
  'remote-start',
  'attachment',
  'readiness',
  'ready',
] as const;
type Preparation = {
  stage: (typeof preparationStages)[number];
  failed: boolean;
  httpStatus?: number;
};
function httpFailureStatus(value: unknown): number | undefined {
  if (!value || typeof value !== 'object' || !('status' in value)) return undefined;
  return typeof value.status === 'number' &&
    Number.isInteger(value.status) &&
    value.status >= 400 &&
    value.status <= 599
    ? value.status
    : undefined;
}
// Core records a long test for 30 s after arming; this covers its expiry and clock skew.
const SERVER_EXPIRY_MARGIN_MS = 30_000;
const LONG_STEPS = [
  'Prepare with VPN on',
  'Turn VPN off and reproduce the problem',
  'Turn VPN on and collect',
  'Result',
] as const;
const IDLE_MESSAGE =
  'Keep VPN on and start. When asked, turn VPN off and use the app until the problem happens.';
const preparationLabels: Record<Preparation['stage'], string> = {
  storage: 'saving the run',
  'local-and-admission': 'preparing the device connection',
  'remote-start': 'starting Core and Uplink recording',
  attachment: 'connecting the recorded session',
  readiness: 'confirming recording readiness',
  ready: 'completing preparation',
};
function parsePreparation(value: unknown): Preparation | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as Preparation;
  return preparationStages.includes(candidate.stage) && typeof candidate.failed === 'boolean'
    ? {
        stage: candidate.stage,
        failed: candidate.failed,
        ...(httpFailureStatus({ status: candidate.httpStatus }) !== undefined
          ? { httpStatus: candidate.httpStatus }
          : {}),
      }
    : undefined;
}

type SavedRun = {
  runId: string;
  expiresAt: number;
  startedAt: number;
  local: string | null;
  diagnosticsVersion?: 1 | 2 | 3;
  targetSession?: string;
  preparation?: Preparation;
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
function parseSaved(raw: string | null): SavedRun | null {
  if (!raw || raw.length > 600_000) return null;
  try {
    const value = JSON.parse(raw) as SavedRun;
    if (
      !UUID.test(value.runId) ||
      (value.diagnosticsVersion !== undefined &&
        value.diagnosticsVersion !== 1 &&
        value.diagnosticsVersion !== 2 &&
        value.diagnosticsVersion !== 3) ||
      !Number.isFinite(value.expiresAt) ||
      !Number.isFinite(value.startedAt) ||
      value.startedAt < 0 ||
      value.startedAt > 8e12 ||
      value.expiresAt < value.startedAt ||
      value.expiresAt > 8e12 ||
      !(value.local === null || typeof value.local === 'string')
    )
      return null;
    return {
      runId: value.runId,
      expiresAt: value.expiresAt,
      startedAt: value.startedAt,
      diagnosticsVersion: value.diagnosticsVersion ?? 1,
      preparation: parsePreparation(value.preparation),
      ...(typeof value.targetSession === 'string' && /^[a-f0-9]{16}$/u.test(value.targetSession)
        ? { targetSession: value.targetSession }
        : {}),
      local: value.local === null ? null : validateStoredRemoteRecording(value.local),
    };
  } catch {
    return null;
  }
}

async function freshStatus(client: VerityClient, runId: string) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    return await client.getConnectionRecording(runId, controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

/** Coordinates preparation over VPN; the local Stop never depends on that path. */
export function ConnectionRecording({ client }: { client: VerityClient | null }) {
  const serverId = getServerProfile()?.serverId;
  const key = serverId ? `verity.connectionRecording.v1.${serverId}` : null;
  const currentServer = useRef(serverId);
  currentServer.current = serverId;
  const [reports, setReports] = useState<ConnectionDiagnosticReport[]>([]);
  const [reportMessage, setReportMessage] = useTransientMessage();
  const [reportsUnavailable, setReportsUnavailable] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [problemReport, setProblemReport] = useState<ConnectionDiagnosticReport | null>(null);
  const [problemArchived, setProblemArchived] = useState(false);
  const [problemStopConfirmed, setProblemStopConfirmed] = useState(false);
  const [holdLeft, holdUntil, held, holdLoaded] = useHold(
    serverId ? `verity.connectionRecording.hold.v1.${serverId}` : null,
  );
  const problemReleasedRef = useRef(false);
  problemReleasedRef.current = problemArchived && problemStopConfirmed;
  const [quickCaptureBlocked, setQuickCaptureBlocked] = useState(true);
  const quickCaptureBlockedRef = useRef(true);
  const ownQuickCapture = useCallback((blocked: boolean) => {
    quickCaptureBlockedRef.current = blocked;
    setQuickCaptureBlocked(blocked);
  }, []);
  const refreshReports = useCallback(() => {
    if (!serverId) return;
    void loadConnectionDiagnosticReports(serverId).then(
      (values) => {
        if (currentServer.current !== serverId) return;
        setReports(values);
        setReportsUnavailable(false);
      },
      () => {
        if (currentServer.current === serverId) setReportsUnavailable(true);
      },
    );
  }, [serverId]);
  useEffect(() => {
    setReports([]);
    setReportsUnavailable(false);
    setReportMessage('');
    refreshReports();
  }, [refreshReports]);
  const captureDeadline = useRef<number | null>(null);
  const runRef = useRef<SavedRun | null>(null);
  const [selectedBusy, setSelectedBusy] = useState(false);
  const selectedBusyRef = useRef(false);
  const [loaded, setLoaded] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [collecting, setCollecting] = useState(false);
  const collectingRef = useRef<number | null>(null);
  const preparingRef = useRef<number | null>(null);
  const ownSelected = useCallback(
    (busy: boolean) => {
      if (
        busy &&
        (preparingRef.current !== null ||
          collectingRef.current !== null ||
          held() ||
          (runRef.current !== null && !problemReleasedRef.current))
      )
        return false;
      selectedBusyRef.current = busy;
      setSelectedBusy(busy);
      return true;
    },
    [held],
  );
  const [ready, setReady] = useState(false);
  const [remaining, setRemaining] = useState(0);
  const [message, setMessage] = useState(IDLE_MESSAGE);
  const revision = useRef(0);
  const mounted = useRef(true);
  const saving = useRef<Promise<void>>(Promise.resolve());
  const save = (value: SavedRun) => {
    if (currentServer.current === serverId) runRef.current = value;
    const write = saving.current
      .catch(() => undefined)
      .then(async () => {
        if (!key) throw new Error('No paired server');
        await AsyncStorage.setItem(key, JSON.stringify(value));
      });
    saving.current = write;
    return write;
  };
  useEffect(() => {
    mounted.current = true;
    let current = true;
    setLoaded(false);
    setProblemArchived(false);
    setProblemStopConfirmed(false);
    setReady(false);
    setPreparing(false);
    setCollecting(false);
    setRemaining(0);
    preparingRef.current = null;
    collectingRef.current = null;
    runRef.current = null;
    captureDeadline.current = null;
    setMessage(IDLE_MESSAGE);
    setProblemReport(null);
    void (async () => {
      try {
        const saved = key ? parseSaved(await AsyncStorage.getItem(key)) : null;
        if (current) {
          runRef.current = saved;
          if (saved) setMessage('Turn VPN on and collect its report, or discard it.');
        }
      } catch {
        if (current) setMessage('Could not read the last long test. Close and reopen Diagnostics.');
      } finally {
        if (current) setLoaded(true);
      }
    })();
    return () => {
      current = false;
      mounted.current = false;
      revision.current++;
    };
  }, [key]);
  useEffect(() => {
    let current = true;
    let polling = false;
    const poll = async () => {
      // Polling only follows a saved long test, and never races its collection or
      // discard; without the old mode switch the quick test must stay untouched.
      if (
        polling ||
        selectedBusyRef.current ||
        runRef.current === null ||
        collectingRef.current !== null
      )
        return;
      polling = true;
      const token = revision.current;
      const valid = () => current && token === revision.current;
      try {
        const left = await remoteDataRecordingRemainingMs();
        if (!valid()) return;
        const saved = runRef.current;
        if (preparingRef.current !== null && captureDeadline.current === null) return;
        const remainingBudget = (budget: number | null) =>
          Math.min(
            budget ?? 0,
            captureDeadline.current !== null
              ? Math.max(0, captureDeadline.current - performance.now())
              : saved
                ? Math.max(0, saved.expiresAt - Date.now())
                : 0,
          );
        const remainingMs = remainingBudget(left);
        setRemaining(remainingMs);
        if (remainingMs <= 0) {
          setReady(false);
          if (left && saved && saved.diagnosticsVersion === 3) await stopRemoteDataRecording();
          setMessage((previous) =>
            previous.startsWith('Ready')
              ? 'Recording time is up. Turn VPN back on, then collect the report.'
              : previous,
          );
          return;
        }
        if (
          !saved ||
          saved.diagnosticsVersion !== 3 ||
          preparingRef.current !== null ||
          collectingRef.current !== null
        )
          return;
        if (!client) throw new Error('Core unavailable');
        const status = await freshStatus(client, saved.runId);
        if (!valid()) return;
        const freshLeft = await remoteDataRecordingRemainingMs();
        if (!valid()) return;
        const freshRemaining = remainingBudget(freshLeft);
        setRemaining(freshRemaining);
        if (freshRemaining <= 0) {
          setReady(false);
          setMessage('Recording time is up. Turn VPN back on, then collect the report.');
          if (freshLeft) await stopRemoteDataRecording();
          return;
        }
        const evidence = status.evidence;
        const confirmed =
          status.runId === saved.runId &&
          status.phase === 'recording' &&
          status.uplink.state === 'recording' &&
          status.core.state === 'recording' &&
          status.error === null &&
          evidence?.targetSession === saved.targetSession &&
          evidence?.readiness.ready === true &&
          evidence.readiness.installation.bound &&
          evidence.readiness.installation.active &&
          evidence.readiness.app.bound &&
          evidence.readiness.app.active;
        setReady(confirmed);
        setMessage(
          confirmed
            ? 'Ready — turn off VPN now and use the app until the problem happens. Then tap Stop.'
            : 'Core and Uplink have not confirmed the recording. This device keeps recording; stop when you are done.',
        );
      } catch {
        if (valid()) {
          setReady(false);
          setMessage(
            'Core and Uplink cannot be reached right now. This device keeps recording; turn VPN on to collect.',
          );
        }
      } finally {
        polling = false;
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 1_000);
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, [client]);

  const start = async () => {
    if (
      quickCaptureBlockedRef.current ||
      held() ||
      selectedBusyRef.current ||
      !loaded ||
      preparing ||
      collectingRef.current ||
      !key ||
      !client
    )
      return;
    if (runRef.current) {
      setMessage('Finish or discard the previous long test first.');
      return;
    }
    setProblemArchived(false);
    setProblemReport(null);
    const token = ++revision.current;
    const current = () => mounted.current && token === revision.current;
    preparingRef.current = token;
    captureDeadline.current = null;
    setRemaining(0);
    setPreparing(true);
    setReady(false);
    setMessage('Preparing this device, Core and Uplink…');
    const saved: SavedRun = {
      runId: randomUUID(),
      startedAt: Date.now(),
      expiresAt: Date.now() + 45_000,
      local: null,
      diagnosticsVersion: 3,
      preparation: { stage: 'storage', failed: false },
    };
    runRef.current = saved;
    let requested = false;
    try {
      await save(saved);
      if (!current()) return;
      saved.preparation = { stage: 'local-and-admission', failed: false };
      await startRemoteDataRecording(async (sessionId) => {
        if (!current()) throw new Error('Recording cancelled');
        const localBudget = await remoteDataRecordingRemainingMs();
        if (localBudget === null || localBudget < 45_000)
          throw new Error('Insufficient local capture window');
        captureDeadline.current = performance.now() + 45_000;
        saved.expiresAt = Date.now() + 45_000;
        saved.targetSession = (
          await digestStringAsync(CryptoDigestAlgorithm.SHA256, sessionId)
        ).slice(0, 16);
        if (!current()) throw new Error('Recording cancelled');
        await save(saved);
        if (!current()) throw new Error('Recording cancelled');
        saved.preparation = { stage: 'remote-start', failed: false };
        requested = true;
        const armed = await client.startConnectionRecording(saved.runId, 30_000, 3, sessionId);
        if (armed.error === 'uplink_version_unavailable')
          throw new Error('diagnostics_version_unavailable');
        if (
          armed.error ||
          armed.uplink.state === 'unavailable' ||
          !armed.evidence ||
          armed.evidence.targetSession !== saved.targetSession ||
          !['starting', 'recording'].includes(armed.phase)
        )
          throw new Error('Not armed');
        saved.preparation = { stage: 'attachment', failed: false };
      });
      if (!current()) return;
      captureDeadline.current = Math.min(captureDeadline.current ?? 0, performance.now() + 30_000);
      saved.expiresAt = Math.min(saved.expiresAt, Date.now() + 30_000);
      await save(saved);
      if (!current()) return;
      saved.preparation = { stage: 'readiness', failed: false };
      const status = await freshStatus(client, saved.runId);
      if (!current()) return;
      if (status.error === 'uplink_version_unavailable')
        throw new Error('diagnostics_version_unavailable');
      const left = await remoteDataRecordingRemainingMs();
      if (!current()) return;
      if (
        status.runId !== saved.runId ||
        status.phase !== 'recording' ||
        status.core.state !== 'recording' ||
        status.uplink.state !== 'recording' ||
        status.error !== null ||
        !status.evidence?.readiness.ready ||
        status.evidence.targetSession !== saved.targetSession ||
        !status.evidence.readiness.installation.bound ||
        !status.evidence.readiness.installation.active ||
        !status.evidence.readiness.app.bound ||
        !status.evidence.readiness.app.active ||
        !left ||
        captureDeadline.current <= performance.now() ||
        saved.expiresAt <= Date.now()
      )
        throw new Error('Not ready');
      saved.preparation = { stage: 'ready', failed: false };
      await save(saved);
      if (!current()) return;
      if (captureDeadline.current <= performance.now() || saved.expiresAt <= Date.now())
        throw new Error('Recording expired');
      setRemaining(Math.min(left, saved.expiresAt - Date.now()));
      setReady(true);
      setMessage(
        'Ready — turn off VPN now and use the app until the problem happens. Then tap Stop.',
      );
    } catch (error) {
      if (!current()) return;
      saved.preparation = {
        stage: saved.preparation?.stage ?? 'local-and-admission',
        failed: true,
        ...(httpFailureStatus(error) !== undefined ? { httpStatus: httpFailureStatus(error) } : {}),
      };
      const localStopped = await stopRemoteDataRecording();
      const remoteStopped =
        !requested ||
        (await client.stopConnectionRecording(saved.runId).then(
          (value) =>
            value.runId === saved.runId &&
            value.core.state === 'stopped' &&
            value.uplink.state === 'stopped',
          () => false,
        ));
      if (!current()) return;
      await save(saved).catch(() => undefined);
      if (mounted.current && token === revision.current)
        setMessage(
          `${error instanceof Error && error.message === 'diagnostics_version_unavailable' ? 'Your Uplink does not support this test yet. Update Uplink and try again.' : `It failed while ${preparationLabels[saved.preparation.stage]}.${saved.preparation.httpStatus ? ` HTTP ${String(saved.preparation.httpStatus)}.` : ''}`} ${localStopped ? '' : 'This device could not confirm that it stopped recording. '}${remoteStopped ? 'Keep VPN on and collect the report.' : 'Core and Uplink stop by themselves within a minute. Keep VPN on and collect the report.'}`,
        );
    } finally {
      // A prior DELETE may have completed before the pending start created the run.
      if (requested && !current())
        await client.stopConnectionRecording(saved.runId).catch(() => undefined);
      if (mounted.current && preparingRef.current === token) {
        preparingRef.current = null;
        setPreparing(false);
      }
    }
  };

  const collect = async () => {
    if (selectedBusyRef.current) return;
    // Duplicate taps still stop locally, but never create competing exports.
    if (collectingRef.current !== null) {
      await stopRemoteDataRecording();
      return;
    }
    const token = ++revision.current;
    collectingRef.current = token;
    setCollecting(true);
    setReady(false);
    const current = () => mounted.current && revision.current === token;
    const saved = runRef.current;
    try {
      // No Core request, storage operation or pending start can delay local Stop.
      const localStopped = await stopRemoteDataRecording();
      if (!current()) return;
      setRemaining(0);
      setMessage(
        localStopped
          ? 'Stopped. Collecting Core and Uplink data…'
          : 'Collecting the available data…',
      );
      if (!saved) {
        setMessage(
          localStopped
            ? 'Recording stopped.'
            : 'This device could not confirm that it stopped recording. Try again.',
        );
        return;
      }
      const local = await exportRemoteDataDiagnostics();
      if (!current()) return;
      let selectedLocal =
        local.status === 'ready'
          ? selectRemoteRecording(local.recording, saved.startedAt, saved.expiresAt)
          : null;
      if (selectedLocal && saved.targetSession) {
        const snapshots = JSON.parse(selectedLocal) as Array<{ sessionHash?: string }>;
        selectedLocal =
          snapshots.length === 1 && snapshots[0]?.sessionHash === saved.targetSession
            ? selectedLocal
            : null;
      }
      const updated = {
        ...saved,
        local: selectedLocal ?? saved.local,
      };
      let persisted = true;
      try {
        await save(updated);
      } catch {
        persisted = false;
      }
      if (!current()) return;
      let remote: ConnectionRecordingExport | null = null;
      let remoteStopped = false;
      let absentOnVerifiedCore = false;
      let administration: VerityClient | null = null;
      let fingerprint: string | null = null;
      try {
        const context = selectedRecordingContext();
        fingerprint = await context.verify();
        if (!current()) return;
        administration = context.client;
        const status = await administration.stopConnectionRecording(saved.runId);
        if (!current()) return;
        remoteStopped =
          status.runId === saved.runId &&
          status.core.state === 'stopped' &&
          status.uplink.state === 'stopped';
      } catch {
        // A missing stop response must not discard retained remote evidence.
      }
      if (!current()) return;
      try {
        if (!administration) throw new Error('Direct Core unavailable');
        const result = await administration.exportConnectionRecording(
          saved.runId,
          saved.diagnosticsVersion ?? 1,
        );
        if (!current()) return;
        if (
          result.status.runId === saved.runId &&
          result.status.installationFingerprint === fingerprint
        ) {
          remote = result;
          remoteStopped ||=
            ['stopped', 'expired'].includes(result.status.phase) &&
            result.status.core.state === 'stopped' &&
            result.status.uplink.state === 'stopped';
        }
      } catch (error) {
        if (
          administration &&
          error &&
          typeof error === 'object' &&
          'status' in error &&
          error.status === 404
        )
          absentOnVerifiedCore = true;
        /* Local evidence remains available while the tunnel is unavailable. */
      }
      if (!current()) return;
      let bundle = createConnectionDiagnosticReport({
        runId: saved.runId,
        startedAt: new Date(saved.startedAt).toISOString(),
        testType: 'problem_recording',
        outcome: saved.preparation?.failed ? 'failed' : 'unknown',
        preparation: saved.preparation,
        local: updated.local,
        localStopped,
        remote,
        remoteStopped,
        localUnavailableReason: local.status === 'ready' ? 'unmatched' : local.status,
      });
      let reportStored = false;
      if (serverId) {
        try {
          await saveConnectionDiagnosticReport(serverId, bundle);
          const retainedReport = (await loadConnectionDiagnosticReports(serverId)).find(
            (entry) => entry.runId === saved.runId,
          );
          if (!retainedReport) throw new Error('Saved report unavailable');
          bundle = retainedReport;
          reportStored = true;
          if (!current()) return;
          setProblemReport(bundle);
          setProblemArchived(true);
          setProblemStopConfirmed(localStopped && (bundle.remote.stopped || absentOnVerifiedCore));
          refreshReports();
        } catch {
          persisted = false;
        }
      }
      if (!current()) return;
      await Clipboard.setStringAsync(JSON.stringify(bundle));
      if (!current()) return;
      if (!reportStored) setProblemReport(bundle);
      setReportMessage('Report copied to the clipboard.');
      setMessage(
        [
          reportStored
            ? ''
            : 'The report could not be saved on this device – paste it somewhere before leaving.',
          absentOnVerifiedCore
            ? 'Your Core no longer has data for this test.'
            : !remote
              ? 'Core and Uplink data is missing. Turn VPN on and collect again.'
              : '',
          persisted ? '' : 'This device could not save its own part of the test.',
        ]
          .filter(Boolean)
          .join(' '),
      );
    } catch {
      if (current()) setMessage('Could not copy the report. The test is kept – try again.');
    } finally {
      if (collectingRef.current === token) {
        collectingRef.current = null;
        if (mounted.current) setCollecting(false);
      }
    }
  };

  const newProblem = async () => {
    const expected = runRef.current;
    if (
      !expected ||
      !problemArchived ||
      preparingRef.current !== null ||
      collectingRef.current !== null ||
      selectedBusyRef.current ||
      remaining > 0 ||
      !key
    )
      return;
    if (!problemStopConfirmed) {
      setMessage(
        'Core and Uplink have not confirmed that they stopped. Collect again or discard this test.',
      );
      return;
    }
    const token = ++revision.current;
    const current = () =>
      mounted.current &&
      token === revision.current &&
      currentServer.current === serverId &&
      runRef.current?.runId === expected.runId;
    collectingRef.current = token;
    setCollecting(true);
    try {
      if (!(await stopRemoteDataRecording())) throw new Error('Stop unconfirmed');
      if (!current()) return;
      if (
        !serverId ||
        !(await loadConnectionDiagnosticReports(serverId)).some(
          (report) => report.runId === expected.runId,
        )
      )
        throw new Error('Saved copy missing');
      if (!current()) return;
      await AsyncStorage.removeItem(key);
      if (!current()) return;
      runRef.current = null;
      setProblemArchived(false);
      setProblemStopConfirmed(false);
      setProblemReport(null);
      setMessage(IDLE_MESSAGE);
    } catch {
      if (current())
        setMessage(
          'The app could not confirm that the last test stopped. Collect again or discard it.',
        );
    } finally {
      if (collectingRef.current === token) {
        collectingRef.current = null;
        setCollecting(false);
      }
    }
  };
  const discardProblem = async () => {
    const expected = runRef.current;
    if (
      !expected ||
      preparingRef.current !== null ||
      collectingRef.current !== null ||
      selectedBusyRef.current ||
      !key
    )
      return;
    const token = ++revision.current;
    const current = () =>
      mounted.current &&
      token === revision.current &&
      currentServer.current === serverId &&
      runRef.current?.runId === expected.runId;
    collectingRef.current = token;
    setCollecting(true);
    let stage: 'stop' | 'storage' = 'stop';
    try {
      // Only a confirmed local Stop lets the unfinished run go; saved reports stay.
      // A device without the native tunnel can never confirm Stop, but it also
      // cannot be capturing, so only that case may discard without it.
      if (!(await stopRemoteDataRecording())) {
        const unsupported = await assertNativeTunnelInactive().then(
          () => false,
          (error: unknown) =>
            error instanceof Error && error.message === 'Native connection test unsupported.',
        );
        if (!unsupported) throw new Error('Stop unconfirmed');
      }
      if (!current()) return;
      // Core and Uplink may still record this run. Without their confirmed Stop,
      // no new test starts until the run has expired on the server side.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const remoteStopped = client
        ? await Promise.race([
            client.stopConnectionRecording(expected.runId).then(
              (value) =>
                value.runId === expected.runId &&
                value.core.state === 'stopped' &&
                value.uplink.state === 'stopped',
              () => false,
            ),
            new Promise<false>((resolve) => {
              timer = setTimeout(() => resolve(false), 5000);
            }),
          ]).finally(() => clearTimeout(timer))
        : false;
      if (!current()) return;
      // Persist the wait before the run disappears, so no reopening skips it.
      stage = 'storage';
      // A save still in flight (collect or the expiry poll) must not write the
      // discarded run back after it has been removed.
      await saving.current.catch(() => undefined);
      if (!current()) return;
      if (!remoteStopped) await holdUntil(expected.expiresAt + SERVER_EXPIRY_MARGIN_MS);
      await AsyncStorage.removeItem(key);
      if (!current()) return;
      runRef.current = null;
      setProblemArchived(false);
      setProblemStopConfirmed(false);
      setProblemReport(null);
      setReady(false);
      setRemaining(0);
      setMessage(IDLE_MESSAGE);
      setReportMessage('Unfinished long test discarded.');
    } catch {
      if (current())
        setMessage(
          stage === 'stop'
            ? 'The app could not confirm that this device stopped recording. Wait a moment and try again.'
            : 'This device could not update its saved test. Nothing was discarded; try again.',
        );
    } finally {
      if (collectingRef.current === token) {
        collectingRef.current = null;
        setCollecting(false);
      }
    }
  };
  const shareReport = (value: ConnectionDiagnosticReport) => {
    Share.share({ message: JSON.stringify(value) }).catch(() =>
      setReportMessage('Sharing is unavailable. Use Copy instead.'),
    );
  };
  const confirmDiscardProblem = () =>
    Alert.alert(
      'Discard this long test?',
      problemArchived
        ? 'The unfinished test is removed from this device. Its saved report is kept.'
        : 'Its data has not been collected yet and will be lost. Other saved reports are kept.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Discard', style: 'destructive', onPress: () => void discardProblem() },
      ],
    );
  const switchDisabled = selectedBusy || preparing || collecting || remaining > 0;
  const run = runRef.current;
  const recording = !preparing && !collecting && remaining > 0;
  const awaitingCollection =
    run !== null && !problemArchived && !preparing && !collecting && !recording;
  const archivedRun = run !== null && problemArchived && !preparing && !collecting && !recording;
  const step = preparing ? 0 : recording ? 1 : collecting || awaitingCollection ? 2 : 3;
  const longBlockedReason = !loaded
    ? 'Loading…'
    : !client
      ? 'Connect to your Core first.'
      : holdLeft > 0
        ? holdReason(holdLeft)
        : selectedBusy
          ? 'Finish the quick test first.'
          : quickCaptureBlocked
            ? 'Waiting for the quick test above.'
            : undefined;
  const quickBlockedReason =
    preparing ||
    collecting ||
    remaining > 0 ||
    (run !== null && !(problemArchived && problemStopConfirmed))
      ? 'Finish the long test first.'
      : holdLeft > 0
        ? holdReason(holdLeft)
        : !client
          ? 'Connect to your Core first.'
          : undefined;
  const failedPreparation = run?.preparation?.failed === true;
  return (
    <View>
      <Eyebrow>Connection tests</Eyebrow>
      <View style={styles.stack}>
        <SelectedConnectionTest
          disabled={
            !loaded ||
            preparing ||
            collecting ||
            remaining > 0 ||
            !holdLoaded ||
            holdLeft > 0 ||
            !client ||
            (runRef.current !== null && !(problemArchived && problemStopConfirmed))
          }
          blockedReason={quickBlockedReason}
          onBusy={ownSelected}
          onCaptureBlocked={ownQuickCapture}
          onReport={refreshReports}
        />
        <TestCard
          title="Long test with VPN switch-off"
          description="For problems that only appear sometimes · up to 30 seconds"
          attention={failedPreparation || (archivedRun && !problemStopConfirmed)}
        >
          {run || preparing ? <StepIndicator steps={LONG_STEPS} current={step} /> : null}
          {preparing ? <StatusLine title="Preparing…" detail={message} /> : null}
          {recording ? (
            <StatusLine
              title={`${ready ? 'Recording' : 'Recording, not confirmed'} · ${String(Math.ceil(remaining / 1000))} s left`}
              detail={message}
              tone={ready ? 'ok' : 'problem'}
            />
          ) : null}
          {collecting ? <StatusLine title="Collecting the report…" detail={message} /> : null}
          {awaitingCollection ? (
            <StatusLine
              title={
                failedPreparation
                  ? 'Preparation failed'
                  : `Recording finished · ${formatReportTime(new Date(run.startedAt).toISOString())}`
              }
              detail={message}
              tone={failedPreparation ? 'problem' : 'neutral'}
            />
          ) : null}
          {archivedRun ? (
            <>
              <StatusLine
                title="Report saved"
                detail={problemReport ? completeness(problemReport) : undefined}
                tone={problemReport && !problemReport.complete ? 'problem' : 'ok'}
              />
              {problemReport ? <SourceTags sources={problemReport.sources} /> : null}
              {!problemStopConfirmed ? (
                <StatusLine
                  tone="problem"
                  title="Not confirmed as stopped"
                  detail="Turn VPN on and collect again, or discard this test to start over."
                />
              ) : null}
              {message ? <StatusLine title={message} tone="problem" /> : null}
            </>
          ) : null}
          {!run && !preparing ? <StatusLine title={longBlockedReason ?? message} /> : null}
          <Actions>
            {!run && !preparing ? (
              <Button
                label="Start long test"
                fullWidth
                disabled={
                  selectedBusy ||
                  quickCaptureBlocked ||
                  !loaded ||
                  collecting ||
                  !key ||
                  !client ||
                  !holdLoaded ||
                  holdLeft > 0 ||
                  remaining > 0
                }
                onPress={() => void start()}
              />
            ) : null}
            {preparing || recording ? (
              <Button
                label={preparing ? 'Cancel' : 'Stop recording'}
                variant={preparing ? 'secondary' : 'primary'}
                fullWidth
                disabled={selectedBusy}
                onPress={() => void collect()}
              />
            ) : null}
            {awaitingCollection || archivedRun ? (
              <Button
                label={archivedRun ? 'Collect again' : 'Collect report'}
                variant={archivedRun && problemStopConfirmed ? 'text' : 'primary'}
                fullWidth
                disabled={selectedBusy}
                onPress={() => void collect()}
              />
            ) : null}
            {(archivedRun || awaitingCollection) && problemReport ? (
              <Button
                label="Share report"
                variant={problemStopConfirmed ? 'secondary' : 'primary'}
                fullWidth
                onPress={() => shareReport(problemReport)}
              />
            ) : null}
            {archivedRun && problemStopConfirmed ? (
              <Button label="Start new long test" fullWidth onPress={() => void newProblem()} />
            ) : null}
            {awaitingCollection || (archivedRun && !problemStopConfirmed) ? (
              <Button
                label="Discard and start over"
                variant="text"
                fullWidth
                disabled={selectedBusy}
                onPress={confirmDiscardProblem}
              />
            ) : null}
          </Actions>
        </TestCard>
      </View>
      <Toast message={reportMessage} />
      {reportsUnavailable ? (
        <StatusLine
          tone="problem"
          title="Saved reports could not be loaded"
          detail="Nothing was deleted. Close and reopen Diagnostics to try again."
        />
      ) : null}
      {reports.length > 0 ? (
        <>
          <Eyebrow>Saved reports</Eyebrow>
          <RowCard>
            {reports.map((report) => {
              const open = expanded === report.runId;
              return (
                <View key={report.runId}>
                  <CardRow
                    title={`${testName(report.testType)} · ${formatReportTime(report.startedAt)}`}
                    subtitle={completeness(report)}
                    chevron={false}
                    accessibilityLabel={`${testName(report.testType)}, ${formatReportTime(report.startedAt)}, ${completeness(report)}. ${open ? 'Hide' : 'Show'} actions`}
                    onPress={() => setExpanded(open ? null : report.runId)}
                  />
                  {open ? (
                    <View style={styles.reportDetail}>
                      <SourceTags sources={report.sources} />
                      <Actions>
                        <Button
                          label="Share"
                          size="compact"
                          disabled={switchDisabled}
                          onPress={() => shareReport(report)}
                        />
                        <Button
                          label="Copy"
                          size="compact"
                          variant="secondary"
                          disabled={switchDisabled}
                          onPress={() => {
                            void Clipboard.setStringAsync(JSON.stringify(report)).then(
                              () => setReportMessage('Report copied to the clipboard.'),
                              () => setReportMessage('Clipboard unavailable.'),
                            );
                          }}
                        />
                        <Button
                          label="Delete"
                          size="compact"
                          variant="destructive"
                          disabled={switchDisabled}
                          onPress={() => {
                            Alert.alert(
                              'Delete this report?',
                              'It is removed from this device. Share or copy it first if you still need it.',
                              [
                                { text: 'Cancel', style: 'cancel' },
                                {
                                  text: 'Delete',
                                  style: 'destructive',
                                  onPress: () => {
                                    if (serverId)
                                      void removeConnectionDiagnosticReport(
                                        serverId,
                                        report.runId,
                                      ).then(
                                        () => {
                                          if (runRef.current?.runId === report.runId)
                                            setProblemArchived(false);
                                          setExpanded(null);
                                          refreshReports();
                                        },
                                        () => setReportMessage('Could not delete the report.'),
                                      );
                                  },
                                },
                              ],
                            );
                          }}
                        />
                      </Actions>
                      <Text variant="footnote">
                        {[
                          `Run ${report.runId}`,
                          `This device stopped: ${report.app.stopped ? 'yes' : 'not confirmed'}`,
                          `Core and Uplink stopped: ${report.remote.stopped ? 'yes' : 'not confirmed'}`,
                          report.gaps.length > 0 ? `Notes: ${report.gaps.join(', ')}` : '',
                        ]
                          .filter(Boolean)
                          .join('\n')}
                      </Text>
                    </View>
                  ) : null}
                </View>
              );
            })}
          </RowCard>
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  stack: { gap: theme.spacing.md },
  reportDetail: {
    gap: theme.spacing.md,
    paddingHorizontal: theme.spacing.lg,
    paddingBottom: theme.spacing.lg,
  },
}));
