import type { ProjectQASummary } from '../project-qa-api.js';

/** The six states of a project's QA row (docs/ci-supervision.md). */
export type QARowState = 'needsYou' | 'working' | 'clear' | 'access' | 'paused' | 'off';
export type QASourceIntent = 'ready' | 'needsSetup' | 'optional' | 'unknown';

export interface QARowView {
  state: QARowState;
  subtitle: string;
  /** PRs and CI as read at the last check; empty when QA makes no claim. */
  sources: { label: string; intent: QASourceIntent }[];
  /** "Checked 08:12", only after a fresh, complete check. */
  checked: string | null;
}

/** A check older than this cannot vouch for a green row (sweeps run every 2 min). */
export const QA_FRESH_MS = 10 * 60_000;
const UNREADABLE = new Set(['unavailable', 'access-revoked', 'pending']);

function clock(iso: string): string {
  const date = new Date(iso);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function plural(n: number, one: string, many: string): string {
  return `${String(n)} ${n === 1 ? one : many}`;
}

/**
 * What the QA row says. Green only after a fresh and complete check of every
 * source; an unreadable or stale source shows "Check access" instead, and a
 * paused or switched-off QA states nothing about the project.
 */
export function qaRowView(summary: ProjectQASummary, now = Date.now()): QARowView {
  if (summary.mode === 'off')
    return { state: 'off', subtitle: 'Switched off for this project', sources: [], checked: null };
  if (summary.mode === 'paused')
    return { state: 'paused', subtitle: 'Paused · not watching', sources: [], checked: null };
  const fresh = summary.checkedAt !== null && now - Date.parse(summary.checkedAt) < QA_FRESH_MS;
  const prsReadable = fresh && !UNREADABLE.has(summary.health);
  const ciReadable = prsReadable && summary.health !== 'workflow-monitoring-unsupported';
  const source = (name: string, readable: boolean, failing: number) =>
    !readable
      ? { label: `${name} unreadable`, intent: 'unknown' as const }
      : failing > 0
        ? { label: `${name} ${String(failing)}`, intent: 'needsSetup' as const }
        : { label: `${name} ok`, intent: 'ready' as const };
  const sources = [
    source('PRs', prsReadable, summary.failingPullRequests),
    source('CI', ciReadable, summary.failingWorkflows),
  ];
  const counts = [
    summary.open ? `${String(summary.open)} open` : null,
    summary.repairing ? plural(summary.repairing, 'repair running', 'repairs running') : null,
  ].filter(Boolean);
  const subtitle = counts.length ? counts.join(' · ') : 'Nothing open';
  if (summary.needsYou > 0)
    return {
      state: 'needsYou',
      subtitle,
      sources,
      checked: fresh ? `Checked ${clock(summary.checkedAt!)}` : null,
    };
  if (!prsReadable || !ciReadable)
    return {
      state: 'access',
      subtitle: !fresh
        ? summary.checkedAt
          ? `Not checked since ${clock(summary.checkedAt)}`
          : 'Not checked yet'
        : !prsReadable
          ? "Can't read pull requests"
          : "Can't read Actions",
      sources,
      checked: null,
    };
  return {
    state: summary.repairing > 0 || summary.open > 0 ? 'working' : 'clear',
    subtitle,
    sources,
    checked: `Checked ${clock(summary.checkedAt!)}`,
  };
}

/** "PR #88", "Workflow ci": an issue's resource as people read it. */
export function qaIssueLabel(key: string): string {
  if (key.startsWith('pr:')) return `PR #${key.slice(3)}`;
  if (key.startsWith('workflow:')) return `Workflow ${key.slice(9)}`;
  return key;
}

const REASONS: Record<string, string> = {
  'rounds-exhausted': 'Repair stopped after the allowed rounds.',
  'beyond-mandate': 'This needs more than a repair within the mandate.',
  'emergency-brake': 'QA stopped all repairs.',
};

/** Why QA stopped, for the issue and the Home item. */
export function qaStopReason(reason: string | null): string {
  return (reason && REASONS[reason]) ?? 'QA needs your decision.';
}
