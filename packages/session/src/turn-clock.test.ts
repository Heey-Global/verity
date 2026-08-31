import { describe, expect, it, vi } from 'vitest';
import { armDeadline, createTurnClock } from './turn-clock.js';

/**
 * This clock decides when a turn is killed, so every case here is a way the turn
 * could be killed early or kept alive too long. It is driven by an injected clock
 * rather than by real timers: the boundary cases differ by milliseconds, and a
 * wall-clock race would be either flaky or too coarse to see them at all.
 */
describe('createTurnClock', () => {
  /** A clock the test moves by hand. */
  function fixture(): { advance: (ms: number) => void; clock: ReturnType<typeof createTurnClock> } {
    let now = 1_000;
    return {
      advance: (ms: number) => {
        now += ms;
      },
      clock: createTurnClock(() => now),
    };
  }

  it('spends a budget on ordinary time', () => {
    const { advance, clock } = fixture();
    advance(500);
    const remaining = clock.budget(300);
    advance(200);
    expect(remaining()).toBe(100);
    advance(150);
    expect(remaining()).toBeLessThan(0);
  });

  it('does not spend a budget while a decision is pending', () => {
    const { advance, clock } = fixture();
    const remaining = clock.budget(200);
    advance(50);
    clock.beginOperatorWait();
    advance(5_000);
    // Visible while the prompt is still on screen, not only once it is answered:
    // a deadline re-checked on a tick must not fire mid-wait.
    expect(remaining()).toBe(150);
    clock.endOperatorWait();
    advance(30);
    expect(remaining()).toBe(120);
  });

  it('excludes overlapping decisions once rather than twice', () => {
    const { advance, clock } = fixture();
    const remaining = clock.budget(200);
    clock.beginOperatorWait();
    advance(100);
    clock.beginOperatorWait();
    advance(100);
    clock.endOperatorWait();
    advance(100);
    clock.endOperatorWait();
    advance(10);
    // 300 ms of wall time with at least one prompt open throughout: excluded once.
    expect(remaining()).toBe(190);
  });

  it('gives a budget back only the part of a pending decision it was open for', () => {
    const { advance, clock } = fixture();
    // The app-server may push a tool call before it answers `turn/start`.
    clock.beginOperatorWait();
    advance(400);
    const remaining = clock.budget(200);
    advance(100);
    clock.endOperatorWait();
    advance(50);
    // The 400 ms before this budget opened were never inside it; subtracting them
    // would hand the turn a longer budget than it was given.
    expect(remaining()).toBe(150);
  });

  it('gives a budget back nothing for a decision that ended before it opened', () => {
    const { advance, clock } = fixture();
    clock.beginOperatorWait();
    advance(400);
    clock.endOperatorWait();
    advance(20);
    const remaining = clock.budget(200);
    advance(100);
    expect(remaining()).toBe(100);
  });

  it('runs two budgets on the same waits without either paying twice', () => {
    const { advance, clock } = fixture();
    // The RPC that starts the turn and the turn itself overlap in exactly this
    // way, and one prompt has to stop both.
    const outer = clock.budget(500);
    advance(100);
    const inner = clock.budget(300);
    clock.beginOperatorWait();
    advance(1_000);
    clock.endOperatorWait();
    advance(50);
    expect(outer()).toBe(350);
    expect(inner()).toBe(250);
  });

  it('measures against a monotonic source rather than the wall clock', () => {
    // These readings are re-taken on a tick to decide whether a deadline has
    // passed, so a clock that can step would kill a live turn on an NTP
    // correction and hold a dead one open on a correction the other way.
    const wallClock = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    try {
      const remaining = createTurnClock().budget(1_000);
      wallClock.mockReturnValue(1_000 + 60 * 60 * 1_000);
      expect(remaining()).toBeGreaterThan(0);
    } finally {
      wallClock.mockRestore();
    }
  });

  it('ignores an unmatched answer instead of counting backwards', () => {
    const { advance, clock } = fixture();
    const remaining = clock.budget(400);
    advance(100);
    clock.beginOperatorWait();
    advance(200);
    clock.endOperatorWait();
    clock.endOperatorWait();
    advance(50);
    expect(remaining()).toBe(250);
  });
});

describe('armDeadline', () => {
  /** Fake timers so the re-check loop can be watched without waiting for it. */
  function withFakeTimers(body: (clock: ReturnType<typeof createTurnClock>) => void): void {
    vi.useFakeTimers();
    try {
      body(createTurnClock(() => Date.now()));
    } finally {
      vi.useRealTimers();
    }
  }

  it('fires once the budget is spent', () => {
    withFakeTimers((clock) => {
      let expiries = 0;
      const remaining = clock.budget(200);
      armDeadline(remaining, () => {
        expiries += 1;
      });
      vi.advanceTimersByTime(199);
      expect(expiries).toBe(0);
      vi.advanceTimersByTime(2);
      expect(expiries).toBe(1);
      // The tick stops at expiry rather than rearming, so nothing fires twice.
      vi.advanceTimersByTime(10_000);
      expect(expiries).toBe(1);
    });
  });

  it('holds off while a decision is pending, without spinning on a near-spent budget', () => {
    withFakeTimers((clock) => {
      let expired = false;
      let checks = 0;
      const remaining = clock.budget(60);
      armDeadline(
        () => {
          checks += 1;
          return remaining();
        },
        () => {
          expired = true;
        },
      );
      vi.advanceTimersByTime(59);
      clock.beginOperatorWait();
      checks = 0;
      vi.advanceTimersByTime(5_000);
      expect(expired).toBe(false);
      // 1 ms left and frozen: without a floor on the interval this rearms itself
      // every millisecond for as long as the prompt is on screen.
      expect(checks).toBeLessThan(150);
      clock.endOperatorWait();
      vi.advanceTimersByTime(60);
      expect(expired).toBe(true);
    });
  });

  it('does not fire once cancelled', () => {
    withFakeTimers((clock) => {
      let expired = false;
      const cancel = armDeadline(clock.budget(200), () => {
        expired = true;
      });
      vi.advanceTimersByTime(100);
      cancel();
      vi.advanceTimersByTime(10_000);
      expect(expired).toBe(false);
    });
  });
});
