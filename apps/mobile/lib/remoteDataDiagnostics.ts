import { requireNativeModule } from 'expo-modules-core';

const events = new Set([
  'capture_started',
  'socket_resume',
  'socket_open',
  'attached',
  'failure',
  'cancel_requested',
  'socket_cancel',
  'socket_close',
  'task_completed',
  'network_path',
  'counters',
  'probe_started',
  'probe_succeeded',
  'probe_failed',
  'app_active',
  'app_background',
  'app_inactive',
]);
const causes = new Set([
  'app_stop',
  'replacement',
  'attachment_deadline',
  'attachment_failure',
  'read_failure',
  'heartbeat_deadline',
  'heartbeat_failure',
  'stream_exhausted',
  'stream_stall',
  'probe_failure',
  'profile_changed',
]);
const domains = new Set([
  'NSURLErrorDomain',
  'kCFErrorDomainCFNetwork',
  'NSOSStatusErrorDomain',
  'NSPOSIXErrorDomain',
  'NSCocoaErrorDomain',
  'kCFErrorDomainSSL',
  'OtherErrorDomain',
]);
const paths = new Set(['satisfied', 'unsatisfied', 'requiresConnection', 'unknown']);
const eventKeys = new Set([
  'sequence',
  'utc',
  'elapsedMs',
  'event',
  'cause',
  'errorDomain',
  'errorCode',
  'closeCode',
  'path',
  'sentBytes',
  'receivedBytes',
  'deliveredBytes',
]);
const snapshotKeys = new Set([
  'version',
  'channel',
  'generation',
  'sessionHash',
  'clockOffsetKnown',
  'startedLate',
  'delegateAvailable',
  'expired',
  'dropped',
  'events',
]);

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}

/** Reject unknown fields instead of copying untrusted native diagnostics into an export. */
export function acceptedDataDiagnostics(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 65_536) return null;
  let snapshot: unknown;
  try {
    snapshot = JSON.parse(value);
  } catch {
    return null;
  }
  if (!record(snapshot) || Object.keys(snapshot).some((key) => !snapshotKeys.has(key))) return null;
  if (
    snapshot.version !== 1 ||
    snapshot.channel !== 'DATA' ||
    typeof snapshot.generation !== 'string' ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(snapshot.generation) ||
    (snapshot.sessionHash !== undefined &&
      snapshot.sessionHash !== null &&
      (typeof snapshot.sessionHash !== 'string' ||
        !/^[a-f0-9]{16}$/u.test(snapshot.sessionHash))) ||
    snapshot.clockOffsetKnown !== false ||
    typeof snapshot.startedLate !== 'boolean' ||
    typeof snapshot.delegateAvailable !== 'boolean' ||
    typeof snapshot.expired !== 'boolean' ||
    !integer(snapshot.dropped) ||
    !Array.isArray(snapshot.events) ||
    snapshot.events.length > 128
  )
    return null;
  let sequence = 0;
  let elapsed = 0;
  for (const entry of snapshot.events) {
    if (!record(entry) || Object.keys(entry).some((key) => !eventKeys.has(key))) return null;
    if (
      !integer(entry.sequence, sequence + 1) ||
      !integer(entry.elapsedMs, elapsed, 120_000) ||
      typeof entry.utc !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(entry.utc) ||
      !Number.isFinite(Date.parse(entry.utc)) ||
      typeof entry.event !== 'string' ||
      !events.has(entry.event)
    )
      return null;
    for (const [key, allowed] of [
      ['cause', causes],
      ['errorDomain', domains],
      ['path', paths],
    ] as const) {
      if (entry[key] !== undefined && (typeof entry[key] !== 'string' || !allowed.has(entry[key])))
        return null;
    }
    for (const key of ['errorCode', 'closeCode', 'sentBytes', 'receivedBytes', 'deliveredBytes']) {
      if (
        entry[key] !== undefined &&
        !integer(entry[key], key === 'errorCode' ? Number.MIN_SAFE_INTEGER : 0)
      )
        return null;
    }
    if ((entry.errorDomain === undefined) !== (entry.errorCode === undefined)) return null;
    sequence = entry.sequence as number;
    elapsed = entry.elapsedMs as number;
  }
  return JSON.stringify(snapshot);
}

/** Safe local export; unavailable builds never fall back to unrestricted logs. */
export async function exportRemoteDataDiagnostics(): Promise<string | null> {
  try {
    const native = requireNativeModule<{ exportDataDiagnostics?: () => Promise<unknown> }>(
      'VerityRemoteControlTunnel',
    );
    if (typeof native.exportDataDiagnostics !== 'function') return null;
    const raw = await native.exportDataDiagnostics();
    if (!Array.isArray(raw) || raw.length === 0 || raw.length > 3) return null;
    const snapshots = raw.map(acceptedDataDiagnostics);
    if (snapshots.some((snapshot) => snapshot === null)) return null;
    return `[${snapshots.join(',')}]`;
  } catch {
    return null;
  }
}
