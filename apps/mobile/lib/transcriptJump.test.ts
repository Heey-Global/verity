import {
  TRANSCRIPT_JUMP_MAX_PASSES,
  isTranscriptJumpSettled,
  settleTranscriptJump,
  transcriptJumpOffset,
  transcriptJumpRequest,
  type TranscriptJumpList,
  type TranscriptJumpRequest,
} from './transcriptJump';

type FakeRow = { height: number; measured: boolean };

/**
 * A list whose rows carry an ESTIMATED height until the first scroll brings them into
 * range, which is when FlashList measures them — the sequence the real list goes
 * through. `scrollToIndex` reproduces FlashList's arithmetic against the layout as it
 * stands at the time of the call, and the measurement happens after that scroll, in
 * the window where the real list drops its own correction.
 */
function fakeList(rows: FakeRow[], viewport: number, firstItemOffset = 0) {
  const requests: TranscriptJumpRequest[] = [];
  let offset = 0;
  const layoutOf = (index: number) => {
    let y = 0;
    for (let i = 0; i < index; i += 1) y += rows[i]?.height ?? 0;
    const row = rows[index];
    return row ? { y, height: row.height, isHeightMeasured: row.measured } : undefined;
  };
  const contentHeight = () => rows.reduce((sum, row) => sum + row.height, 0);
  let measureOnScroll: (() => void) | null = null;
  const list: TranscriptJumpList = {
    async scrollToIndex(params) {
      requests.push(params);
      const layout = layoutOf(params.index);
      if (!layout) throw new Error('out of range');
      const max = Math.max(0, contentHeight() - viewport + firstItemOffset);
      const raw = layout.y + layout.height - viewport + params.viewOffset + firstItemOffset;
      offset = Math.min(Math.max(0, raw), max);
      measureOnScroll?.();
      measureOnScroll = null;
    },
    getLayout: layoutOf,
    getWindowSize: () => ({ height: viewport }),
    getFirstItemOffset: () => firstItemOffset,
    getChildContainerDimensions: () => ({ height: contentHeight() }),
    getAbsoluteLastScrollOffset: () => offset,
  };
  return {
    list,
    requests,
    offset: () => offset,
    afterNextScroll(measure: () => void) {
      measureOnScroll = measure;
    },
  };
}

describe('transcriptJumpRequest', () => {
  it('parks the row at the visual top without animation', () => {
    expect(transcriptJumpRequest(4, 16)).toEqual({
      index: 4,
      animated: false,
      viewPosition: 1,
      viewOffset: 16,
    });
  });

  it('never pulls the row above the edge with a negative inset', () => {
    expect(transcriptJumpRequest(4, -8).viewOffset).toBe(0);
  });
});

describe('transcriptJumpOffset', () => {
  it('leaves the top inset of room above the row', () => {
    // Rows newest-first: index 2 is the prompt, 0 and 1 the reply below it on screen.
    const rows = [300, 500, 80, 400].map((height) => ({ height, measured: true }));
    const { list } = fakeList(rows, 600);
    const flush = transcriptJumpOffset(list, 2, 0);
    const inset = transcriptJumpOffset(list, 2, 16);
    // Row end (300 + 500 + 80) aligned with the viewport's layout end (offset + 600).
    expect(flush).toBe(280);
    expect(inset).toBe(296);
  });

  it('clamps to the scrollable range like the final native scroll', () => {
    const rows = [300, 500, 80].map((height) => ({ height, measured: true }));
    const { list } = fakeList(rows, 600);
    // The oldest row cannot be parked at the top of a viewport taller than what is left.
    expect(transcriptJumpOffset(list, 2, 16)).toBe(280);
    expect(transcriptJumpOffset(list, 0, 16)).toBe(0);
  });

  it('is unknown without a layout', () => {
    const { list } = fakeList([], 600);
    expect(transcriptJumpOffset(list, 3, 16)).toBeNull();
  });
});

