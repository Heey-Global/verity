import AsyncStorage from '@react-native-async-storage/async-storage';
import { connectionRecordingExportSchema, type ConnectionRecordingExport } from '@verity/mobile';
import { validateStoredRemoteRecording } from './remoteDataDiagnostics';

const unavailableReasons = [
  'unsupported',
  'empty',
  'invalid',
  'failed',
  'unmatched',
  'ambiguous',
  'pending',
  'unavailable',
  'legacy',
] as const;
type LocalRecordingUnavailableReason = (typeof unavailableReasons)[number];
type ConnectionDiagnosticTestType = 'quick_test' | 'problem_recording';
type ConnectionDiagnosticOutcome = 'completed' | 'cancelled' | 'failed' | 'unknown';
const preparationStages = [
  'storage',
  'local-and-admission',
  'remote-start',
  'attachment',
  'readiness',
  'ready',
] as const;
type DiagnosticPreparation = {
  stage: (typeof preparationStages)[number];
  failed: boolean;
  httpStatus?: number;
};
export interface ConnectionDiagnosticReportInput {
  runId: string;
  startedAt: string | null;
  testType: ConnectionDiagnosticTestType;
  outcome: ConnectionDiagnosticOutcome;
  local: string | null;
  localStopped: boolean;
  remote: ConnectionRecordingExport | null;
  remoteStopped: boolean;
  terminalRecording?: ConnectionRecordingExport;
  localUnavailableReason?: string;
  preparation?: DiagnosticPreparation | null;
}

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu;
const maximumReportCharacters = 1_000_000;
const maximumReports = 8;
function sortedJson(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) =>
    entry && typeof entry === 'object' && !Array.isArray(entry)
      ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b)))
      : entry,
  );
}

function acceptedRemote(value: unknown, runId: string): ConnectionRecordingExport | null {
  const parsed = connectionRecordingExportSchema.safeParse(value);
  // Some historical record schemas project unknown fields. A retained report must
  // never smuggle those discarded fields back into the public support export.
  if (
    !parsed.success ||
    parsed.data.status.runId !== runId ||
    sortedJson(parsed.data) !== sortedJson(value)
  )
    return null;
  return value as ConnectionRecordingExport;
}

