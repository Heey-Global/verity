/** Process-local capture coordination. The Server's PostgreSQL process fence excludes another writer. */
export class BackupLifecycleCoordinator {
  private tail: Promise<void> = Promise.resolve();
  private readonly readers = new Map<string, number>();
  private readonly waiters = new Map<string, Set<() => void>>();

  private async exclusive<T>(action: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await action();
    } finally {
      release();
    }
  }

  /** Inventory, DB snapshot opening and Git freeze run under the same lifecycle barrier. */
  async beginCapture<T>(
    start: () => Promise<{ projectIds: string[]; value: T }>,
  ): Promise<{ value: T; release: () => void }> {
    return this.exclusive(async () => {
      const { projectIds, value } = await start();
      const ids = [...new Set(projectIds)];
      for (const id of ids) this.readers.set(id, (this.readers.get(id) ?? 0) + 1);
      let released = false;
      return {
        value,
        release: () => {
          if (released) return;
          released = true;
          for (const id of ids) {
            const count = this.readers.get(id)! - 1;
            if (count > 0) this.readers.set(id, count);
            else {
              this.readers.delete(id);
              for (const resolve of this.waiters.get(id) ?? []) resolve();
              this.waiters.delete(id);
            }
          }
        },
      };
    });
  }

  /** Every destructive project/mount operation must enter here before touching captured paths. */
  async mutate<T>(projectIds: string[], action: () => Promise<T>): Promise<T> {
    for (;;) {
      const result = await this.exclusive(async () => {
        const busy = [...new Set(projectIds)].filter((id) => this.readers.has(id));
        if (!busy.length) return { value: await action() };
        return {
          wait: Promise.all(
            busy.map(
              (id) =>
                new Promise<void>((resolve) => {
                  const waiting = this.waiters.get(id) ?? new Set<() => void>();
                  waiting.add(resolve);
                  this.waiters.set(id, waiting);
                }),
            ),
          ),
        };
      });
      if ('value' in result) return result.value;
      // Waiting inside the barrier deadlocks a capture that needs to re-freeze Git.
      // Recheck under the barrier after waking: another capture may have acquired a lease.
      await result.wait;
    }
  }

  /** A Git re-freeze uses existing project leases and briefly re-enters the lifecycle barrier. */
  async refreeze<T>(action: () => Promise<T>): Promise<T> {
    return this.exclusive(action);
  }
}

export const backupLifecycle = new BackupLifecycleCoordinator();
