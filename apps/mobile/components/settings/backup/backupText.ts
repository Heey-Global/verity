// What the backup screens say about the server's backup status. Kept apart from
// the screens so the Settings row, the status page and the restore test agree on
// every word, and so the wording can be tested without rendering.
import type { BackupProbeJob, BackupStatus } from '@verity/mobile';

import type { StatusIntent } from '../../ui/Status';

type Available = Extract<BackupStatus, { available: true }>;

/** "Today 14:00", "Yesterday 08:00", "Tomorrow 02:00" or "21 Oct, 14:00" in the
 *  device's locale. Days are calendar days, so a DST change does not shift them. */
export function formatBackupTime(
  timestamp: number,
  now: number = Date.now(),
  { inline = false }: { inline?: boolean } = {},
): string {
  const date = new Date(timestamp);
  const time = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const day = (offset: number): number => {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() + offset);
    return start.getTime();
  };
  // Inside a sentence ("Last backup today 14:00") only the relative word is lowered.
  const relative = (word: string): string => `${inline ? word.toLowerCase() : word} ${time}`;
  if (timestamp >= day(1) && timestamp < day(2)) return relative('Tomorrow');
  if (timestamp >= day(0) && timestamp < day(1)) return relative('Today');
  if (timestamp >= day(-1) && timestamp < day(0)) return relative('Yesterday');
  const label = date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  return `${label}, ${time}`;
}

/** "Every 6 h" for a row value; "every 6 hours" inside a sentence. */
export function formatInterval(intervalMs: number, style: 'short' | 'long' = 'short'): string {
  const hours = Math.round(intervalMs / 3600000);
  if (style === 'short') return hours === 24 ? 'Once a day' : `Every ${String(hours)} h`;
  if (hours === 24) return 'once a day';
  return hours === 1 ? 'every hour' : `every ${String(hours)} hours`;
}

/** The fixed choices of the interval sheet, inside the server's 1–24 h range. */
export const INTERVAL_CHOICES = [1, 3, 6, 12, 24].map((hours) => hours * 3600000);
export const DEFAULT_INTERVAL_MS = 6 * 3600000;

/** After a confirmation whose outcome this device cannot prove (a lost reply, a
 *  retry, another administrator's device): the restore test settles it. */
export const KEY_OUTCOME_UNKNOWN =
  'Backup is on, but this device could not confirm which key it uses. Run a restore test with the key you saved.';

/** A short title and one sentence per server alert code (docs/BACKUP_API.md). */
export function backupAlertText(code: string): { title: string; message: string } {
  switch (code) {
    case 'stale-backup':
      return {
        title: 'No recent backup',
        message: 'The last backups did not finish. Check the server’s disk and backup folder.',
      };
    case 'consecutive-failures':
      return {
        title: 'Backups keep failing',
        message: 'Check the free disk space and the backup folder on the server.',
      };
    case 'destination-unavailable':
      return {
        title: 'Backup folder not found',
        message: 'The backup folder on the server is missing or not mounted.',
      };
    case 'destination-unwritable':
      return {
        title: 'Backup folder is read-only',
        message: 'Check the permissions of the backup folder on the server.',
      };
    case 'insufficient-space':
      return {
        title: 'Not enough space',
        message: 'The next backup may not fit. Free disk space on the server.',
      };
    case 'identity-unreadable':
      return {
        title: 'Server identity unreadable',
        message: 'Run the Verity installer on the server again to repair it.',
      };
    case 'probe-overdue':
      return {
        title: 'Not tested recently',
        message: 'Run a restore test to check your backup and recovery key.',
      };
    case 'maintenance-failed':
      return {
        title: 'Old backups not cleaned up',
        message: 'Cleaning up old backups failed. Check the server logs.',
      };
    default:
      return { title: 'Backup needs attention', message: 'Check the server logs.' };
  }
}

