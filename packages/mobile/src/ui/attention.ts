import type { AttentionSignal, SessionPr, SessionStatus, SessionSummary } from '../api.js';
import type { BadgeTone } from './sessionBadge.js';

/**
 * The session-list attention model (#37/#387, Verity-original — Happy has no such
 * queue). The lifecycle badge ({@link sessionBadge}) answers "what is the agent
 * doing"; this answers the ORTHOGONAL question "what does this session want from
 * ME". A session can carry several attention signals at once (e.g. `idle` but
 * merge-ready AND unread), so this is a set of prioritized flags rather than a
 * single status. Pure logic, unit-testable here; the RN list renders the flags as
 * subtle markers and uses {@link attentionQueue} to surface the blocking ones.
 */

/** A distinct thing a session wants from the operator. Ordered by priority below. */
export type AttentionKind =
  | 'question'
  | 'crashed'
  | 'sandbox_disconnected'
  | 'merge_conflict'
  | 'ci_failed'
  | 'merge_blocked'
  | 'merge_ready'
  | 'ci_running'
  | 'unread';

export interface AttentionFlag {
  kind: AttentionKind;
  /** Semantic tone the RN layer maps to a theme color + marker. */
  tone: BadgeTone;
  /** Short human label for the marker's a11y / tooltip. */
  label: string;
  /** Blocking flags (something is wrong or waiting on a decision) reorder the
   * session to the top of the list; positive/ambient ones (merge-ready, unread)
   * render as a marker only, so they stay subtle and don't churn the ordering. */
  blocking: boolean;
}

// Declaration order = priority (earlier wins as the session's PRIMARY flag). Kept
// exhaustive over AttentionKind so a new signal must be given a descriptor here.
const FLAGS: Record<AttentionKind, Omit<AttentionFlag, 'kind'>> = {
  question: { tone: 'attention', label: 'Needs input', blocking: true },
  crashed: { tone: 'danger', label: 'Crashed', blocking: true },
  sandbox_disconnected: { tone: 'danger', label: 'Sandbox disconnected', blocking: true },
  merge_conflict: { tone: 'danger', label: 'Merge conflicts', blocking: true },
  ci_failed: { tone: 'danger', label: 'CI failed', blocking: true },
  merge_blocked: { tone: 'danger', label: 'Merge blocked', blocking: true },
  merge_ready: { tone: 'done', label: 'Ready to merge', blocking: false },
  ci_running: { tone: 'attention', label: 'CI running', blocking: false },
  unread: { tone: 'active', label: 'New messages', blocking: false },
};
const ORDER: readonly AttentionKind[] = [
  'question',
  'crashed',
  // Above every PR signal: a session whose sandbox is cut off cannot sign, push,
  // or reach a secret, so any CI/merge verdict below is about work it currently
  // has no way to advance. Below `crashed`, which is the same session already
  // stopped rather than still trying.
  'sandbox_disconnected',
  // Above `ci_failed`: a conflict is the ROOT cause when both could apply — GitHub
  // refuses to build the merge ref, so CI can't tell the operator anything useful
  // until the conflict is gone.
  'merge_conflict',
  'ci_failed',
  'merge_blocked',
  'merge_ready',
  'ci_running',
  'unread',
];

/** The inputs an attention verdict draws on: the derived status + the (optional) PR
 * projection from the summary, plus the client-local `unread` bit (new events since
 * the operator last opened the session — the server can't know this per device). */
export interface AttentionInput {
  status: SessionStatus;
  // `| undefined` is explicit (exactOptionalPropertyTypes): a summary's `pr` may be
  // absent, and callers forward it straight through.
  pr?: SessionPr | null | undefined;
  unread?: boolean | undefined;
  /** Conditions the SERVER reported about this session (`attention` on the
   * summary). Absent from a healthy session and from any older server. */
  attention?: readonly AttentionSignal[] | undefined;
}

