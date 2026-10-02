/**
 * Jumping the transcript to a navigation stop (an own prompt or a bookmark).
 *
 * FlashList's `scrollToIndex` is not a single scroll: it steps the offset across
 * several renders, re-reads the target's layout on each, and PAUSES its own offset
 * correction until ~200 ms after the final scroll. The rows that come into range at
 * the new position are measured during that pause, and the shift their real heights
 * cause is dropped — which parked the target a few lines above the viewport, or a
 * screen away inside the agent's reply. Re-issuing the scroll on fixed timers only
 * stacked such sequences on top of each other.
 *
 * So one pass at a time, each awaited to completion; afterwards the target's expected
 * offset is recomputed from the now-measured layout and compared with where the list
 * actually sits. The cover lifts only once both agree (or after a bounded number of
 * passes, so a layout that never stops moving cannot keep it up forever).
 *
 * Geometry is the newest-first, visually inverted system of lib/scrollPosition.ts:
 * `viewPosition: 1` aligns the row's layout END with the viewport's layout end, which
 * on screen is the row parked at the TOP. A positive `viewOffset` scrolls further
 * toward layout end, i.e. pushes the row DOWN the screen by that many pixels — the
 * breathing room that keeps a prompt from sitting flush against (or under) the edge.
 */

export type TranscriptJumpRequest = {
  index: number;
  animated: false;
  viewPosition: 1;
  viewOffset: number;
};

/** The subset of FlashList's ref the jump needs; kept structural so tests can fake it. */
export interface TranscriptJumpList {
  scrollToIndex(params: TranscriptJumpRequest): Promise<void>;
  getLayout(index: number): { y: number; height: number; isHeightMeasured?: boolean } | undefined;
  getWindowSize(): { height: number };
  getFirstItemOffset(): number;
  getChildContainerDimensions(): { height: number };
  getAbsoluteLastScrollOffset(): number;
}

export type TranscriptJumpOutcome = 'settled' | 'unsettled' | 'lost' | 'cancelled';

/** Each pass is ~5 renders plus FlashList's 200 ms correction pause; six passes keep
 * the worst case under about two seconds of cover. */
export const TRANSCRIPT_JUMP_MAX_PASSES = 6;
/** Fractional layout rounding between the computed offset and the native one. */
const TRANSCRIPT_JUMP_TOLERANCE_PX = 1;

export function transcriptJumpRequest(index: number, topInset: number): TranscriptJumpRequest {
  return { index, animated: false, viewPosition: 1, viewOffset: Math.max(0, topInset) };
}

/**
 * Where FlashList will leave the list for `transcriptJumpRequest(index, topInset)`,
 * given its CURRENT layout knowledge — `item.y + item.height - viewport + viewOffset
 * + firstItemOffset`, clamped to the scrollable range the way the final scroll is.
 * `null` while the row has no layout at all.
 */
export function transcriptJumpOffset(
  list: TranscriptJumpList,
  index: number,
  topInset: number,
): number | null {
  const layout = list.getLayout(index);
  if (!layout) return null;
  const viewport = list.getWindowSize().height;
  const firstItemOffset = list.getFirstItemOffset();
  const raw = layout.y + layout.height - viewport + Math.max(0, topInset) + firstItemOffset;
  const max = Math.max(0, list.getChildContainerDimensions().height - viewport + firstItemOffset);
  return Math.min(Math.max(0, raw), max);
}

/**
 * True once the list sits where the target's MEASURED layout says it should. An
 * estimated height is never good enough: it is exactly the value the first pass
 * scrolled by, so agreeing with it proves nothing.
 */
export function isTranscriptJumpSettled(
  list: TranscriptJumpList,
  index: number,
  topInset: number,
): boolean {
  const layout = list.getLayout(index);
  if (!layout || layout.isHeightMeasured === false) return false;
  const expected = transcriptJumpOffset(list, index, topInset);
  if (expected === null) return false;
  return Math.abs(expected - list.getAbsoluteLastScrollOffset()) <= TRANSCRIPT_JUMP_TOLERANCE_PX;
}

export interface SettleTranscriptJumpOptions {
  /** Read fresh on every pass: the ref can detach while a pass is awaited. */
  list: () => TranscriptJumpList | null | undefined;
  /** Re-resolved on every pass: a prepend or a coalescing boundary can move the row. */
  resolveIndex: () => number;
  topInset: number;
  maxPasses?: number;
  isCancelled?: () => boolean;
  /** Called right before each pass scrolls, for debug stamping. */
  onPass?: (pass: number, index: number) => void;
}

/**
 * Drive `scrollToIndex` passes sequentially until the target is settled.
 *
 * Never throws: an out-of-range index mid-stream rejects the native call, and the next
 * pass simply re-resolves the row; a row that is gone for good reports `lost`.
 */
export async function settleTranscriptJump(
  options: SettleTranscriptJumpOptions,
): Promise<TranscriptJumpOutcome> {
  const maxPasses = options.maxPasses ?? TRANSCRIPT_JUMP_MAX_PASSES;
  const isCancelled = options.isCancelled ?? (() => false);
  for (let pass = 0; pass < maxPasses; pass += 1) {
    if (isCancelled()) return 'cancelled';
    const list = options.list();
    if (!list) return 'lost';
    const index = options.resolveIndex();
    if (index < 0) return 'lost';
    options.onPass?.(pass, index);
    try {
      await list.scrollToIndex(transcriptJumpRequest(index, options.topInset));
    } catch {
      // Transient out-of-range (anchor shifted mid-stream): re-resolve on the next pass.
    }
    if (isCancelled()) return 'cancelled';
    const settledIndex = options.resolveIndex();
    if (settledIndex < 0) return 'lost';
    if (isTranscriptJumpSettled(list, settledIndex, options.topInset)) return 'settled';
  }
  return 'unsettled';
}
