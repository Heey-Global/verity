// Words for the Audit logs screens (ADR 0028, "Presentation"). Every string here
// answers one question for the administrator: what happened, who started it, or
// how it ended. Implementation terms (stream, chain, sequence, devcontainer) stay
// out; the app already calls the built image a "project image".
import type { AuditInitiator, AuditOperationSummary } from '@verity/mobile';

import type { StatusIntent } from '../components/ui/Status';

const SYSTEM_TRIGGERS: Record<string, string> = {
  sandbox_wake: 'Sandbox wake',
  sandbox_reconcile: 'Sandbox update',
  welcome_project: 'Welcome project',
  image_cleanup: 'Automatic cleanup',
};

export function auditInitiatorLabel(initiator: AuditInitiator): string {
  switch (initiator.kind) {
    case 'user':
      return initiator.isRequester ? 'You' : 'Another administrator';
    case 'session':
      return initiator.name !== null ? `Session “${initiator.name}”` : 'Agent session';
    case 'system':
      return SYSTEM_TRIGGERS[initiator.trigger] ?? 'Verity';
    default:
      return 'Unknown';
  }
}

/** Past tense for a completed normal outcome; the noun when a status word follows. */
export function auditTitle(operation: AuditOperationSummary): string {
  switch (operation.kind) {
    case 'build':
      return operation.status === 'succeeded' ? 'Project image built' : 'Project image build';
    case 'image_removed':
      return 'Project image removed';
    case 'project_deleted':
      return 'Project deleted';
    case 'write_gap': {
      const count = operation.failedWrites ?? 0;
      return `${count} ${count === 1 ? 'event' : 'events'} not recorded`;
    }
  }
}

/** Only deviations carry a word; a completed normal outcome shows none. */
export function auditStatus(
  operation: AuditOperationSummary,
): { intent: StatusIntent; label: string } | undefined {
  switch (operation.status) {
    case 'running':
      return { intent: 'transient', label: 'Running' };
    case 'failed':
      return { intent: 'needsSetup', label: 'Failed' };
    case 'unknown':
      return { intent: 'unknown', label: 'Unknown' };
    default:
      return undefined;
  }
}

export function auditTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/** A log record's local time to the second, so neighbouring records stay distinguishable. */
export function logTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function auditDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

function dayKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

/** Operations grouped by local day, newest first, labelled Today / Yesterday / date. */
export function groupAuditByDay(
  operations: readonly AuditOperationSummary[],
  now: Date = new Date(),
): { title: string; operations: AuditOperationSummary[] }[] {
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const groups: { key: string; title: string; operations: AuditOperationSummary[] }[] = [];
  for (const operation of operations) {
    const date = new Date(operation.startedAt);
    const key = dayKey(date);
    let group = groups.at(-1);
    if (group?.key !== key) {
      group = {
        key,
        title:
          key === dayKey(now)
            ? 'Today'
            : key === dayKey(yesterday)
              ? 'Yesterday'
              : auditDate(operation.startedAt),
        operations: [],
      };
      groups.push(group);
    }
    group.operations.push(operation);
  }
  return groups.map(({ title, operations: list }) => ({ title, operations: list }));
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}

/** `sha256:3f9a…c21` — enough to recognise and search, short enough for a row. */
export function shortDigest(digest: string): string {
  const [algorithm, hex] = digest.includes(':') ? digest.split(':', 2) : ['', digest];
  const body = hex ?? '';
  const short = body.length > 12 ? `${body.slice(0, 4)}…${body.slice(-3)}` : body;
  return algorithm ? `${algorithm}:${short}` : short;
}