/** All attention flags a session carries, in priority order (highest first). */
export function sessionAttention(input: AttentionInput): AttentionFlag[] {
  const kinds = new Set<AttentionKind>();
  // Lifecycle signals that need operator action (mirrors the badge's `attention`/
  // `danger` tones, but as actionable flags rather than a display status).
  if (input.status === 'awaiting_input') kinds.add('question');
  if (input.status === 'crashed') kinds.add('crashed');
  // Server-reported, not derived here: the Server is the only side that can see a
  // sandbox has lost its connection. Keyed on the CODE (the message is free text
  // meant for display), and an unknown code is deliberately ignored — a newer
  // server's condition renders through the notice line instead, without inventing
  // a marker this build has no descriptor for.
  if (input.attention?.some((signal) => signal.code === 'sandbox_disconnected') === true)
    kinds.add('sandbox_disconnected');
  // PR signals, only meaningful while the PR is still open. `mergeable` is tri-state:
  // `false` is a genuine operator-blocking conflict; `null` means "unknown" — either
  // checks aren't green yet or GitHub is still computing mergeability in the seconds
  // after a push, which must NOT read as blocked (that flashed a just-fixed, now-green
  // PR red and yanked it to the top of the list).
  const pr = input.pr;
  if (pr && pr.phase === 'open') {
    // A conflict (`mergeable_state: 'dirty'`) is reported independently of the
    // pipeline — and usually WITHOUT one, because GitHub starts no `pull_request`
    // checks for a PR it can't merge-ref. So flag it before the pipeline branches
    // below, which would otherwise leave such a session with no marker at all.
    if (pr.mergeState === 'dirty') kinds.add('merge_conflict');
    if (pr.pipeline === 'failure') kinds.add('ci_failed');
    else if (pr.pipeline === 'pending' || pr.pipeline === 'running') kinds.add('ci_running');
    else if (pr.pipeline === 'success') {
      if (pr.mergeable === true) kinds.add('merge_ready');
      // A confirmed conflict already says this, more precisely — don't mark twice.
      else if (pr.mergeable === false && !kinds.has('merge_conflict')) kinds.add('merge_blocked');
      // mergeable === null: mergeability still being computed — no flag yet; the next
      // poll resolves it to merge_ready (green) or merge_blocked (a real conflict).
    }
  }
  if (input.unread) kinds.add('unread');
  return ORDER.filter((kind) => kinds.has(kind)).map((kind) => ({ kind, ...FLAGS[kind] }));
}

/**
 * The flags to render as subtle row markers: everything EXCEPT the ones the row
 * already says in words — the lifecycle flags the status badge/pill conveys
 * (`question` → "Needs input", `crashed` → "Crashed") and `sandbox_disconnected`, whose
 * whole point is the sentence the server wrote, rendered on the row's own line.
 *
 * The exclusions are also what keeps this list to kinds the marker component can
 * actually draw. Only the first marker is rendered, so an undrawable kind at the
 * front does not merely go missing: it takes the row's real marker with it.
 *
 * The single source of truth for "which flags are extra", so the overview and
 * project-detail rows don't each hardcode the exclusion.
 */
export function markerAttention(input: AttentionInput): AttentionFlag[] {
  return sessionAttention(input).filter(
    (f) => f.kind !== 'question' && f.kind !== 'crashed' && f.kind !== 'sandbox_disconnected',
  );
}

/** Whether a session has any BLOCKING flag (needs a decision / something's wrong) —
 * derivable from the summary alone, so the queue needs no client-local `unread`. */
function isBlocking(session: SessionSummary): boolean {
  return sessionAttention({
    status: session.status,
    pr: session.pr,
    attention: session.attention,
  }).some((f) => f.blocking);
}

/**
 * Order the session list attention-first: sessions with a blocking flag
 * (`question` / `crashed` / `ci_failed` / `merge_blocked`) are surfaced first, preserving the
 * server's order within each group. Merge-ready and unread are deliberately NOT
 * reordered — they mark in place so the list stays stable.
 */
export function attentionQueue(sessions: readonly SessionSummary[]): SessionSummary[] {
  const attention: SessionSummary[] = [];
  const rest: SessionSummary[] = [];
  for (const session of sessions) {
    (isBlocking(session) ? attention : rest).push(session);
  }
  return [...attention, ...rest];
}

/** How many sessions currently have a blocking flag (for a badge/count). */
export function attentionCount(sessions: readonly SessionSummary[]): number {
  return sessions.reduce((n, session) => n + (isBlocking(session) ? 1 : 0), 0);
}
