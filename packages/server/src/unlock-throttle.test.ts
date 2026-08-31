import { describe, expect, it } from 'vitest';
import { createUnlockThrottle } from './unlock-throttle.js';

describe('createUnlockThrottle', () => {
  it('allows attempts below the per-IP threshold, then locks out with backoff', () => {
    let t = 1_000;
    const throttle = createUnlockThrottle({
      perIpThreshold: 3,
      baseLockoutMs: 1_000,
      maxLockoutMs: 60_000,
      now: () => t,
    });
    const ip = '10.0.0.1';

    // Two failures — still under the threshold, attempts remain allowed.
    throttle.recordFailure(ip);
    throttle.recordFailure(ip);
    expect(throttle.check(ip).allowed).toBe(true);

    // Third failure trips the first lockout: base * 2^0 = 1000ms.
    throttle.recordFailure(ip);
    const locked = throttle.check(ip);
    expect(locked.allowed).toBe(false);
    expect(locked.retryAfterMs).toBe(1_000);

    // The lockout expires; the next attempt is allowed again.
    t += 1_000;
    expect(throttle.check(ip).allowed).toBe(true);

    // A further failure doubles the backoff: base * 2^1 = 2000ms.
    throttle.recordFailure(ip);
    expect(throttle.check(ip).retryAfterMs).toBe(2_000);
  });

  it('caps the backoff at maxLockoutMs', () => {
    let t = 0;
    const throttle = createUnlockThrottle({
      perIpThreshold: 1,
      baseLockoutMs: 1_000,
      maxLockoutMs: 4_000,
      now: () => t,
    });
    const ip = 'x';
    // Fail repeatedly, stepping past each lockout so the next failure lands.
    for (let i = 0; i < 10; i++) {
      throttle.recordFailure(ip);
      t += 100_000; // jump well past any lockout window
    }
    throttle.recordFailure(ip);
    expect(throttle.check(ip).retryAfterMs).toBe(4_000); // capped, not 2^10 * base
  });

  it('recordSuccess clears the IP penalty', () => {
    let t = 5;
    const throttle = createUnlockThrottle({
      perIpThreshold: 2,
      baseLockoutMs: 1_000,
      now: () => t,
    });
    const ip = 'a';
    throttle.recordFailure(ip);
    throttle.recordFailure(ip);
    expect(throttle.check(ip).allowed).toBe(false);
    throttle.recordSuccess(ip);
    t += 1;
    expect(throttle.check(ip).allowed).toBe(true);
  });

  it('isolates lockouts per IP', () => {
    const t = 1;
    const throttle = createUnlockThrottle({ perIpThreshold: 1, now: () => t });
    throttle.recordFailure('locked-ip');
    expect(throttle.check('locked-ip').allowed).toBe(false);
    expect(throttle.check('other-ip').allowed).toBe(true);
  });

  it('applies a global floor once total failures cross the window threshold', () => {
    let t = 0;
    const throttle = createUnlockThrottle({
      perIpThreshold: 1_000, // high, so per-IP lockout never fires here
      globalThreshold: 5,
      globalWindowMs: 60_000,
      now: () => t,
    });
    for (let i = 0; i < 5; i++) {
      throttle.recordFailure(`ip-${String(i)}`);
      t += 10;
    }
    // A brand-new IP is now throttled purely by the global floor.
    const decision = throttle.check('fresh-ip');
    expect(decision.allowed).toBe(false);
    expect(decision.retryAfterMs).toBe(59_950);

    // Once the window slides past the failures, the floor lifts.
    t += 60_001;
    expect(throttle.check('fresh-ip').allowed).toBe(true);
  });
});