/** Preserve the already verified server document, including its canonical hash. */
export function createConnectionDiagnosticReport(input: ConnectionDiagnosticReportInput) {
  if (
    !uuid.test(input.runId) ||
    !['quick_test', 'problem_recording'].includes(input.testType) ||
    !['completed', 'cancelled', 'failed', 'unknown'].includes(input.outcome) ||
    (input.startedAt !== null &&
      (!/^\d{4}-\d{2}-\d{2}T/u.test(input.startedAt) ||
        !Number.isFinite(Date.parse(input.startedAt))))
  )
    throw new Error('Invalid diagnostic report identity');
  let preparation: DiagnosticPreparation | null = null;
  if (input.preparation) {
    const value = input.preparation;
    if (
      !preparationStages.includes(value.stage) ||
      typeof value.failed !== 'boolean' ||
      (value.httpStatus !== undefined &&
        (!Number.isInteger(value.httpStatus) || value.httpStatus < 400 || value.httpStatus > 599))
    )
      throw new Error('Invalid diagnostic preparation');
    preparation = {
      stage: value.stage,
      failed: value.failed,
      ...(value.httpStatus !== undefined ? { httpStatus: value.httpStatus } : {}),
    };
  }
  const remote = input.remote ? acceptedRemote(input.remote, input.runId) : null;
  let local = input.local ? validateStoredRemoteRecording(input.local) : null;
  let reason: LocalRecordingUnavailableReason = unavailableReasons.includes(
    input.localUnavailableReason as LocalRecordingUnavailableReason,
  )
    ? (input.localUnavailableReason as LocalRecordingUnavailableReason)
    : 'unavailable';
  let snapshots = local
    ? (JSON.parse(local) as Array<{
        sessionHash?: string;
        startedLate: boolean;
        delegateAvailable: boolean;
        dropped: number;
        streamUpdatesDropped?: number;
        events: Array<{ event: string }>;
      }>)
    : [];
  if (snapshots.length === 0) local = null;
  else if (snapshots.length !== 1) {
    local = null;
    snapshots = [];
    reason = 'ambiguous';
  }
  const sessionHash =
    remote?.status.selection?.sessionHash ?? remote?.status.evidence?.targetSession;
  if (sessionHash && snapshots.some((snapshot) => snapshot.sessionHash !== sessionHash)) {
    local = null;
    snapshots = [];
    reason = 'unmatched';
  } else if (input.local && !local && reason !== 'ambiguous') reason = 'invalid';
  const sources = {
    app: local !== null,
    core: remote !== null,
    uplink: remote?.uplink.available === true,
  };
  const receipt = input.terminalRecording
    ? acceptedRemote(input.terminalRecording, input.runId)
    : null;
  const terminal = (value: ConnectionRecordingExport | null) =>
    value !== null &&
    ['stopped', 'expired'].includes(value.status.phase) &&
    value.status.core.state === 'stopped' &&
    value.status.uplink.state === 'stopped';
  const terminalRecording =
    receipt &&
    terminal(receipt) &&
    remote &&
    receipt.status.installationFingerprint === remote.status.installationFingerprint &&
    receipt.status.startedAt === remote.status.startedAt
      ? receipt
      : null;
  const remoteStopped = input.remoteStopped && (terminal(remote) || terminalRecording !== null);
  const uplink = remote?.uplink.data;
  const gaps: string[] = [];
  if (!sources.app) gaps.push('app_unavailable');
  if (!sources.core) gaps.push('core_unavailable');
  if (!sources.uplink) gaps.push('uplink_unavailable');
  if (sessionHash === undefined) gaps.push('unbound_session');
  if (!input.localStopped) gaps.push('local_stop_unconfirmed');
  if (!remoteStopped) gaps.push('remote_stop_unconfirmed');
  if (preparation?.failed) gaps.push('preparation_failed');
  // A terminal receipt confirms Stop, but cannot make older active Uplink evidence final.
  if (terminalRecording && remote && !terminal(remote)) gaps.push('retained_active_snapshot');
  if (
    remote?.status.error ||
    remote?.failures?.stop ||
    remote?.failures?.export ||
    terminalRecording?.status.error ||
    terminalRecording?.failures?.stop ||
    terminalRecording?.failures?.export
  )
    gaps.push('remote_failure');
  if (
    (remote && remote.status.core.records !== remote.core.records.length) ||
    (uplink && uplink.recordCount !== uplink.records.length)
  )
    gaps.push('record_count_mismatch');
  if (remote?.status.core.dropped || remote?.core.dropped || uplink?.droppedRecords)
    gaps.push('server_records_dropped');
  if (uplink && 'diagnosticErrors' in uplink && uplink.diagnosticErrors !== 0)
    gaps.push('collector_errors');
  if (uplink && 'omittedBindings' in uplink && uplink.omittedBindings !== 0)
    gaps.push('omitted_bindings');
  if (snapshots.some((snapshot) => snapshot.startedLate)) gaps.push('native_started_late');
  if (snapshots.some((snapshot) => snapshot.dropped || snapshot.streamUpdatesDropped))
    gaps.push('native_events_dropped');
  if (snapshots.some((snapshot) => !snapshot.delegateAvailable))
    gaps.push('native_delegate_unavailable');
  if (
    snapshots.some((snapshot) => !snapshot.events.some((event) => event.event === 'task_completed'))
  )
    gaps.push('native_task_completion_missing');
  const complete = gaps.length === 0;
  return {
    version: 2 as const,
    runId: input.runId,
    startedAt: input.startedAt,
    testType: input.testType,
    outcome: input.outcome,
    // Test policy, not a causal claim about any observed socket close.
    expectedAutomaticStop: input.testType === 'quick_test',
    preparation,
    complete,
    gaps,
    sources,
    app: {
      available: sources.app,
      stopped: input.localStopped,
      recording: local ? (JSON.parse(local) as unknown[]) : null,
      unavailableReason: local ? null : reason,
    },
    remote: {
      available: sources.core,
      stopped: remoteStopped,
      recording: remote,
      ...(terminalRecording ? { terminalRecording } : {}),
    },
  };
}
export type ConnectionDiagnosticReport = ReturnType<typeof createConnectionDiagnosticReport>;

/** Storage is untrusted: validate source documents and recompute derived claims. */
export function parseStoredConnectionDiagnosticReport(
  raw: string,
): ConnectionDiagnosticReport | null {
  if (raw.length > maximumReportCharacters) return null;
  try {
    const value = JSON.parse(raw) as ConnectionDiagnosticReport;
    if (
      value.version !== 2 ||
      typeof value.app?.stopped !== 'boolean' ||
      typeof value.remote?.stopped !== 'boolean'
    )
      return null;
    const safe = createConnectionDiagnosticReport({
      runId: value.runId,
      startedAt: value.startedAt,
      testType: value.testType,
      outcome: value.outcome,
      local: value.app.recording === null ? null : JSON.stringify(value.app.recording),
      localStopped: value.app.stopped,
      remote: value.remote.recording,
      remoteStopped: value.remote.stopped,
      terminalRecording: value.remote.terminalRecording,
      localUnavailableReason: value.app.unavailableReason ?? undefined,
      preparation: value.preparation,
    });
    return sortedJson(safe) === sortedJson(value) ? safe : null;
  } catch {
    return null;
  }
}

