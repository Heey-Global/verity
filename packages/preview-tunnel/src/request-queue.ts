type Release = () => void;

interface Waiter {
  admit(): void;
  reject(error: Error): void;
}

export class RequestQueueError extends Error {}

/** Admission happens before reading bodies; a burst must not become a body buffer. */
export class RequestQueue {
  private active = 0;
  private readonly pending = new Set<Waiter>();

  constructor(
    private readonly concurrency: number,
    private readonly capacity: number,
    private readonly timeoutMs: number,
  ) {}

  acquire(signal: AbortSignal): Release | Promise<Release> {
    signal.throwIfAborted();
    if (this.active < this.concurrency) return this.lease();
    if (this.pending.size >= this.capacity) {
      throw new RequestQueueError('Preview request queue is full. Try again shortly.');
    }
    return new Promise<Release>((resolve, reject) => {
      const cleanup = (): void => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        this.pending.delete(waiter);
      };
      const waiter: Waiter = {
        admit: () => {
          cleanup();
          resolve(this.lease());
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
      };
      const onAbort = (): void => waiter.reject(signal.reason as Error);
      const timer = setTimeout(
        () => waiter.reject(new RequestQueueError('Preview request queue wait expired.')),
        this.timeoutMs,
      );
      this.pending.add(waiter);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  cancelPending(error: Error): void {
    for (const waiter of this.pending) waiter.reject(error);
  }

  private lease(): Release {
    this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      this.pending.values().next().value?.admit();
    };
  }
}
