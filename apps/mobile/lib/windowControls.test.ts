import { NO_WINDOW_CONTROLS_INSET, windowControlsInset } from './windowControls';

describe('window controls inset', () => {
  it('is nothing until the native module has reported', () => {
    expect(windowControlsInset(undefined)).toEqual(NO_WINDOW_CONTROLS_INSET);
    expect(windowControlsInset(null)).toEqual(NO_WINDOW_CONTROLS_INSET);
  });

  it('is nothing when no corner intrudes', () => {
    // iPhone, Android, full-screen iPad, anything before iOS 26: the adapted
    // margins come back equal to the plain ones.
    expect(windowControlsInset({ left: 16, right: 16, baseLeft: 16, baseRight: 16 })).toEqual({
      left: 0,
      right: 0,
    });
  });

  it('reports only what the corner claims on top of the normal margin', () => {
    // Never the raw 78: the header already pays its own horizontal padding, so
    // adding the whole adapted margin would count the window's margin twice.
    expect(windowControlsInset({ left: 78, right: 16, baseLeft: 16, baseRight: 16 })).toEqual({
      left: 62,
      right: 0,
    });
  });

  it('reads a trailing claim the same way', () => {
    // Nothing in the arithmetic assumes the controls are on the left; whichever
    // corner the system parks them in is the side that comes back non-zero.
    expect(windowControlsInset({ left: 16, right: 78, baseLeft: 16, baseRight: 16 })).toEqual({
      left: 0,
      right: 62,
    });
  });

  it('subtracts a safe area that sits in both margins', () => {
    // Landscape on a device with a notch: both values carry the same 44pt, so
    // the controls' own claim is still 62.
    expect(windowControlsInset({ left: 122, right: 60, baseLeft: 60, baseRight: 60 })).toEqual({
      left: 62,
      right: 0,
    });
  });

  it('ignores a margin too small to be the controls', () => {
    // A rounded corner clearing itself, not three dots — moving the header for
    // that would be a visible nudge with nothing behind it.
    expect(windowControlsInset({ left: 30, right: 30, baseLeft: 16, baseRight: 16 })).toEqual({
      left: 0,
      right: 0,
    });
  });

  it('drops a value it cannot explain instead of shoving the buttons inward', () => {
    expect(windowControlsInset({ left: 900, right: 900, baseLeft: 0, baseRight: 0 })).toEqual({
      left: 0,
      right: 0,
    });
    // The bound itself is still a claim the controls could make.
    expect(windowControlsInset({ left: 120, right: 0, baseLeft: 0, baseRight: 0 })).toEqual({
      left: 120,
      right: 0,
    });
  });

  it('drops two sides that are each plausible but together are not', () => {
    // 100 + 100 stays under the per-side bound twice over, but the controls only
    // ever sit in one corner — and the header would pay 200pt of a window's width.
    expect(windowControlsInset({ left: 100, right: 100, baseLeft: 0, baseRight: 0 })).toEqual({
      left: 0,
      right: 0,
    });
  });

  it.each([
    ['the shared zero constant', null],
    ['a measured inset', { left: 78, right: 16, baseLeft: 16, baseRight: 16 }],
  ])('hands out %s frozen', (_label, margins) => {
    // Headers hold on to what they are given, so a stray write must not survive —
    // silently dropped in sloppy mode, a TypeError in strict.
    const inset = windowControlsInset(margins);
    const before = inset.left;
    try {
      (inset as { left: number }).left = 99;
    } catch {
      // strict mode
    }
    expect(inset.left).toBe(before);
  });

  it('never returns a negative inset', () => {
    expect(windowControlsInset({ left: 4, right: 4, baseLeft: 16, baseRight: 16 })).toEqual({
      left: 0,
      right: 0,
    });
  });

  it('ignores margins that are not numbers', () => {
    expect(
      windowControlsInset({
        left: Number.NaN,
        right: Number.POSITIVE_INFINITY,
        baseLeft: 16,
        baseRight: 16,
      }),
    ).toEqual(NO_WINDOW_CONTROLS_INSET);
  });
});
