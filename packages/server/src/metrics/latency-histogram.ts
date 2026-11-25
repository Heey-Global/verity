/**
 * A fixed-bucket latency histogram. Constant memory per series, so a busy route
 * costs no more than a quiet one; quantiles are estimated by interpolating
 * inside the bucket that holds them, which is accurate enough to tell 50 ms
 * from 500 ms and costs nothing per request beyond one array increment.
 */
const LATENCY_BUCKETS_MS: readonly number[] = [
  5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 30_000,
];

export class LatencyHistogram {
  /** One slot per bucket plus an overflow slot. */
  private readonly counts = new Array<number>(LATENCY_BUCKETS_MS.length + 1).fill(0);
  count = 0;
  sumMs = 0;
  maxMs = 0;

  observe(ms: number): void {
    let index = LATENCY_BUCKETS_MS.findIndex((bound) => ms <= bound);
    if (index === -1) index = LATENCY_BUCKETS_MS.length;
    this.counts[index]! += 1;
    this.count += 1;
    this.sumMs += ms;
    if (ms > this.maxMs) this.maxMs = ms;
  }

  merge(other: LatencyHistogram): void {
    other.counts.forEach((value, index) => (this.counts[index]! += value));
    this.count += other.count;
    this.sumMs += other.sumMs;
    this.maxMs = Math.max(this.maxMs, other.maxMs);
  }

  /** Estimated `q` quantile in milliseconds (0 < q ≤ 1), or null without samples. */
  quantile(q: number): number | null {
    if (this.count === 0) return null;
    const rank = q * this.count;
    let seen = 0;
    for (let index = 0; index < this.counts.length; index += 1) {
      const inBucket = this.counts[index]!;
      if (inBucket === 0 || seen + inBucket < rank) {
        seen += inBucket;
        continue;
      }
      const lower = index === 0 ? 0 : LATENCY_BUCKETS_MS[index - 1]!;
      const upper = LATENCY_BUCKETS_MS[index] ?? this.maxMs;
      const estimate = lower + ((rank - seen) / inBucket) * (upper - lower);
      return Math.round(Math.min(estimate, this.maxMs));
    }
    return Math.round(this.maxMs);
  }
}
