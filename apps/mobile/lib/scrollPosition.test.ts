import {
  TRANSCRIPT_COORDINATE_SYSTEM,
  historyAnchorIntraRowOffset,
  historyEdgeDistance,
  isAtLatestEdge,
  isHistoryEdgeVisible,
  isOldestRowViewable,
  isScrollTowardHistory,
  migratedAnchorOffset,
  shouldAcceptNativeLatestState,
  shouldContinueOlderHistory,
  shouldFollowStreamingContent,
  shouldRequestOlderHistory,
  shouldRestoreToLatestEdge,
  transcriptPositionMaintenance,
  transcriptRestoreRequest,
} from './scrollPosition';

describe('transcript position maintenance', () => {
  it('keeps native position maintenance enabled', () => {
    // The point of the inversion: streaming grows layout index 0, which the native
    // implementation (minIndexForVisible: 0) absorbs. Disabling it would put
    // per-token compensation back into app code.
    expect(transcriptPositionMaintenance().disabled).toBe(false);
  });

  it('follows new content only from exactly the newest edge', () => {
    // Layout "top" is the newest row here, so a zero threshold means: re-pin only
    // when the reader had not moved away at all.
    expect(transcriptPositionMaintenance().autoscrollToTopThreshold).toBe(0);
  });

  it('never auto-scrolls toward the oldest end where history lands', () => {
    expect(transcriptPositionMaintenance().autoscrollToBottomThreshold).toBe(-1);
  });

  it('never animates an automatic scroll', () => {
    expect(transcriptPositionMaintenance().animateAutoScrollToBottom).toBe(false);
  });

  it('is one stable configuration', () => {
    expect(transcriptPositionMaintenance()).toEqual(transcriptPositionMaintenance());
  });
});

describe('latest edge', () => {
  it('is offset zero, independent of content and viewport measurement', () => {
    expect(isAtLatestEdge(0)).toBe(true);
  });

  it('stays true while a long agent turn streams', () => {
    // Content height grows by thousands of pixels as row 0 gets longer. In the
    // chronological layout that moved the latest edge; here it cannot.
    expect(isAtLatestEdge(0)).toBe(true);
  });

  it('tolerates bounce and fractional rounding', () => {
    expect(isAtLatestEdge(8)).toBe(true);
    expect(isAtLatestEdge(8.5)).toBe(false);
  });

  it('treats a deliberate scroll into history as away from latest', () => {
    expect(isAtLatestEdge(120)).toBe(false);
  });

  it('rejects a non-finite offset', () => {
    expect(isAtLatestEdge(Number.NaN)).toBe(false);
  });
});

describe('scroll direction', () => {
  it('reads growing offsets as scrolling toward history', () => {
    expect(isScrollTowardHistory(40)).toBe(true);
  });

  it('reads shrinking offsets as scrolling toward the newest edge', () => {
    expect(isScrollTowardHistory(-40)).toBe(false);
    expect(isScrollTowardHistory(0)).toBe(false);
  });
});

