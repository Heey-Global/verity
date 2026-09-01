/**
 * Resolving a saved scroll anchor back to a row index.
 *
 * Extracted from app/session/[id].tsx so the seq-span logic below can be tested: it
 * depends on the ORDER of the row array, and the transcript list now feeds FlashList
 * newest-first (see the inversion documented in lib/scrollPosition.ts) while a
 * delegated agent's `childRows` stay chronological. Both orders flow through the same
 * matcher, so the direction is an explicit argument rather than an assumption.
 */
import { rowKey, type Row } from '@verity/mobile';

export interface ScrollAnchor {
  // The rowKey (message/group id) of the bottom-most visible row when we last left,
  // or null when nothing had scrolled into view yet.
  rowKey: string | null;
  // Stable message id inside that row. Group row keys can intentionally change while
  // a live tool/todo run grows, so restore resolves by this id first when available.
  messageId: string | null;
  // Whether the operator was pinned at (near) the bottom when we left. This gates the
  // restore: if they were at the bottom we NEVER page older history to find the row —
  // a live tool/todo group's rowKey is `tools:<lastMemberId>` (transcriptRows.ts) and
  // MUTATES as the run grows, so an anchor saved while watching an active session would
  // no longer match any row on reopen and would otherwise trigger a futile 20-page
  // paging storm. At-bottom + row-not-found simply stays at the bottom instead.
  atBottom: boolean;
  // How far into the anchor row the viewport started; preserving this avoids a
  // few-line drift when navigating away and immediately returning. Only meaningful
  // together with `coordinateSystem`.
  offsetY: number | null;
  coordinateSystem?: string;
}

/**
 * Direction of a row array.
 *
 * `newest-first` is the transcript list itself: index 0 is the newest row, so walking
 * toward higher indices walks into the past and message seqs DECREASE. `oldest-first`
 * is the chronological order every other row array still uses.
 */
export type RowOrder = 'newest-first' | 'oldest-first';

/**
 * A transcript message id encodes its monotonic event seq (`text-42` → 42) — the very
 * cursor the history API pages by (`getHistory({ beforeSeq })`). Pulling it lets a
 * bookmark jump fetch straight down to the target in one request instead of paging
 * 150-at-a-time. Returns null for an unexpected id shape (caller falls back to normal
 * paging). Agent-text ids — the only ones ever bookmarked — always carry a numeric seq.
 */
export function messageSeq(messageId: string): number | null {
  const raw = messageId.slice(messageId.lastIndexOf('-') + 1);
  // Guard the empty tail (`text-` → Number('') === 0, a finite value that would page
  // ALL of history) and any non-positive/non-integer parse — those fall back to a
  // normal page rather than a giant/negative-span fetch.
  if (raw === '') return null;
  const seq = Number(raw);
  return Number.isInteger(seq) && seq > 0 ? seq : null;
}

export function anchorMessageId(row: Row | undefined): string | null {
  if (!row) return null;
  switch (row.kind) {
    case 'message':
      return row.message.id;
    case 'tool-group':
    case 'todo-group':
      return row.tools[row.tools.length - 1]?.id ?? null;
    case 'delegated-agent':
      return row.parent.id;
  }
}

export function anchorFromRow(
  row: Row | undefined,
  atBottom: boolean,
  offsetY: number | null,
): ScrollAnchor {
  return { rowKey: row ? rowKey(row) : null, messageId: anchorMessageId(row), atBottom, offsetY };
}

export function rowMatchesAnchor(row: Row, anchor: ScrollAnchor): boolean {
  if (anchor.messageId !== null) {
    switch (row.kind) {
      case 'message':
        if (row.message.id === anchor.messageId) return true;
        break;
      case 'tool-group':
      case 'todo-group':
        if (row.tools.some((tool) => tool.id === anchor.messageId)) return true;
        break;
      case 'delegated-agent':
        if (row.parent.id === anchor.messageId) return true;
        if (row.childRows.some((child) => rowMatchesAnchor(child, anchor))) return true;
        break;
    }
  }
  if (anchor.rowKey !== null && row.kind === 'delegated-agent') {
    if (row.childRows.some((child) => rowMatchesAnchor(child, anchor))) return true;
  }
  return anchor.rowKey !== null && rowKey(row) === anchor.rowKey;
}

function anchorSeq(anchor: ScrollAnchor): number | null {
  if (anchor.messageId !== null) return messageSeq(anchor.messageId);
  return anchor.rowKey !== null ? messageSeq(anchor.rowKey) : null;
}

function anchorIsAgentText(anchor: ScrollAnchor): boolean {
  return (
    anchor.messageId?.startsWith('text-') === true || anchor.rowKey?.startsWith('text-') === true
  );
}

function rowSeq(row: Row): number | null {
  return messageSeq(anchorMessageId(row) ?? rowKey(row));
}

/**
 * Seq of the next NEWER top-level row, which bounds the seq span an agent-text row
 * covers. Which array direction that is depends on `order`: chronologically it is the
 * following index, in the newest-first transcript it is the preceding one. Reading it
 * from the wrong side returns a seq below the row's own, the span check never matches,
 * and a saved reading position resolves to "row gone" — a jump to latest.
 */
export function nextNewerTopLevelSeq(rows: Row[], index: number, order: RowOrder): number | null {
  const step = order === 'newest-first' ? -1 : 1;
  for (let i = index + step; i >= 0 && i < rows.length; i += step) {
    const seq = rowSeq(rows[i]);
    if (seq !== null) return seq;
  }
  return null;
}

function rowMatchesAnchorAt(
  rows: Row[],
  index: number,
  anchor: ScrollAnchor,
  order: RowOrder,
): boolean {
  const row = rows[index];
  if (!row) return false;
  if (rowMatchesAnchor(row, anchor)) return true;
  // A delegated agent's children are always chronological, whichever way the list
  // holding the parent runs.
  if (row.kind === 'delegated-agent' && findAnchorIndex(row.childRows, anchor, 'oldest-first') >= 0)
    return true;
  if (!anchorIsAgentText(anchor)) return false;

  // Streamed agent text is coalesced into one row keyed by its first chunk, so an
  // anchor naming a later chunk has no row of its own. It belongs to this row when its
  // seq falls in the span between this row and the next newer one.
  const targetSeq = anchorSeq(anchor);
  const startSeq = rowSeq(row);
  if (
    targetSeq === null ||
    startSeq === null ||
    row.kind !== 'message' ||
    row.message.kind !== 'agent-text' ||
    startSeq > targetSeq
  ) {
    return false;
  }

  const nextSeq = nextNewerTopLevelSeq(rows, index, order);
  return nextSeq === null || targetSeq < nextSeq;
}

export function findAnchorIndex(rows: Row[], anchor: ScrollAnchor, order: RowOrder): number {
  return rows.findIndex((_, index) => rowMatchesAnchorAt(rows, index, anchor, order));
}
