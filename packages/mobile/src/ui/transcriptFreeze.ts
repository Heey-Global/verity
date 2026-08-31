import type { Message } from '../happy/message.js';
import { groupRows, type Row } from './transcriptRows.js';

/**
 * Live-tail freeze for the inverted transcript (pure → unit-testable).
 *
 * The transcript renders NEWEST-FIRST (see `apps/mobile/lib/scrollPosition.ts`):
 * layout offset 0 is the newest edge and offsets grow toward older history. That
 * makes history paging free — older pages append behind the viewport — but it puts
 * the LIVE tail in front of the reader: while the agent streams, row 0 grows, and
 * every older row (everything the operator is reading) is pushed to a higher offset.
 *
 * FlashList compensates for that with `maintainVisibleContentPosition`, which
 * measures how far the FIRST VISIBLE row moved and scrolls by the same amount. That
 * correction cannot work here: whenever the viewport sits inside the growing row —
 * i.e. anywhere within one (often screen-tall) streamed message of the newest edge —
 * the first visible row IS row 0, whose layout origin is pinned at 0 by construction.
 * The measured delta is then always zero while the content underneath keeps moving,
 * so the correction silently no-ops and the operator's text drifts off the top. Only
 * once they scroll past the whole growing row does an older row become the anchor and
 * the correction start working again — which is exactly the reported symptom
 * ("it only stops once I've scrolled up a good distance").
 *
 * The fix is to stop the tail from moving at all while it is not being watched:
 * when the operator leaves the newest edge, snapshot the transcript and render the
 * snapshot. Nothing newer than their viewport is rendered, nothing already rendered
 * changes size, and no correction is needed. History paging still works because
 * pages that arrive at the OLDER end are merged in live (they append behind the
 * viewport, where a change is harmless). Returning to the newest edge drops the
 * snapshot and the live tail resumes.
 *
 * The snapshot must COPY the messages: the reducer streams by mutating the active
 * message in place (`msg.text += delta`, `msg.tool.state = …`), so keeping the live
 * objects would freeze the row list while its rows kept growing.
 */
export interface FrozenTranscriptTail {
  /**
   * Id of the OLDEST message in the snapshot — the merge boundary. Messages before
   * it in the live list are history pages fetched after the freeze and are rendered
   * live; the boundary and everything after it comes from the snapshot.
   */
  boundaryMessageId: string;
  /** Snapshot rows, chronological (oldest first), as {@link groupRows} produces them. */
  rows: Row[];
}

/**
 * Copy a message deeply enough that later reducer mutations cannot reach it. Only
 * two things are mutated in place after a message is published: an agent/thinking
 * message's `text`, and a tool call's `tool` fields (`result`, `state`, `completedAt`,
 * `skillBody`). `children` is always empty — nesting is derived by `groupRows` from
 * `parentToolId` — so a shallow copy plus a fresh `tool` object is enough.
 */
function cloneMessage(message: Message): Message {
  return message.kind === 'tool-call' ? { ...message, tool: { ...message.tool } } : { ...message };
}

/** Snapshot the currently loaded transcript. `null` when there is nothing to freeze. */
export function freezeTranscriptTail(messages: readonly Message[]): FrozenTranscriptTail | null {
  const boundary = messages[0];
  if (boundary === undefined) return null;
  return {
    boundaryMessageId: boundary.id,
    rows: groupRows(messages.map(cloneMessage)),
  };
}

/**
 * Rows to render while frozen: history loaded since the freeze, followed by the
 * snapshot. Returns `null` when the boundary message is gone from the live list (a
 * transcript reload), which means the snapshot no longer describes this session and
 * the caller should fall back to live rows.
 *
 * The returned array is the snapshot's own array while no older page has arrived, so
 * a streaming session re-renders with an unchanged `data` reference — FlashList sees
 * no work at all.
 *
 * Grouping runs separately over the two halves, so a group straddling the boundary is
 * not re-formed while frozen: a run of tool calls renders as two collapsed cards
 * instead of one, and a sub-agent dispatch whose children are in the snapshot keeps
 * those children at top level (where {@link groupRows} already put them, since their
 * parent was not loaded yet) with the parent rendering as a plain tool card in front.
 *
 * That is deliberate, not a gap. Re-forming such a group is exactly the edit this
 * whole mechanism exists to avoid: collapsing a screenful of rows the operator is
 * reading into one card would move everything under them. Rendering it split keeps the
 * frozen half byte-for-byte what was on screen when they stopped following, it costs
 * nothing but one extra card at one page boundary in already-read history, and the
 * regular grouping returns as soon as the freeze is lifted.
 */
export function frozenTranscriptRows(
  messages: readonly Message[],
  frozen: FrozenTranscriptTail,
): Row[] | null {
  const boundary = messages.findIndex((m) => m.id === frozen.boundaryMessageId);
  if (boundary < 0) return null;
  if (boundary === 0) return frozen.rows;
  return [...groupRows(messages.slice(0, boundary)), ...frozen.rows];
}
