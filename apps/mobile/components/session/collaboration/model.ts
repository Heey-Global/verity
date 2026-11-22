import type {
  CollaborationDirection,
  CollaborationEntry,
  CollaborationState,
} from '@verity/mobile';

import type { IconName } from '../../Icon';

/** What the person looks for first: their decision, then news, then motion. */
const PRIORITY: Record<CollaborationState, number> = {
  waitingForYou: 0,
  answer: 1,
  working: 2,
  done: 3,
};

export const STATE_LABEL: Record<CollaborationState, string> = {
  waitingForYou: 'Approval',
  working: 'Working',
  answer: 'Answer',
  done: 'Done',
};

export const DIRECTION: Record<CollaborationDirection, { icon: IconName; label: string }> = {
  asked: { icon: 'arrow-up-right', label: 'we asked' },
  askedBy: { icon: 'arrow-down-left', label: 'asked us' },
  handedOver: { icon: 'arrow-right', label: 'handed over' },
};

export function peerTitle(entry: CollaborationEntry): string {
  return entry.sessionName?.trim() || 'Session';
}

/** "now", "4 min", "3 h", "2 d": short enough to keep a sheet row on one line. */
export function shortAge(updatedAt: string, now: number): string {
  const minutes = Math.floor(Math.max(0, now - Date.parse(updatedAt)) / 60_000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${String(minutes)} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${String(hours)} h`;
  return `${String(Math.floor(hours / 24))} d`;
}

/** Entries for the header row, the most pressing first. */
export function rowEntries(entries: readonly CollaborationEntry[]): CollaborationEntry[] {
  return entries
    .filter((entry) => entry.section === 'current')
    .sort((left, right) => PRIORITY[left.state] - PRIORITY[right.state]);
}

/** One peer: the line says what that session is doing for or with this one. */
function singleLine(entry: CollaborationEntry): { summary: string; detail?: string } {
  const peer = `${entry.projectName} · ${peerTitle(entry)}`;
  if (entry.direction === 'askedBy') {
    const detail =
      entry.state === 'waitingForYou'
        ? 'needs your approval'
        : entry.state === 'working'
          ? 'waiting for this answer'
          : 'answered';
    return { summary: `Asked by ${peer}`, detail };
  }
  const handover = entry.direction === 'handedOver';
  if (entry.state === 'waitingForYou')
    return {
      summary: `${handover ? 'Handover' : 'Question'} to ${entry.projectName} needs approval`,
    };
  const detail =
    entry.state === 'working'
      ? handover
        ? 'working on the handover'
        : 'working on your question'
      : entry.state === 'answer'
        ? 'answer ready'
        : 'done';
  return { summary: peer, detail };
}

/** Several peers: the most pressing one leads, the rest are counted by state. */
function severalLine(entries: readonly CollaborationEntry[]): {
  summary: string;
  detail?: string;
} {
  const [lead, ...rest] = entries;
  const project = lead!.projectName;
  const summary =
    lead!.state === 'waitingForYou'
      ? `${project} needs your approval`
      : lead!.state === 'answer'
        ? `Answer from ${project}`
        : lead!.state === 'working'
          ? `${project} is working`
          : `${project} is done`;
  const counts = new Map<CollaborationState, number>();
  for (const entry of rest) counts.set(entry.state, (counts.get(entry.state) ?? 0) + 1);
  const detail = (['waitingForYou', 'answer', 'working', 'done'] as const)
    .filter((state) => counts.has(state))
    .map((state) => {
      const count = counts.get(state)!;
      const word =
        state === 'waitingForYou'
          ? 'need approval'
          : state === 'answer'
            ? count === 1
              ? 'answer'
              : 'answers'
            : state;
      return `${String(count)} ${word}`;
    })
    .join(' · ');
  return detail === '' ? { summary } : { summary, detail };
}

export function rowText(entries: readonly CollaborationEntry[]): {
  summary: string;
  detail?: string;
} {
  return entries.length === 1 ? singleLine(entries[0]!) : severalLine(entries);
}