function historyKey(serverId: string) {
  if (!serverId || serverId.length > 512) throw new Error('Invalid diagnostic server');
  return `verity.connectionDiagnosticReports.v1.${serverId}`;
}

export async function loadConnectionDiagnosticReports(
  serverId: string,
): Promise<ConnectionDiagnosticReport[]> {
  const raw = await AsyncStorage.getItem(historyKey(serverId));
  if (raw === null) return [];
  if (raw.length > maximumReportCharacters * maximumReports + 16)
    throw new Error('Invalid diagnostic report history');
  const values: unknown = JSON.parse(raw);
  if (!Array.isArray(values) || values.length > maximumReports)
    throw new Error('Invalid diagnostic report history');
  const reports = values.map((value: unknown) =>
    parseStoredConnectionDiagnosticReport(JSON.stringify(value)),
  );
  if (reports.some((report) => report === null))
    throw new Error('Invalid diagnostic report history');
  const safe = reports as ConnectionDiagnosticReport[];
  if (new Set(safe.map((report) => report.runId)).size !== safe.length)
    throw new Error('Duplicate diagnostic report identity');
  return safe;
}

// Serialize read/modify/write operations so concurrent collection cannot lose a report.
let historyWrite: Promise<void> = Promise.resolve();
export async function saveConnectionDiagnosticReport(
  serverId: string,
  report: ConnectionDiagnosticReport,
): Promise<void> {
  const safe = parseStoredConnectionDiagnosticReport(JSON.stringify(report));
  if (!safe) throw new Error('Invalid diagnostic report');
  const write = historyWrite
    .catch(() => undefined)
    .then(async () => {
      const reports = await loadConnectionDiagnosticReports(serverId);
      const existing = reports.findIndex((entry) => entry.runId === safe.runId);
      if (existing < 0) {
        if (reports.length >= maximumReports) throw new Error('Diagnostic report history is full');
        reports.unshift(safe);
      } else {
        const previous = reports[existing]!;
        if (
          previous.testType !== safe.testType ||
          (previous.startedAt !== null &&
            safe.startedAt !== null &&
            previous.startedAt !== safe.startedAt)
        )
          throw new Error('Diagnostic report identity changed');
        // Recollection after server expiry must not replace retained evidence with
        // an unavailable response, or forget an already confirmed local Stop.
        const candidate = safe.remote.recording;
        const losesUplink =
          previous.remote.recording?.uplink.available === true &&
          candidate?.uplink.available !== true;
        const remote =
          candidate && !(previous.remote.stopped && !safe.remote.stopped) && !losesUplink
            ? candidate
            : previous.remote.recording;
        const local = safe.app.recording ?? previous.app.recording;
        const remoteIsTerminal =
          remote &&
          ['stopped', 'expired'].includes(remote.status.phase) &&
          remote.status.core.state === 'stopped' &&
          remote.status.uplink.state === 'stopped';
        const terminalRecording = remoteIsTerminal
          ? null
          : (safe.remote.terminalRecording ??
            previous.remote.terminalRecording ??
            (safe.remote.stopped && !previous.remote.stopped && candidate !== remote
              ? candidate
              : null));
        reports[existing] = createConnectionDiagnosticReport({
          runId: safe.runId,
          startedAt: safe.startedAt ?? previous.startedAt,
          testType: safe.testType,
          outcome: safe.outcome === 'unknown' ? previous.outcome : safe.outcome,
          local: local === null ? null : JSON.stringify(local),
          localStopped: safe.app.stopped || previous.app.stopped,
          remote,
          remoteStopped: safe.remote.stopped || previous.remote.stopped,
          terminalRecording: terminalRecording ?? undefined,
          localUnavailableReason: safe.app.unavailableReason ?? undefined,
          preparation: safe.preparation ?? previous.preparation,
        });
      }
      // Merging two valid exports can exceed the per-report bound. Keep the
      // previous history intact rather than writing a report we cannot reopen.
      if (reports.some((entry) => !parseStoredConnectionDiagnosticReport(JSON.stringify(entry))))
        throw new Error('Merged diagnostic report exceeds storage bounds');
      await AsyncStorage.setItem(historyKey(serverId), JSON.stringify(reports));
    });
  historyWrite = write;
  await write;
}

/** Delete only the report explicitly selected by the user. Never evict automatically. */
export async function removeConnectionDiagnosticReport(
  serverId: string,
  runId: string,
): Promise<void> {
  if (!uuid.test(runId)) throw new Error('Invalid diagnostic report identity');
  const key = historyKey(serverId);
  const write = historyWrite
    .catch(() => undefined)
    .then(async () => {
      const reports = await loadConnectionDiagnosticReports(serverId);
      const retained = reports.filter((report) => report.runId !== runId);
      if (retained.length === reports.length) return;
      await AsyncStorage.setItem(key, JSON.stringify(retained));
    });
  historyWrite = write;
  await write;
}
