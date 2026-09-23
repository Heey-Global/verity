/**
 * Caps how many turns may execute at once inside one project Sandbox.
 *
 * Every session of a project runs its agent in the SAME container, under one memory
 * limit. Under gVisor the whole guest is a single host process (the Sentry), and
 * gVisor has no guest OOM killer: when the guest's combined workload outgrows the
 * container's memory limit, the host kills the Sentry and every session in that
 * container dies at once. The per-session in-flight lock does not bound that — three
 * sessions each running one turn is three agents plus their builds and tests — so the
 * only lever that keeps a busy project below the limit is admitting fewer turns.
 *
 * FIFO per key, abortable while waiting. A slot is taken for the whole backend turn,
 * including an in-turn resume retry, and released exactly once.
 */
export class ProjectTurnGate {
  private readonly running = new Map<string, number>();
  private readonly waiters = new Map<string, (() => void)[]>();

  /** `limit` ≤ 0 or non-finite disables the gate. */
  constructor(private readonly limit: number) {}

  get enabled(): boolean {
    return Number.isFinite(this.limit) && this.limit > 0;
  }

  /** Turns currently holding a slot for `key`. */
  runningCount(key: string): number {
    return this.running.get(key) ?? 0;
  }

  /** Whether {@link acquire} for `key` would have to wait right now. */
  wouldWait(key: string): boolean {
    return (
      this.enabled &&
      (this.runningCount(key) >= this.limit || (this.waiters.get(key)?.length ?? 0) > 0)
    );
  }

  /**
   * Wait for a slot. Resolves with an idempotent release function, or `undefined` if
   * `signal` aborted first — the caller then has no slot and must not run the turn.
   * `onQueued` runs synchronously, only when the caller really has to wait.
   */
  async acquire(
    key: string,
    signal?: AbortSignal,
    onQueued?: () => void,
  ): Promise<(() => void) | undefined> {
    if (!this.enabled) return () => undefined;
    if (signal?.aborted === true) return undefined;
    if (!this.wouldWait(key)) return this.take(key);
    onQueued?.();
    return await new Promise<(() => void) | undefined>((resolve) => {
      const queue = this.waiters.get(key) ?? [];
      const wake = (): void => {
        signal?.removeEventListener('abort', onAbort);
        resolve(this.take(key));
      };
      const onAbort = (): void => {
        const current = this.waiters.get(key);
        const index = current?.indexOf(wake) ?? -1;
        if (current !== undefined && index >= 0) {
          current.splice(index, 1);
          if (current.length === 0) this.waiters.delete(key);
        }
        resolve(undefined);
      };
      queue.push(wake);
      this.waiters.set(key, queue);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  private take(key: string): () => void {
    this.running.set(key, this.runningCount(key) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = this.runningCount(key) - 1;
      if (remaining > 0) this.running.set(key, remaining);
      else this.running.delete(key);
      const queue = this.waiters.get(key);
      const next = queue?.shift();
      if (queue !== undefined && queue.length === 0) this.waiters.delete(key);
      next?.();
    };
  }
}