describe('history edge', () => {
  it('measures the distance to the oldest loaded row from the content end', () => {
    expect(historyEdgeDistance(400, 2000, 600)).toBe(1000);
  });

  it('arms paging once the oldest row is within a third of a viewport', () => {
    expect(isHistoryEdgeVisible(1250, 2000, 600, 0, 40)).toBe(true);
  });

  it('stays disarmed in the middle of the loaded transcript', () => {
    expect(isHistoryEdgeVisible(400, 2000, 600, 0, 40)).toBe(false);
  });

  it('falls back to the oldest viewable index before the first scroll event', () => {
    // A tail shorter than the viewport produces no scroll event at all, so index
    // coverage is the only evidence that the history edge is on screen.
    expect(isHistoryEdgeVisible(0, 0, 0, 11, 12)).toBe(true);
    expect(isHistoryEdgeVisible(0, 0, 0, 4, 12)).toBe(false);
  });

  it('does not arm on an empty transcript', () => {
    expect(isHistoryEdgeVisible(0, 0, 0, 0, 0)).toBe(false);
  });

  it('tracks the last loaded row purely from viewability', () => {
    // Used right after an append, where the cached content height can still describe
    // the pre-append list but viewability is re-reported on every committed layout.
    expect(isOldestRowViewable(11, 12)).toBe(true);
    expect(isOldestRowViewable(12, 12)).toBe(true);
    expect(isOldestRowViewable(11, 25)).toBe(false);
    expect(isOldestRowViewable(0, 0)).toBe(false);
  });

  it('keeps paging armed after a metadata-only page added no rows', () => {
    // Same cursor, same row count — the reader still cannot scroll any further back,
    // so the next page has to be requested even though nothing rendered.
    expect(isOldestRowViewable(11, 12)).toBe(true);
  });

  it('disarms the follow-up once a page put real rows behind the viewport', () => {
    expect(isOldestRowViewable(11, 12)).toBe(true);
    expect(isOldestRowViewable(11, 25)).toBe(false);
  });

  it('re-disarms after an append pushed the oldest row out of view', () => {
    // Appending 17 rows behind the viewport grows content height without moving the
    // offset — which is exactly what makes the append invisible.
    expect(isHistoryEdgeVisible(1250, 2000, 600, 0, 25)).toBe(true);
    expect(isHistoryEdgeVisible(1250, 5400, 600, 0, 42)).toBe(false);
  });
});

describe('history paging', () => {
  it('loads older rows when history exists and nothing is in flight', () => {
    expect(shouldRequestOlderHistory(true, false)).toBe(true);
  });

  it('refuses when there is no older history', () => {
    expect(shouldRequestOlderHistory(false, false)).toBe(false);
  });

  it('refuses while a page is already loading', () => {
    expect(shouldRequestOlderHistory(true, true)).toBe(false);
  });

  it('refuses a stalled cursor until a gesture re-arms the retry', () => {
    expect(shouldRequestOlderHistory(true, false, true)).toBe(false);
    expect(shouldRequestOlderHistory(true, false, true, true)).toBe(true);
  });

  it('allows a page during an active gesture', () => {
    // Scrolling into history IS a gesture. Blocking here would mean history only
    // ever loads after letting go and dragging again — and an append behind the
    // viewport is safe mid-gesture precisely because it moves no visible row.
    expect(shouldRequestOlderHistory(true, false, false, false, false)).toBe(true);
  });

  it('refuses a second page while the previous append is still settling', () => {
    // One flick keeps the history edge "reached" for its whole duration; without
    // this window that produced the observed run of five back-to-back pages.
    expect(shouldRequestOlderHistory(true, false, false, false, true)).toBe(false);
  });

  it('holds a stalled retry back too while an append settles', () => {
    expect(shouldRequestOlderHistory(true, false, true, true, true)).toBe(false);
  });

  it('re-arms once the append has settled', () => {
    expect(shouldRequestOlderHistory(true, false, false, false, true)).toBe(false);
    expect(shouldRequestOlderHistory(true, false, false, false, false)).toBe(true);
  });

  it('lets consecutive pages through one settled append at a time', () => {
    const page = (appendSettling: boolean) =>
      shouldRequestOlderHistory(true, false, false, false, appendSettling);
    // 12 → 25 rows
    expect(page(false)).toBe(true);
    // still measuring the appended block
    expect(page(true)).toBe(false);
    // 25 → 42 rows
    expect(page(false)).toBe(true);
  });
});

