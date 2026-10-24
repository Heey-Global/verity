/** Separate from request admission: disconnected visitors must not occupy upstream slots. */
export class ReconnectWait<T> {
  private readonly pending = new Set<{ wake(): void; reject(error: Error): void }>();
  private stopped: Error | undefined;

  constructor(
    private readonly current: () => T | undefined,
    private readonly capacity: number,
  ) {}

  wait(deadline: number, signal: AbortSignal): Promise<T> {
    signal.throwIfAborted();
    if (this.stopped) return Promise.reject(this.stopped);
    const current = this.current();
    if (current !== undefined) return Promise.resolve(current);
    if (performance.now() >= deadline) return Promise.reject(new ReconnectTimeout());
    if (this.pending.size >= this.capacity) return Promise.reject(new ReconnectFull());
    return new Promise((resolve, reject) => {
      const cleanup = (): void => {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        this.pending.delete(waiter);
      };
      const waiter = {
        wake: (): void => {
          if (performance.now() >= deadline) {
            waiter.reject(new ReconnectTimeout());
            return;
          }
          const value = this.current();
          if (value === undefined) return;
          cleanup();
          resolve(value);
        },
        reject: (error: Error): void => {
          cleanup();
          reject(error);
        },
      };
      const abort = (): void => waiter.reject(signal.reason as Error);
      const timer = setTimeout(
        () => waiter.reject(new ReconnectTimeout()),
        deadline - performance.now(),
      );
      this.pending.add(waiter);
      signal.addEventListener('abort', abort, { once: true });
    });
  }

  notify(): void {
    for (const waiter of this.pending) waiter.wake();
  }

  stop(error: Error): void {
    this.stopped = error;
    for (const waiter of this.pending) waiter.reject(error);
  }
}

export class ReconnectTimeout extends Error {}
export class ReconnectFull extends Error {}
