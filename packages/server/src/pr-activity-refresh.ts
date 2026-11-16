interface Entry {
  lastStarted: number;
  dirty: boolean;
  immediate: boolean;
  running?: Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
}

/** Tool results can open another PR long before the enclosing turn completes. */
export function createPrActivityRefresh(options: {
  refresh(sessionId: string): Promise<void>;
  onError(error: unknown, sessionId: string): void;
}) {
  const entries = new Map<string, Entry>();
  let closed = false;
  const schedule = (sessionId: string, entry: Entry): void => {
    if (closed || entry.running || entry.timer || !entry.dirty) return;
    const delay = entry.immediate ? 0 : Math.max(0, entry.lastStarted + 30_000 - Date.now());
    entry.timer = setTimeout(() => {
      delete entry.timer;
      if (closed) return;
      entry.dirty = false;
      entry.immediate = false;
      entry.lastStarted = Date.now();
      entry.running = Promise.resolve()
        .then(() => options.refresh(sessionId))
        .catch((error: unknown) => options.onError(error, sessionId))
        .finally(() => {
          delete entry.running;
          if (closed) return;
          if (entry.dirty) schedule(sessionId, entry);
          else {
            // Forget inactive sessions after the throttle window.
            entry.timer = setTimeout(() => entries.delete(sessionId), 30_000);
            entry.timer.unref();
          }
        });
    }, delay);
    entry.timer.unref();
  };
  const notify = (sessionId: string, immediate = false): void => {
    if (closed) return;
    let entry = entries.get(sessionId);
    if (!entry) {
      entry = { lastStarted: -Infinity, dirty: false, immediate: false };
      entries.set(sessionId, entry);
    }
    if (entry.timer) {
      clearTimeout(entry.timer);
      delete entry.timer;
    }
    entry.dirty = true;
    entry.immediate ||= immediate;
    schedule(sessionId, entry);
  };
  return {
    notify,
    async close(): Promise<void> {
      closed = true;
      for (const entry of entries.values()) clearTimeout(entry.timer);
      await Promise.all(
        [...entries.values()].flatMap((entry) => (entry.running ? [entry.running] : [])),
      );
      entries.clear();
    },
  };
}
