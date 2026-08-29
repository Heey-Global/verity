import type { PushReplyAction, PushReplyOutcome } from './response.js';

const DEFAULT_MAX_ATTEMPTS = 8;

/** One queued reply. `id` is a locally-minted `clientReplyId` — today it is only
 * the outbox's own dedup/identity key; once `POST /turns` accepts a
 * `clientReplyId` it becomes the server-side idempotency key too. */
export interface PushOutboxEntry {
  id: string;
  action: PushReplyAction;
  attempts: number;
  createdAt: number;
}

/** Durable, offline-surviving storage for the queue. The native layer backs this
 * with AsyncStorage; tests inject an in-memory map. */
export interface PushOutboxStorage {
  load(): Promise<PushOutboxEntry[]>;
  save(entries: PushOutboxEntry[]): Promise<void>;
}

export interface PushOutboxOptions {
  storage: PushOutboxStorage;
  /** Deliver one entry. `clientReplyId` is the entry's own id, threaded through so a
   * `send-turn` reply can carry it as the server-side idempotency key (ADR 0008). */
  perform: (action: PushReplyAction, clientReplyId: string) => Promise<PushReplyOutcome>;
  newId: () => string;
  now: () => number;
  /** Drop an entry after this many transient failures so a permanently
   * un-routable reply can't grow the queue forever. Defaults to 8. */
  maxAttempts?: number | undefined;
}

/** A persistent reply outbox for lock-screen quick replies. An operator can answer
 * a permission prompt while offline (or with the app killed); the reply is
 * persisted first, then flushed — on the spot and again when the app next
 * foregrounds. Every mutation runs on a single serialized chain, so a foreground
 * flush racing a fresh enqueue can never deliver the same entry twice. */
export interface PushOutbox {
  /** Persist without waiting for a network attempt (used before immediate UI navigation). */
  queue(action: PushReplyAction): Promise<void>;
  /** Persist a reply, then attempt to flush it immediately. */
  enqueue(action: PushReplyAction): Promise<void>;
  /** Attempt every pending entry once; drop the delivered/stale/exhausted ones. */
  flush(): Promise<void>;
  pending(): Promise<PushOutboxEntry[]>;
}

export function createPushOutbox(options: PushOutboxOptions): PushOutbox {
  const { storage, perform, newId, now } = options;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

  // Serialize all storage reads/writes AND every `perform` call. Delivering one
  // reply at a time is the point: it prevents a re-entrant flush (foreground +
  // enqueue firing together) from sending an entry that another flush is already
  // in the middle of sending.
  let tail: Promise<unknown> = Promise.resolve();
  function serialize<T>(task: () => Promise<T>): Promise<T> {
    const result = tail.then(task, task);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async function drain(): Promise<void> {
    const entries = await storage.load();
    if (entries.length === 0) return;
    const kept: PushOutboxEntry[] = [];
    for (const entry of entries) {
      let outcome: PushReplyOutcome;
      try {
        outcome = await perform(entry.action, entry.id);
      } catch {
        outcome = 'retry';
      }
      if (outcome === 'done' || outcome === 'stale') continue;
      const attempts = entry.attempts + 1;
      if (attempts >= maxAttempts) continue; // give up — drop rather than grow forever
      kept.push({ ...entry, attempts });
    }
    await storage.save(kept);
  }

  async function queue(action: PushReplyAction): Promise<void> {
    await serialize(async () => {
      const entries = await storage.load();
      entries.push({ id: newId(), action, attempts: 0, createdAt: now() });
      await storage.save(entries);
    });
  }

  return {
    queue,
    async enqueue(action) {
      await queue(action);
      await serialize(drain);
    },
    async flush() {
      await serialize(drain);
    },
    async pending() {
      return serialize(() => storage.load());
    },
  };
}