describe('settleTranscriptJump', () => {
  it('re-scrolls after the first pass measured rows and lands on the measured offset', async () => {
    // The reply below the prompt (index 1) is estimated at 200 but really 900. The
    // first pass scrolls by the estimate; measuring it moves the prompt's layout end
    // 700 px further, which is exactly the "parked inside the agent's text" symptom.
    const rows: FakeRow[] = [
      { height: 300, measured: true },
      { height: 200, measured: false },
      { height: 80, measured: false },
      { height: 400, measured: false },
    ];
    const fake = fakeList(rows, 600);
    fake.afterNextScroll(() => {
      rows[1] = { height: 900, measured: true };
      rows[2] = { height: 80, measured: true };
    });

    const outcome = await settleTranscriptJump({
      list: () => fake.list,
      resolveIndex: () => 2,
      topInset: 16,
    });

    expect(outcome).toBe('settled');
    expect(fake.requests).toHaveLength(2);
    expect(fake.offset()).toBe(300 + 900 + 80 - 600 + 16);
    expect(isTranscriptJumpSettled(fake.list, 2, 16)).toBe(true);
  });

  it('does not trust agreement with an estimated height', () => {
    const rows: FakeRow[] = [
      { height: 300, measured: true },
      { height: 200, measured: false },
    ];
    const fake = fakeList(rows, 400);
    // The offset matches the estimate exactly, but the estimate is what moved it there.
    void fake.list.scrollToIndex(transcriptJumpRequest(1, 0));
    expect(isTranscriptJumpSettled(fake.list, 1, 0)).toBe(false);
  });

  it('gives up after the pass budget when layout never stops moving', async () => {
    const rows: FakeRow[] = [
      { height: 300, measured: true },
      { height: 100, measured: true },
    ];
    const fake = fakeList(rows, 200);
    let passes = 0;
    const outcome = await settleTranscriptJump({
      list: () => fake.list,
      resolveIndex: () => 1,
      topInset: 0,
      onPass: () => {
        passes += 1;
        // Grows on every pass, so no pass ever finds the list where it computed.
        rows[0] = { height: rows[0].height + 50, measured: true };
        fake.afterNextScroll(() => {
          rows[0] = { height: rows[0].height + 50, measured: true };
        });
      },
    });
    expect(outcome).toBe('unsettled');
    expect(passes).toBe(TRANSCRIPT_JUMP_MAX_PASSES);
  });

  it('reports a target that re-keyed away rather than scrolling somewhere else', async () => {
    const fake = fakeList([{ height: 300, measured: true }], 600);
    const outcome = await settleTranscriptJump({
      list: () => fake.list,
      resolveIndex: () => -1,
      topInset: 16,
    });
    expect(outcome).toBe('lost');
    expect(fake.requests).toHaveLength(0);
  });

  it('stops at a cancellation between passes', async () => {
    const rows: FakeRow[] = [
      { height: 300, measured: true },
      { height: 200, measured: false },
    ];
    const fake = fakeList(rows, 400);
    let cancelled = false;
    fake.afterNextScroll(() => {
      cancelled = true;
    });
    const outcome = await settleTranscriptJump({
      list: () => fake.list,
      resolveIndex: () => 1,
      topInset: 0,
      isCancelled: () => cancelled,
    });
    expect(outcome).toBe('cancelled');
    expect(fake.requests).toHaveLength(1);
  });

  it('survives a rejected pass and re-resolves the row', async () => {
    const rows: FakeRow[] = [
      { height: 300, measured: true },
      { height: 200, measured: true },
    ];
    const fake = fakeList(rows, 400);
    const indices = [5, 1];
    const outcome = await settleTranscriptJump({
      list: () => fake.list,
      resolveIndex: () => indices.shift() ?? 1,
      topInset: 0,
    });
    expect(outcome).toBe('settled');
    expect(fake.requests.map((request) => request.index)).toEqual([5, 1]);
  });
});
