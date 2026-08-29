/**
 * Scroll geometry for the transcript list.
 *
 * COORDINATE SYSTEM — the transcript is kept NEWEST-FIRST in `data` and rendered
 * visually inverted (`transform: scaleY(-1)` on the list and on every row, because
 * FlashList 2 has no `inverted` prop). Consequences, and the reason for the whole
 * arrangement:
 *
 * - Layout offset `0` is the NEWEST edge — visually the bottom of the chat. It is an
 *   exact constant, not a measured quantity, so "open at latest" and "jump to latest"
 *   need no convergence loop against estimated row heights.
 * - Older history lives at GROWING offsets. A history page is therefore an APPEND
 *   behind the viewport, never an insertion in front of it: the visible rows keep
 *   their layout position and no imperative offset correction exists to be seen.
 * - Streaming grows index 0, i.e. ABOVE the anchored row in layout coordinates. That
 *   is precisely the case React Native's native `maintainVisibleContentPosition`
 *   (FlashList injects `minIndexForVisible: 0`) is built to absorb, so a reader parked
 *   in history stays put without any per-token compensation.
 *
 * Every helper below is expressed in that system. `offsetY` always means "distance
 * from the newest edge".
 */

/** Bounce and fractional rounding still count as sitting on the newest edge. */
const LATEST_EDGE_TOLERANCE_PX = 8;
/** A visible row's top may sit a hair below the scroll offset because of fractional
 * layout rounding; anything beyond that means the index is not the visible row. */
const ANCHOR_CAPTURE_TOLERANCE_PX = 1;
/** How close to the oldest loaded row counts as "the history edge is in view". */
const HISTORY_EDGE_VIEWPORT_FRACTION = 0.3;

/** Marks anchors written in the newest-first system, so anchors persisted by the
 * previous chronological layout are recognised and repositioned by row identity
 * instead of by a pixel offset that means something else now. */
export const TRANSCRIPT_COORDINATE_SYSTEM = 'newest-first-row';

export type TranscriptPositionMaintenance = {
  disabled: false;
  autoscrollToTopThreshold: number;
  autoscrollToBottomThreshold: number;
  animateAutoScrollToBottom: boolean;
};

export type TranscriptRestoreRequest = {
  index: number;
  animated: false;
  viewPosition: 0;
  viewOffset: number;
};

export type TranscriptRestoreAnchorState = {
  rowKey: string | null;
  messageId: string | null;
  atBottom: boolean;
};

/**
 * One stable native configuration for the inverted transcript.
 *
 * `autoscrollToTopThreshold: 0` — layout index 0 is the newest row, so "content added
 * at the top" means "a new message arrived". Following it is correct only when the
 * reader was exactly on the newest edge; a threshold of zero encodes that literally.
 * `autoscrollToBottomThreshold: -1` — the layout bottom is the OLDEST end, where
 * history pages land. Auto-scrolling there would drag the reader into the past.
 */
export function transcriptPositionMaintenance(): TranscriptPositionMaintenance {
  return {
    disabled: false,
    autoscrollToTopThreshold: 0,
    autoscrollToBottomThreshold: -1,
    animateAutoScrollToBottom: false,
  };
}

/** The newest edge is offset zero — a constant, so this needs no content or viewport
 * measurement and cannot be wrong while rows are still being measured. */
export function isAtLatestEdge(offsetY: number): boolean {
  return Number.isFinite(offsetY) && offsetY <= LATEST_EDGE_TOLERANCE_PX;
}

/** Growing offsets move toward older history in the inverted list. */
export function isScrollTowardHistory(dy: number): boolean {
  return dy > 0;
}

/** Distance from the viewport to the oldest loaded row. */
export function historyEdgeDistance(
  offsetY: number,
  contentHeight: number,
  viewportHeight: number,
): number {
  return contentHeight - (offsetY + viewportHeight);
}

/**
 * Whether the very last loaded row is itself viewable — the transcript cannot be
 * scrolled any further into the past without another page.
 *
 * Unlike {@link isHistoryEdgeVisible} this needs no measured geometry: it is derived
 * from viewability, which React re-reports on every committed layout. That makes it
 * the trustworthy signal right after an append, when the cached content height may
 * still describe the list as it was before the new rows.
 */
export function isOldestRowViewable(oldestVisibleIndex: number, rowCount: number): boolean {
  return rowCount > 0 && oldestVisibleIndex >= rowCount - 1;
}

/**
 * Whether the oldest loaded row is in (or just beyond) view, which is what arms a
 * history page. Before the first native scroll event the content/viewport sizes are
 * unknown, so the oldest viewable index is the reliable fallback.
 */
export function isHistoryEdgeVisible(
  offsetY: number,
  contentHeight: number,
  viewportHeight: number,
  oldestVisibleIndex: number,
  rowCount: number,
): boolean {
  if (contentHeight > 0 && viewportHeight > 0) {
    return (
      historyEdgeDistance(offsetY, contentHeight, viewportHeight) <=
      viewportHeight * HISTORY_EDGE_VIEWPORT_FRACTION
    );
  }
  return isOldestRowViewable(oldestVisibleIndex, rowCount);
}

/** Follow live growth only while Verity still knows the viewport is pinned to the
 * newest edge. A finger drag marks `readingHistory` synchronously before the next
 * render, so even a tiny upward gesture stops the follow. */
export function shouldFollowStreamingContent(
  atBottom: boolean,
  readingHistory: boolean,
  restoring: boolean,
): boolean {
  return atBottom && !readingHistory && !restoring;
}

