interface PreviewRead {
  read: (signal: AbortSignal) => Promise<void>;
  dirty: boolean;
  queued: boolean;
  generation: number;
  controller?: AbortController;
}

/** Bounds logical preview work, including reads waiting in the transport lane. */
export class PreviewReadScheduler {
  private readonly entries = new Map<string, PreviewRead>();
  private active = false;
  private running = 0;
  private publication: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly publish: () => void) {}

  add(key: string, read: PreviewRead['read']): void {
    this.entries.set(key, { read, dirty: true, queued: this.active, generation: 0 });
    this.drain();
  }

  remove(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.generation++;
    entry.controller?.abort();
    this.entries.delete(key);
  }

  invalidate(key?: string): void {
    for (const [path, entry] of this.entries) {
      if (key !== undefined && path !== key) continue;
      entry.dirty = true;
      entry.queued = this.active;
    }
    this.drain();
  }

  setActive(active: boolean, reliable = true): void {
    this.active = active;
    if (!active) {
      clearTimeout(this.publication);
      this.publication = undefined;
      for (const entry of this.entries.values()) {
        entry.queued = false;
        if (entry.controller) {
          entry.dirty = true;
          entry.generation++;
          entry.controller.abort();
        }
      }
      return;
    }
    for (const entry of this.entries.values()) {
      if (!reliable) entry.dirty = true;
      if (entry.dirty) entry.queued = true;
    }
    this.schedulePublication();
    this.drain();
  }

  stop(): void {
    this.setActive(false);
    for (const key of this.entries.keys()) this.remove(key);
  }

  private schedulePublication(): void {
    if (!this.active || this.publication !== undefined) return;
    // Promise completions in the same turn produce one overview publication.
    this.publication = setTimeout(() => {
      this.publication = undefined;
      if (this.active) this.publish();
    }, 0);
  }

  private drain(): void {
    if (!this.active) return;
    for (const entry of this.entries.values()) {
      if (this.running >= 2) break;
      if (!entry.queued || entry.controller) continue;
      entry.queued = false;
      entry.dirty = false;
      const generation = ++entry.generation;
      const controller = new AbortController();
      entry.controller = controller;
      this.running++;
      void Promise.resolve()
        .then(() => {
          if (controller.signal.aborted) return;
          return entry.read(controller.signal);
        })
        .then(() => {
          if (generation === entry.generation && !controller.signal.aborted)
            this.schedulePublication();
        })
        .catch(() => {
          // Retry on the next invalidation or focus, not an unbounded error loop.
          entry.dirty = true;
        })
        .finally(() => {
          entry.controller = undefined;
          this.running--;
          this.drain();
        });
    }
  }
}
