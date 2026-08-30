// Brute-force defence for POST /secret/unlock (audit finding C2). Once the auth
// gate makes the master password the single entry credential, its verify path
// becomes the one online guessing oracle — scrypt's ~100 ms/attempt is the only
// brake today. This adds per-IP lockout with exponential backoff plus a coarse
// global cap, so a distributed spray can't grind unlimited attempts.
//
// Purely in-memory: brute force is an online attack, so state need not survive a
// restart (a restart only helps the attacker by resetting nothing they control).
// The clock is injectable so the behaviour is deterministically testable.

export interface UnlockThrottleOptions {
  /** Consecutive per-IP failures tolerated before lockouts kick in. */
  perIpThreshold?: number;
  /** First lockout duration; doubles per failure past the threshold. */
  baseLockoutMs?: number;
  /** Upper bound on a single lockout window. */
  maxLockoutMs?: number;
  /** Total failures across ALL ips within `globalWindowMs` before every attempt
   *  is briefly delayed (a floor under a distributed low-and-slow spray). */
  globalThreshold?: number;
  globalWindowMs?: number;
  /** Injectable clock (ms). Defaults to Date.now. */
  now?: () => number;
}

export interface ThrottleDecision {
  allowed: boolean;
  /** When blocked, how long the caller should wait (ms) — surfaced as Retry-After. */
  retryAfterMs?: number;
}

export interface UnlockThrottle {
  /** Gate an incoming attempt from `ip` BEFORE deriving the key. */
  check(ip: string): ThrottleDecision;
  /** Record a wrong password from `ip` (advances backoff). */
  recordFailure(ip: string): void;
  /** Record a correct password from `ip` (clears its penalty). */
  recordSuccess(ip: string): void;
}

interface IpState {
  failures: number;
  lockedUntil: number;
  lastSeen: number;
}

const DEFAULTS = {
  perIpThreshold: 5,
  baseLockoutMs: 1_000,
  maxLockoutMs: 15 * 60_000,
  globalThreshold: 100,
  globalWindowMs: 60_000,
} as const;

/** Evict idle IP entries after this long with no activity, bounding memory. */
const IDLE_EVICT_MS = 60 * 60_000;

export function createUnlockThrottle(options: UnlockThrottleOptions = {}): UnlockThrottle {
  const perIpThreshold = options.perIpThreshold ?? DEFAULTS.perIpThreshold;
  const baseLockoutMs = options.baseLockoutMs ?? DEFAULTS.baseLockoutMs;
  const maxLockoutMs = options.maxLockoutMs ?? DEFAULTS.maxLockoutMs;
  const globalThreshold = options.globalThreshold ?? DEFAULTS.globalThreshold;
  const globalWindowMs = options.globalWindowMs ?? DEFAULTS.globalWindowMs;
  const now = options.now ?? Date.now;

  const ips = new Map<string, IpState>();
  // Sliding window of recent failure timestamps across all IPs (global floor).
  let globalFailures: number[] = [];

  const evictIdle = (t: number): void => {
    for (const [ip, st] of ips) {
      if (t - st.lastSeen > IDLE_EVICT_MS && st.lockedUntil <= t) ips.delete(ip);
    }
  };

  const trimGlobal = (t: number): void => {
    const cutoff = t - globalWindowMs;
    const oldest = globalFailures[0];
    if (oldest !== undefined && oldest < cutoff) {
      globalFailures = globalFailures.filter((ts) => ts >= cutoff);
    }
  };

  return {
    check(ip): ThrottleDecision {
      const t = now();
      evictIdle(t);
      const st = ips.get(ip);
      if (st !== undefined && st.lockedUntil > t) {
        return { allowed: false, retryAfterMs: st.lockedUntil - t };
      }
      trimGlobal(t);
      if (globalFailures.length >= globalThreshold) {
        const oldest = globalFailures[0] ?? t;
        return { allowed: false, retryAfterMs: Math.max(oldest + globalWindowMs - t, 1) };
      }
      return { allowed: true };
    },
    recordFailure(ip): void {
      const t = now();
      const st = ips.get(ip) ?? { failures: 0, lockedUntil: 0, lastSeen: t };
      st.failures += 1;
      st.lastSeen = t;
      if (st.failures >= perIpThreshold) {
        const over = st.failures - perIpThreshold; // 0 on the first lockout
        const lockout = Math.min(maxLockoutMs, baseLockoutMs * 2 ** over);
        st.lockedUntil = t + lockout;
      }
      ips.set(ip, st);
      globalFailures.push(t);
      trimGlobal(t);
    },
    recordSuccess(ip): void {
      ips.delete(ip);
    },
  };
}