describe('history paging continuation', () => {
  const base = {
    completed: true,
    hasOlder: true,
    stalled: false,
    needsContinuation: true,
    edgeVisible: true,
  };
  const canContinue = (
    gestureActive: boolean,
    appendSettling: boolean,
    overrides: Partial<typeof base> = {},
  ) => {
    const a = { ...base, ...overrides };
    return shouldContinueOlderHistory(
      a.completed,
      a.hasOlder,
      a.stalled,
      a.needsContinuation,
      a.edgeVisible,
      gestureActive,
      appendSettling,
    );
  };

  it('continues a metadata-only scan once everything is at rest', () => {
    expect(canContinue(false, false)).toBe(true);
  });

  it('never continues automatically during an active gesture', () => {
    expect(canContinue(true, false)).toBe(false);
  });

  it('never continues automatically while the previous append is settling', () => {
    expect(canContinue(false, true)).toBe(false);
  });

  it('resumes after the gesture ended and the append settled', () => {
    expect(canContinue(true, true)).toBe(false);
    expect(canContinue(false, false)).toBe(true);
  });

  it('stops when the request did not complete', () => {
    expect(canContinue(false, false, { completed: false })).toBe(false);
  });

  it('stops when nothing older remains', () => {
    expect(canContinue(false, false, { hasOlder: false })).toBe(false);
  });

  it('stops on a stalled cursor instead of retrying', () => {
    expect(canContinue(false, false, { stalled: true })).toBe(false);
  });

  it('stops when the page actually added visible rows', () => {
    expect(canContinue(false, false, { needsContinuation: false })).toBe(false);
  });

  it('stops once the reader scrolled away from the history edge', () => {
    expect(canContinue(false, false, { edgeVisible: false })).toBe(false);
  });
});

describe('streaming follow', () => {
  it('follows while pinned to the newest edge', () => {
    expect(shouldFollowStreamingContent(true, false, false)).toBe(true);
  });

  it('does not follow while older messages are being read', () => {
    // The reported case: an agent streams a long turn while the reader is scrolled
    // up. Native position maintenance holds their row; nothing may pull them away.
    expect(shouldFollowStreamingContent(false, true, false)).toBe(false);
  });

  it('does not follow after a gesture even if the offset still reads as latest', () => {
    expect(shouldFollowStreamingContent(true, true, false)).toBe(false);
  });

  it('does not follow while a restore is still positioning', () => {
    expect(shouldFollowStreamingContent(true, false, true)).toBe(false);
  });
});

describe('native latest state', () => {
  it('is accepted during ordinary scrolling', () => {
    expect(shouldAcceptNativeLatestState(false)).toBe(true);
  });

  it('is ignored while a restore is positioning', () => {
    expect(shouldAcceptNativeLatestState(true)).toBe(false);
  });

  it('is accepted during history paging', () => {
    // An append behind the viewport cannot move the offset, so — unlike a prepend —
    // it produces no misleading latest-edge report to guard against.
    expect(shouldAcceptNativeLatestState(false)).toBe(true);
  });
});

describe('anchor capture', () => {
  const measured = (y: number, height: number) => ({ y, height, isHeightMeasured: true });

  it('captures how far into the anchor row the viewport starts', () => {
    expect(historyAnchorIntraRowOffset(520, measured(500, 300))).toBe(20);
  });

  it('captures zero at an exact row boundary', () => {
    expect(historyAnchorIntraRowOffset(500, measured(500, 300))).toBe(0);
  });

  it('captures inside a very tall agent-text or tool-group row', () => {
    // Long prose and collapsed tool groups are exactly the rows whose height is
    // refined late; once measured, a deep intra-row offset is still valid.
    expect(historyAnchorIntraRowOffset(9200, measured(1000, 12000))).toBe(8200);
  });

  it('rejects an unknown layout', () => {
    expect(historyAnchorIntraRowOffset(520, undefined)).toBeNull();
  });

  it('rejects an estimated row height', () => {
    // FlashList creates layouts without the flag and estimates them, so an absent
    // flag means "estimated" — its `y` is a guess for every row after it.
    expect(historyAnchorIntraRowOffset(520, { y: 500, height: 300 })).toBeNull();
    expect(
      historyAnchorIntraRowOffset(520, { y: 500, height: 300, isHeightMeasured: false }),
    ).toBeNull();
  });

  it('rejects a stale index that is still ahead of the viewport', () => {
    expect(historyAnchorIntraRowOffset(400, measured(500, 300))).toBeNull();
  });

  it('rejects a stale index the viewport has already passed', () => {
    // This is what produced the field observation of anchorOffsetY: 4077 — an
    // absolute list offset masquerading as an intra-row one.
    expect(historyAnchorIntraRowOffset(4577, measured(500, 300))).toBeNull();
    expect(historyAnchorIntraRowOffset(4077.33, measured(0, 96))).toBeNull();
  });

  it('tolerates sub-pixel layout rounding at both row edges', () => {
    expect(historyAnchorIntraRowOffset(499.5, measured(500, 300))).toBe(0);
    expect(historyAnchorIntraRowOffset(800.5, measured(500, 300))).toBe(300);
  });

  it('rejects a zero-height row', () => {
    expect(historyAnchorIntraRowOffset(500, measured(500, 0))).toBeNull();
  });

  it('rejects non-finite inputs', () => {
    expect(historyAnchorIntraRowOffset(Number.NaN, measured(500, 300))).toBeNull();
    expect(historyAnchorIntraRowOffset(520, measured(Number.NaN, 300))).toBeNull();
    expect(historyAnchorIntraRowOffset(520, measured(500, Number.NaN))).toBeNull();
  });
});