/** Native layout events are not evidence that the reader reached the newest edge.
 * While a restore is converging, only a real gesture may change that state. History
 * paging no longer needs a guard here: an append behind the viewport cannot move the
 * offset, so the events it produces are honest. */
export function shouldAcceptNativeLatestState(restoring: boolean): boolean {
  return !restoring;
}

/** Restore by stable row identity plus an intra-row offset. `viewPosition: 0` parks
 * the row's layout top at the viewport's layout top — visually the row's newest edge
 * at the bottom of the screen, which is the slice the anchor was captured from. */
export function transcriptRestoreRequest(
  index: number,
  intraRowOffset = 0,
): TranscriptRestoreRequest {
  // FlashList computes `item.y - (viewport - item) * viewPosition + viewOffset`, so
  // with viewPosition 0 the offset is `item.y + viewOffset`.
  return { index, animated: false, viewPosition: 0, viewOffset: Math.max(0, intraRowOffset) };
}

/** First-open (no saved identity) and explicitly latest-pinned anchors both simply
 * open at offset zero — the newest edge needs no search and no convergence. */
export function shouldRestoreToLatestEdge(
  anchor: TranscriptRestoreAnchorState | null,
  anchorLoaded = true,
): boolean {
  return (
    !anchorLoaded ||
    anchor === null ||
    (anchor.rowKey === null && anchor.messageId === null) ||
    anchor.atBottom
  );
}

/**
 * Intra-row offset of a stored anchor, migrated across coordinate systems.
 *
 * Anchors written before the inversion carry an offset measured in the chronological
 * layout. Row identity survives that change, a pixel offset does not, so anything not
 * marked as newest-first repositions purely by row: `0` parks the saved row's newest
 * edge at the bottom of the viewport, which is where it was last seen.
 */
export function migratedAnchorOffset(
  coordinateSystem: string | undefined,
  offsetY: number | null | undefined,
): number {
  if (coordinateSystem !== TRANSCRIPT_COORDINATE_SYSTEM) return 0;
  if (typeof offsetY !== 'number' || !Number.isFinite(offsetY)) return 0;
  return Math.max(0, offsetY);
}

/** The subset of FlashList's `RVLayout` the anchor math needs. `isHeightMeasured` is
 * only `true` once the row has actually been measured: FlashList creates layouts
 * without the flag and estimates them (`RVLayoutManager.getLayout`), so an absent flag
 * means "estimated", not "measured". Everything here therefore requires `=== true`. */
export type TranscriptRowLayout = {
  y: number;
  height: number;
  isHeightMeasured?: boolean;
};

/**
 * How far into the anchor row the viewport starts, or `null` when the layout is not
 * trustworthy enough to derive one.
 *
 * `scrollY - row.y` is only an intra-row offset while `index` really is the row at the
 * layout top of the viewport. A stale viewability index or an unmeasured/estimated
 * layout yields an absolute list offset instead, which would restore the transcript
 * pages away from where it was read. Callers treat `null` as "reposition by row
 * identity alone" rather than substituting a guess.
 */
export function historyAnchorIntraRowOffset(
  scrollY: number,
  layout: TranscriptRowLayout | undefined,
): number | null {
  if (layout === undefined) return null;
  if (!Number.isFinite(scrollY) || !Number.isFinite(layout.y) || !Number.isFinite(layout.height)) {
    return null;
  }
  // An estimated height implies an estimated `y` for everything after it.
  if (layout.isHeightMeasured !== true) return null;
  if (layout.height <= 0) return null;
  const offset = scrollY - layout.y;
  // Before the row (the index is ahead of the viewport) or past its end (the index is
  // stale, or `y` is not this row's true top) — neither is an intra-row position.
  if (offset < -ANCHOR_CAPTURE_TOLERANCE_PX) return null;
  if (offset > layout.height + ANCHOR_CAPTURE_TOLERANCE_PX) return null;
  return Math.min(Math.max(0, offset), layout.height);
}

/**
 * Arm a history page.
 *
 * `appendSettling` is true from the moment a page is requested until its rows have
 * been committed and measured. Blocking on it is what stops the observed run of five
 * back-to-back pages: the edge stays "reached" for the whole gesture, so without it
 * every scroll event during one flick queues another fetch.
 */
export function shouldRequestOlderHistory(
  hasOlder: boolean,
  loadingOlder: boolean,
  stalled = false,
  allowStalledRetry = false,
  appendSettling = false,
): boolean {
  if (!hasOlder || loadingOlder) return false;
  if (stalled && !allowStalledRetry) return false;
  return !appendSettling;
}

/**
 * Continue a bounded metadata-only scan after its cursor advanced without adding
 * visible rows. Network/cursor failures wait for a fresh user-driven retry.
 *
 * Deliberately refuses while a gesture is running or the previous append has not
 * settled: an automatic follow-up there stacks another measurement pass onto a list
 * that is still moving, which is the pattern the transcript used to jump on.
 */
export function shouldContinueOlderHistory(
  requestCompleted: boolean,
  hasOlder: boolean,
  stalled: boolean,
  needsContinuation: boolean,
  historyEdgeVisible: boolean,
  gestureActive = false,
  appendSettling = false,
): boolean {
  return (
    requestCompleted &&
    hasOlder &&
    !stalled &&
    needsContinuation &&
    historyEdgeVisible &&
    !gestureActive &&
    !appendSettling
  );
}
