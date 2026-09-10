import type { SessionStatus } from '../api.js';

/**
 * Presentation adapters the RN UI consumes. Pure TS (no React Native / theme):
 * map the data layer's values to SEMANTIC tokens; the rendered component
 * resolves a `tone` to a concrete theme color and drives the pulsing dot. This
 * keeps the mapping unit-testable in the server container while theming stays in
 * the Expo app (a Verity-native replacement for Happy's presence-derived
 * `STATUS_CONFIG`, which keys off real-time fields our `SessionSummary` lacks).
 */

/** Semantic badge tone — the RN layer maps each to a theme color + dot. */
export type BadgeTone = 'idle' | 'active' | 'attention' | 'done' | 'danger';

export interface SessionBadge {
  /** Short human label for the status pill. */
  label: string;
  tone: BadgeTone;
  /** Whether the status dot should pulse (the agent is actively working/waiting). */
  pulsing: boolean;
}

// Exhaustive over SessionStatus: if the server's status union grows, this stops
// compiling until the new state is given a badge (no silent missing badge).
const BADGES: Record<SessionStatus, SessionBadge> = {
  idle: { label: 'Idle', tone: 'idle', pulsing: false },
  running: { label: 'Running', tone: 'active', pulsing: true },
  awaiting_input: { label: 'Needs input', tone: 'attention', pulsing: true },
  awaiting_dependency: { label: 'Waiting', tone: 'active', pulsing: false },
  completed: { label: 'Done', tone: 'done', pulsing: false },
  crashed: { label: 'Crashed', tone: 'danger', pulsing: false },
};

/** Map a session status to its badge descriptor for the session-list UI. */
export function sessionBadge(status: SessionStatus): SessionBadge {
  return BADGES[status];
}

/** Statuses that should surface in the attention queue (operator action / failure). */
export function needsAttention(status: SessionStatus): boolean {
  return status === 'awaiting_input' || status === 'crashed';
}

// Statuses whose text label is redundant on the session list: `running` is shown by
// the pulsing working dot, and `completed`/`idle` are implicit from its absence. The
// rest (`awaiting_input`/`crashed`/`awaiting_dependency`) carry operator-relevant
// meaning a bare row can't, so they keep their pill.
const UNLABELLED_STATUSES: ReadonlySet<SessionStatus> = new Set(['running', 'completed', 'idle']);

/** Whether a session should show its status label pill in the list (single source of
 * truth so the overview and project-detail rows can't drift). */
export function showsSessionLabel(status: SessionStatus): boolean {
  return !UNLABELLED_STATUSES.has(status);
}