describe('restore', () => {
  it('parks the anchor row at the layout top with its captured offset', () => {
    expect(transcriptRestoreRequest(12, 40)).toEqual({
      index: 12,
      animated: false,
      viewPosition: 0,
      viewOffset: 40,
    });
  });

  it('defaults to the row start when no offset was captured', () => {
    expect(transcriptRestoreRequest(12)).toEqual({
      index: 12,
      animated: false,
      viewPosition: 0,
      viewOffset: 0,
    });
  });

  it('never applies a negative offset', () => {
    expect(transcriptRestoreRequest(12, -80).viewOffset).toBe(0);
  });

  it('opens at the newest edge with no saved anchor', () => {
    expect(shouldRestoreToLatestEdge(null)).toBe(true);
  });

  it('opens at the newest edge before the saved anchor has loaded', () => {
    expect(
      shouldRestoreToLatestEdge({ rowKey: 'row-9', messageId: 'm-9', atBottom: false }, false),
    ).toBe(true);
  });

  it('opens at the newest edge for an anchor saved while caught up', () => {
    expect(shouldRestoreToLatestEdge({ rowKey: 'row-9', messageId: 'm-9', atBottom: true })).toBe(
      true,
    );
  });

  it('opens at the newest edge for an anchor without row identity', () => {
    expect(shouldRestoreToLatestEdge({ rowKey: null, messageId: null, atBottom: false })).toBe(
      true,
    );
  });

  it('restores an in-tail anchor by row identity', () => {
    expect(shouldRestoreToLatestEdge({ rowKey: 'row-9', messageId: 'm-9', atBottom: false })).toBe(
      false,
    );
  });

  it('restores a deep anchor by row identity as well', () => {
    expect(
      shouldRestoreToLatestEdge({ rowKey: 'row-940', messageId: 'm-940', atBottom: false }),
    ).toBe(false);
  });
});

describe('anchor migration', () => {
  it('keeps an offset written in the current coordinate system', () => {
    expect(migratedAnchorOffset(TRANSCRIPT_COORDINATE_SYSTEM, 42)).toBe(42);
  });

  it('drops an offset from the former chronological layout', () => {
    // Row identity survives the inversion; the pixel offset measured a different
    // quantity, so a migrated anchor repositions by row alone.
    expect(migratedAnchorOffset('chronological-row', 4077)).toBe(0);
  });

  it('drops an untagged legacy offset', () => {
    expect(migratedAnchorOffset(undefined, 900)).toBe(0);
  });

  it('drops a missing or unusable offset', () => {
    expect(migratedAnchorOffset(TRANSCRIPT_COORDINATE_SYSTEM, null)).toBe(0);
    expect(migratedAnchorOffset(TRANSCRIPT_COORDINATE_SYSTEM, undefined)).toBe(0);
    expect(migratedAnchorOffset(TRANSCRIPT_COORDINATE_SYSTEM, Number.NaN)).toBe(0);
  });

  it('never yields a negative offset', () => {
    expect(migratedAnchorOffset(TRANSCRIPT_COORDINATE_SYSTEM, -12)).toBe(0);
  });
});