/** The Settings row: one line under the title and a status tag. */
export function backupRowSummary(
  status: Available,
  now: number = Date.now(),
): { subtitle: string; status: { intent: StatusIntent; label: string } } {
  if (!status.configured)
    return { subtitle: 'Not set up', status: { intent: 'needsSetup', label: 'Set up' } };
  const subtitle =
    status.lastSuccess != null
      ? `Last backup ${formatBackupTime(status.lastSuccess, now, { inline: true })}`
      : status.capturing === true
        ? 'First backup running'
        : 'First backup starts shortly';
  if (status.alerts.length > 0)
    return { subtitle, status: { intent: 'needsSetup', label: 'Needs attention' } };
  if (status.paused === true) return { subtitle, status: { intent: 'optional', label: 'Paused' } };
  return { subtitle, status: { intent: 'ready', label: 'On' } };
}

/** The three status rows of the backup page. */
export function backupStatusRows(
  status: Available,
  now: number = Date.now(),
): { title: string; value: string; intent: StatusIntent }[] {
  const interval = status.intervalMs ?? DEFAULT_INTERVAL_MS;
  const last: { value: string; intent: StatusIntent } =
    status.lastSuccess != null
      ? {
          value: formatBackupTime(status.lastSuccess, now),
          intent: status.alerts.includes('stale-backup') ? 'needsSetup' : 'ready',
        }
      : status.capturing === true
        ? { value: 'Running', intent: 'transient' }
        : { value: 'Not yet', intent: 'unknown' };
  const next =
    status.paused === true
      ? 'Paused'
      : status.capturing === true
        ? 'Running now'
        : status.lastSuccess == null || status.lastSuccess + interval <= now
          ? 'Shortly'
          : `About ${formatBackupTime(status.lastSuccess + interval, now, { inline: true })}`;
  const test: { value: string; intent: StatusIntent } = probeRunning(status.probe)
    ? { value: 'Running', intent: 'transient' }
    : status.lastProbe != null
      ? { value: formatBackupTime(status.lastProbe.finishedAt, now), intent: 'ready' }
      : { value: 'Not tested', intent: 'unknown' };
  return [
    { title: 'Last backup', ...last },
    { title: 'Next backup', value: next, intent: 'unknown' },
    { title: 'Restore test', ...test },
  ];
}

const PROBE_PHASES: Record<string, string> = {
  selecting: 'Finding the newest backup',
  release: 'Checking the server version',
  staging: 'Unpacking the backup',
  identity: 'Checking the server identity',
  git: 'Checking projects',
  database: 'Checking the database',
  revocations: 'Checking removed devices',
  cleanup: 'Cleaning up',
};

/** "Checking the database" and "Step 6 of 8" for a running restore test. */
export function probePhaseText(phase: string): { title: string; step: string } {
  const phases = Object.keys(PROBE_PHASES);
  const index = phases.indexOf(phase);
  if (index < 0) return { title: 'Checking the backup', step: 'In progress' };
  return {
    title: PROBE_PHASES[phase]!,
    step: `Step ${String(index + 1)} of ${String(phases.length)}`,
  };
}

/** Why a finished restore test did not pass. */
export function probeFailureText(job: BackupProbeJob): { title: string; message: string } {
  if (job.status === 'cancelled') return { title: 'Test cancelled', message: 'Nothing changed.' };
  switch (job.error) {
    case 'timed-out':
      return { title: 'Test took too long', message: 'Try again when the server is less busy.' };
    case 'interrupted':
      return {
        title: 'Test interrupted',
        message: 'The server restarted during the test. Try again.',
      };
    case 'cleanup-failed':
      return {
        title: 'Test could not clean up',
        message: 'The check ran, but temporary files were left on the server.',
      };
    default:
      return {
        title: 'Test failed',
        message: 'The recovery key may be wrong, or the backup cannot be read.',
      };
  }
}

export function probeRunning(job: BackupProbeJob | null | undefined): boolean {
  return job?.status === 'running' || job?.status === 'cancelling';
}
