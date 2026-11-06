import type { SessionSummary } from '../api.js';
import { markerAttention, type AttentionKind } from './attention.js';

/**
 * The leading tile of a session row in the project's Work list, derived only from
 * facts the summary already carries — there is no "kind" of session to read, so a
 * session without a pull request or automation gets the neutral tile rather than
 * a guessed category.
 *
 * The tile answers "where is this work": its glyph is the phase (a pull request,
 * merged, an automation, or a plain session) and its bottom mark is the verdict on
 * an open pull request (checks running, passed, failed, conflict). The agent's
 * own state — working, a new answer, waiting for the operator — is the separate
 * top mark ({@link sessionAgentMark}), so the two questions never share a corner.
 */
export type SessionTileGlyph = 'pull_request' | 'merged' | 'automation' | 'session';

/** The tile's color role: `quiet` is the neutral tile with a muted glyph. */
export type SessionTileTone = 'progress' | 'ready' | 'problem' | 'quiet';

/** The verdict mark on an open pull request. */
export type SessionTileResult = 'running' | 'passed' | 'failed' | 'conflict' | 'checking';

export interface SessionTile {
  glyph: SessionTileGlyph;
  tone: SessionTileTone;
  result?: SessionTileResult;
  /** What the tile says, for the row's accessibility label. */
  label: string;
}

type TileInput = Pick<SessionSummary, 'status' | 'pr' | 'pullRequest' | 'attention' | 'automation'>;

// Exhaustive over the PR kinds `markerAttention` can put first, so a new PR signal
// has to be given a tile here instead of silently falling back to a bare PR glyph.
// `pr_unknown` carries no mark: the tile cannot say anything true about it.
const PR_TILES: Record<
  Exclude<AttentionKind, 'question' | 'crashed' | 'sandbox_disconnected' | 'unread'>,
  { tone: SessionTileTone; result?: SessionTileResult }
> = {
  merge_conflict: { tone: 'problem', result: 'conflict' },
  ci_failed: { tone: 'problem', result: 'failed' },
  merge_blocked: { tone: 'problem', result: 'conflict' },
  merge_ready: { tone: 'ready', result: 'passed' },
  merge_checking: { tone: 'quiet', result: 'checking' },
  ci_running: { tone: 'progress', result: 'running' },
  pr_unknown: { tone: 'quiet' },
};

/** The leading tile for a session row. */
export function sessionTile(session: TileInput): SessionTile {
  const phase = session.pullRequest?.phase ?? session.pr?.phase;
  if (phase === 'merged') return { glyph: 'merged', tone: 'quiet', label: 'Pull request merged' };
  if (phase === 'closed')
    return { glyph: 'pull_request', tone: 'quiet', label: 'Pull request closed' };
  if (phase === 'open') {
    const flag = markerAttention({
      status: session.status,
      pr: session.pr,
      attention: session.attention,
    }).find((candidate) => candidate.kind !== 'unread');
    const tile = flag ? PR_TILES[flag.kind as keyof typeof PR_TILES] : undefined;
    if (flag && tile) return { glyph: 'pull_request', ...tile, label: flag.label };
    return { glyph: 'pull_request', tone: 'quiet', label: 'Pull request open' };
  }
  if (session.automation)
    return {
      glyph: 'automation',
      tone: 'quiet',
      label: session.automation.status === 'paused' ? 'Automation paused' : 'Automation',
    };
  return { glyph: 'session', tone: 'quiet', label: 'Session' };
}

/** The agent's state as the tile's top mark; none while it is idle and read. */
export type SessionAgentMark = 'question' | 'working' | 'unread';

export function sessionAgentMark(input: {
  status: SessionSummary['status'];
  working: boolean;
  unread: boolean;
}): SessionAgentMark | undefined {
  // Waiting on the operator outranks everything: it is the one state that stops
  // the session until someone answers.
  if (input.status === 'awaiting_input') return 'question';
  if (input.working) return 'working';
  if (input.unread) return 'unread';
  return undefined;
}
