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
import { Alert, View } from 'react-native';
import { CardRow, Eyebrow, RowCard } from '../premium/PremiumChrome';
import { selectedRecordingContext } from '../../lib/selectedRecordingContext';
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
  const [mode, setMode] = useState<'quick' | 'problem' | null>(null);
  const [reports, setReports] = useState<ConnectionDiagnosticReport[]>([]);
  const [reportMessage, setReportMessage] = useState('');
  const [problemArchived, setProblemArchived] = useState(false);
  const [problemStopConfirmed, setProblemStopConfirmed] = useState(false);
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
        if (currentServer.current === serverId) setReports(values);
      },
      () => {
        if (currentServer.current === serverId)
          setReportMessage('Saved reports unavailable. Existing evidence has not been replaced.');
      },
    );
  }, [serverId]);
  useEffect(() => {
    setReports([]);
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
  const ownSelected = useCallback((busy: boolean) => {
    if (
      busy &&
      (preparingRef.current !== null ||
        collectingRef.current !== null ||
        (runRef.current !== null && !problemReleasedRef.current))
    )
      return false;
    selectedBusyRef.current = busy;
    setSelectedBusy(busy);
    return true;
  }, []);
  const [ready, setReady] = useState(false);
  const [remaining, setRemaining] = useState(0);
  const [message, setMessage] = useState(
    'Connect through VPN to prepare App, Core and Uplink together for a 30-second test.',
  );
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
    setMessage(
      'Connect through VPN to prepare App, Core and Uplink together for a 30-second test.',
    );
    void (async () => {
      try {
        const saved = key ? parseSaved(await AsyncStorage.getItem(key)) : null;
        if (current) {
          runRef.current = saved;
          if (saved)
            setMessage(
              `Saved problem recording · ${new Date(saved.startedAt).toISOString()} · ${saved.runId.slice(0, 8)}. ${saved.preparation?.failed ? 'Preparation failed. ' : ''}Collect this run’s report with VPN; it is separate from the quick test.`,
            );
        }
      } catch {
        if (current) setMessage('Could not read the saved run. Recording is unavailable.');
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
      if (polling || mode !== 'problem' || selectedBusyRef.current) return;
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
              ? 'Local recording ended. Stop and collect the saved evidence.'
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
          setMessage('Local recording ended. Stop and collect the saved evidence.');
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
            ? 'Ready — turn off VPN and use the app normally. Stop and collect when finished.'
            : 'Recording readiness is unconfirmed. Local evidence remains available; stop and collect.',
        );
      } catch {
        if (valid()) {
          setReady(false);
          setMessage(
            'Recording readiness is unconfirmed. Local evidence remains available; reconnect VPN to collect.',
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
  }, [client, mode]);

  const start = async () => {
    if (
      quickCaptureBlockedRef.current ||
      selectedBusyRef.current ||
      !loaded ||
      preparing ||
      collectingRef.current ||
      !key ||
      !client
    )
      return;
    if (runRef.current) {
      setMessage(
        'A saved problem recording is selected. Collect its report before starting another.',
      );
      return;
    }
    setProblemArchived(false);
    const token = ++revision.current;
    const current = () => mounted.current && token === revision.current;
    preparingRef.current = token;
    captureDeadline.current = null;
    setRemaining(0);
    setPreparing(true);
    setReady(false);
    setMessage('Preparing local recording, Core and Uplink…');
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
      setMessage('Ready — turn off VPN and use the app normally. Stop and collect when finished.');
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
          `${error instanceof Error && error.message === 'diagnostics_version_unavailable' ? 'Uplink does not support this recording version. Update Uplink before retrying.' : `Preparation failed while ${preparationLabels[saved.preparation.stage]}.${saved.preparation.httpStatus ? ` HTTP ${String(saved.preparation.httpStatus)}.` : ''}`} ${localStopped ? 'Local recording stopped.' : 'Local stop could not be confirmed.'} ${remoteStopped ? 'Keep VPN on and retry.' : 'Core/Uplink stop unconfirmed; they expire automatically. Retry collection with VPN.'}`,
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
          ? 'Local recording stopped. Collecting Core and Uplink…'
          : 'Local stop unconfirmed. Collecting available evidence…',
      );
      if (!saved) {
        setMessage(
          localStopped
            ? 'Local recording stopped. No coordinated run saved.'
            : 'Local stop could not be confirmed.',
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
      setMessage(
        `${bundle.complete ? 'Complete report copied.' : 'Partial report copied. Missing evidence and Stop status are listed in the report.'} ${reportStored ? 'Retained in Saved reports.' : 'Saving failed or Saved reports is full; keep this screen open.'} ${absentOnVerifiedCore ? 'Core has no retained report for this run. Saved local evidence remains available.' : !remote ? 'Turn VPN on and collect this same run again.' : ''} ${!persisted ? 'Local saving could not be confirmed.' : ''}`,
      );
    } catch {
      if (current()) setMessage('Could not copy the recording. Retry Stop and collect.');
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
      setMessage('Stop remains unconfirmed. Collect this run again before starting another.');
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
      setMessage('Ready for a new problem recording. Previous report retained in Saved reports.');
    } catch {
      if (current())
        setMessage('Stop or saving could not be confirmed. Keep collecting the selected run.');
    } finally {
      if (collectingRef.current === token) {
        collectingRef.current = null;
        setCollecting(false);
      }
    }
  };
  const switchDisabled = selectedBusy || preparing || collecting || remaining > 0;
  return (
    <View>
      <Eyebrow>Connection diagnostics</Eyebrow>
      <RowCard>
        <CardRow
          title="Quick connection test"
          subtitle="One health request, then automatic Stop. Collects App, Core and Uplink evidence."
          disabled={switchDisabled}
          onPress={() => setMode('quick')}
        />
        <CardRow
          title="Record a connection problem"
          subtitle="Prepare with VPN, then reproduce the problem. Up to 30 seconds; Stop remains available on this device."
          disabled={switchDisabled}
          onPress={() => setMode('problem')}
        />
      </RowCard>
      {mode ? (
        <RowCard>
          <SelectedConnectionTest
            visible={mode === 'quick'}
            disabled={
              !loaded ||
              preparing ||
              collecting ||
              remaining > 0 ||
              !client ||
              (runRef.current !== null && !(problemArchived && problemStopConfirmed))
            }
            onBusy={ownSelected}
            onCaptureBlocked={ownQuickCapture}
            onReport={refreshReports}
          />
          {mode === 'problem' ? (
            <>
              <CardRow title="Problem recording" subtitle={message} chevron={false} />
              {runRef.current ? (
                <CardRow
                  title={`Problem recording · ${runRef.current.runId.slice(0, 8)}`}
                  subtitle={`${new Date(runRef.current.startedAt).toISOString()} · ${preparing ? 'Preparing' : collecting ? 'Collecting' : ready ? 'Recording' : 'Saved / ended'}`}
                  chevron={false}
                />
              ) : null}
              {!runRef.current ? (
                <CardRow
                  title="Start problem recording"
                  disabled={
                    selectedBusy ||
                    quickCaptureBlocked ||
                    !loaded ||
                    preparing ||
                    collecting ||
                    !key ||
                    !client ||
                    remaining > 0
                  }
                  onPress={() => void start()}
                />
              ) : null}
              {runRef.current || preparing ? (
                <CardRow
                  title={
                    collecting
                      ? 'Collecting report…'
                      : preparing || remaining > 0
                        ? 'Stop and collect'
                        : 'Collect problem report'
                  }
                  disabled={selectedBusy || collecting}
                  subtitle={
                    preparing || remaining > 0
                      ? 'Stops this device immediately. Core and Uplink collection may need VPN.'
                      : 'This saved problem recording only; does not start another capture.'
                  }
                  onPress={() => void collect()}
                />
              ) : null}
              {problemArchived && !preparing && !collecting && remaining <= 0 ? (
                <CardRow
                  title="Start another problem recording"
                  subtitle="Previous report remains in Saved reports."
                  onPress={() => void newProblem()}
                />
              ) : null}
              {ready ? (
                <CardRow
                  title={`${String(Math.ceil(remaining / 1000))} seconds of local recording remaining`}
                  chevron={false}
                />
              ) : null}
            </>
          ) : null}
        </RowCard>
      ) : null}
      {reports.length > 0 || reportMessage ? (
        <>
          <Eyebrow>Saved reports</Eyebrow>
          <RowCard>
            {reportMessage ? (
              <CardRow title="Report status" subtitle={reportMessage} chevron={false} />
            ) : null}
            {reports.map((report) => (
              <View key={report.runId}>
                <CardRow
                  title={`${report.testType === 'quick_test' ? 'Quick test' : 'Problem recording'} · ${report.runId.slice(0, 8)}`}
                  subtitle={`${report.startedAt ?? 'Older run — start time unavailable'} · ${report.complete ? 'Complete' : 'Partial'} · App ${report.sources.app ? 'available' : 'missing'}, Core ${report.sources.core ? 'available' : 'missing'}, Uplink ${report.sources.uplink ? 'available' : 'missing'} · Copy saved report`}
                  disabled={switchDisabled}
                  onPress={() => {
                    void Clipboard.setStringAsync(JSON.stringify(report)).then(
                      () =>
                        setReportMessage(
                          'Saved report copied. No new capture or collection started.',
                        ),
                      () => setReportMessage('Clipboard unavailable. Saved report retained.'),
                    );
                  }}
                />
                <CardRow
                  title={`Delete saved report · ${report.runId.slice(0, 8)}`}
                  disabled={switchDisabled}
                  onPress={() => {
                    Alert.alert(
                      'Delete saved report?',
                      'This removes this saved copy from this device. Copy the report first if you need to keep it.',
                      [
                        { text: 'Cancel', style: 'cancel' },
                        {
                          text: 'Delete',
                          style: 'destructive',
                          onPress: () => {
                            if (serverId)
                              void removeConnectionDiagnosticReport(serverId, report.runId).then(
                                () => {
                                  if (runRef.current?.runId === report.runId)
                                    setProblemArchived(false);
                                  refreshReports();
                                },
                                () => setReportMessage('Could not delete the saved report.'),
                              );
                          },
                        },
                      ],
                    );
                  }}
                />
              </View>
            ))}
          </RowCard>
        </>
      ) : null}
    </View>
  );
}
