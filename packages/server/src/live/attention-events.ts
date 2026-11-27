import { SERVER_ATTENTION_TOPIC } from '@verity/events';
import type { AttentionSignal } from '../attention.js';
import type { ServerContext } from '../server-context.js';
import { createRevisions } from './revisions.js';

/** How often the conditions are checked while an administrator watches. The
 * probes behind them refresh on their own schedule (the Updater every 15 s,
 * storage every minute), so a shorter period would only re-read their cache. */
export const SERVER_ATTENTION_CHECK_MS = 5_000;

/**
 * Publishes the server-level attention signals as `server.attention` (ADR
 * 0033): a sealed secret store, an Updater that does not answer, an unhealthy
 * usage probe, low storage. Home shows them above the session list.
 *
 * They are read from probes rather than announced where they change, so the
 * server checks them here, and only while someone follows the topic: one
 * check for every watching device instead of one per device and list read.
 * A list is published whenever it differs from the last one published. A
 * device reads the list when it subscribes; after a time nobody watched, the
 * first check publishes again, since the last list is no longer anyone's.
 */
export function installServerAttentionEvents(
  app: { log: { warn(obj: object, msg: string): void } },
  ctx: Pick<ServerContext, 'domainEvents' | 'lifecycle'>,
  collectAttention: () => Promise<AttentionSignal[]>,
  timers: {
    setInterval: (run: () => void, ms: number) => unknown;
    clearInterval: (timer: unknown) => void;
  } = {
    setInterval: (run, ms) => setInterval(run, ms).unref(),
    clearInterval: (timer) => clearInterval(timer as ReturnType<typeof setInterval>),
  },
): void {
  const { domainEvents, lifecycle } = ctx;
  const revisions = createRevisions();
  /** The list last published, while someone has watched since. */
  let published: string | undefined;
  let checking = false;
  let closed = false;

  const check = async (): Promise<void> => {
    if (!domainEvents.watching(SERVER_ATTENTION_TOPIC)) {
      // A new watcher reads the list itself; the next change goes out again.
      published = undefined;
      return;
    }
    if (checking) return;
    checking = true;
    try {
      // Taken before the probes run, so a later list orders after this one.
      const rev = revisions.next();
      const attention = await collectAttention();
      const key = JSON.stringify(attention);
      if (closed || key === published) return;
      published = key;
      domainEvents.publish(SERVER_ATTENTION_TOPIC, { t: 'server.attention', rev, attention });
    } catch (error) {
      app.log.warn({ err: error }, 'verity: server attention not published');
    } finally {
      checking = false;
    }
  };

  const timer = timers.setInterval(() => void check(), SERVER_ATTENTION_CHECK_MS);
  lifecycle.onClose(() => {
    closed = true;
    timers.clearInterval(timer);
  });
}
