import {
  LIVE_MAX_TOPIC_SUBSCRIPTIONS,
  type DomainTopic,
  type LiveServerFrame,
  type TopicEndedReason,
  type TopicSubscription,
} from '@verity/events';
import type { DomainEventBus, DomainRecord } from './domain-events.js';

const DRAIN_CHECK_MS = 250;
/** Records one topic may hold waiting for its filter. Beyond it the client
 * reads its snapshot instead: a filter that hangs must not grow server memory. */
const MAX_PENDING_RECORDS = 256;

interface Subscription {
  cancelled: boolean;
  /** Records were dropped while the socket was behind; the client has been
   * told to read its snapshots again. */
  behind: boolean;
  unsubscribe: () => void;
  /** Records waiting for an asynchronous `filter`, in order. */
  queue: Promise<void> | undefined;
  pending: number;
  /** Records were dropped because the queue was full. */
  overflowed: boolean;
}

export interface TopicSubscriptionsOptions {
  bus: DomainEventBus;
  /** Whether this connection may read the topic now — the policy of the HTTP
   * read that serves the same state. */
  canRead(topic: DomainTopic): Promise<boolean>;
  /** Whether missed records of a topic may be replayed from a cursor; when
   * not, the client reads its snapshot instead. Defaults to true. */
  replayable?: ((topic: DomainTopic) => boolean) | undefined;
  send(frame: LiveServerFrame): boolean;
  /** True while the socket holds more unsent bytes than it should. */
  overBudget(): boolean;
  /** Whether this connection receives a record of a topic it holds: a
   * collection topic carries entities each subscriber may or may not read.
   * May answer asynchronously; records stay in order either way. */
  filter?: ((record: DomainRecord) => boolean | Promise<boolean>) | undefined;
  logger?: { warn(obj: object, msg: string): void } | undefined;
}

/** The domain-event topics one live connection holds (ADR 0033). */
export class TopicSubscriptions {
  private readonly subscriptions = new Map<DomainTopic, Subscription>();
  private drainTimer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly opts: TopicSubscriptionsOptions) {}

  get size(): number {
    return this.subscriptions.size;
  }

  async subscribe(requests: readonly TopicSubscription[]): Promise<void> {
    await Promise.all(requests.map((request) => this.subscribeOne(request)));
  }

  private async subscribeOne({ topic, cursor }: TopicSubscription): Promise<void> {
    // A resubscription (after reconnecting, or with a new cursor) starts over.
    this.unsubscribe([topic]);
    if (this.subscriptions.size >= LIVE_MAX_TOPIC_SUBSCRIPTIONS) {
      this.opts.send({ k: 'topic_ended', topic, reason: 'limit' });
      return;
    }
    const sub: Subscription = {
      cancelled: false,
      behind: false,
      unsubscribe: () => undefined,
      queue: undefined,
      pending: 0,
      overflowed: false,
    };
    // Registered before the first await so a quick `topics.unsub` finds it.
    this.subscriptions.set(topic, sub);
    let allowed: boolean;
    try {
      allowed = await this.opts.canRead(topic);
    } catch (error) {
      this.opts.logger?.warn({ err: error, topic }, 'verity: live topic authorization failed');
      this.end(topic, sub, 'error');
      return;
    }
    if (sub.cancelled) return;
    if (!allowed) {
      this.end(topic, sub, 'forbidden');
      return;
    }
    const { replay, unsubscribe } = this.opts.bus.subscribe(topic, cursor, (record) =>
      this.deliver(sub, record),
    );
    sub.unsubscribe = unsubscribe;
    // Without a cursor the client holds no position, and with a gap its
    // position is lost: either way it reads its snapshot now that the
    // subscription is live, so nothing published before this point is missed.
    if (cursor === undefined || replay.kind === 'gap' || this.opts.replayable?.(topic) === false) {
      this.opts.send({ k: 'resync', topic, cursor: replay.head });
      return;
    }
    for (const record of replay.records) this.deliver(sub, record);
  }

  private deliver(sub: Subscription, record: DomainRecord): void {
    if (sub.cancelled) return;
    const filter = this.opts.filter;
    if (filter === undefined) {
      this.send(sub, record);
      return;
    }
    const decide = (): boolean | Promise<boolean> => {
      try {
        return filter(record);
      } catch (error) {
        this.undecided(sub, record, error);
        return false;
      }
    };
    if (sub.pending === 0) {
      const verdict = decide();
      if (typeof verdict === 'boolean') {
        if (verdict) this.send(sub, record);
        return;
      }
      this.enqueue(sub, record, () => verdict);
      return;
    }
    // Behind an answer still on its way: wait for it, so records stay in order.
    this.enqueue(sub, record, decide);
  }

  private enqueue(
    sub: Subscription,
    record: DomainRecord,
    decide: () => boolean | Promise<boolean>,
  ): void {
    if (sub.pending >= MAX_PENDING_RECORDS) {
      // At once, not only once drained: a filter that hangs for good would
      // otherwise leave the client unaware that it is missing records.
      if (!sub.overflowed) {
        sub.overflowed = true;
        // Inside the publisher's call: a send that throws must not reach it.
        this.trySend({ k: 'resync', topic: record.topic, cursor: record.cursor });
      }
      return;
    }
    sub.pending += 1;
    sub.queue = (sub.queue ?? Promise.resolve())
      .then(async () => {
        let allowed = false;
        try {
          allowed = await decide();
        } catch (error) {
          this.undecided(sub, record, error);
        }
        // A failing send must not reject the queue: every later record of
        // the topic waits on it.
        try {
          if (allowed) this.send(sub, record);
        } catch (error) {
          this.opts.logger?.warn(
            { err: error, topic: record.topic },
            'verity: live delivery failed',
          );
        }
      })
      .finally(() => {
        sub.pending -= 1;
        if (sub.pending === 0) {
          sub.queue = undefined;
          // Records dropped meanwhile may be newer than the snapshot the client
          // read: once more, now that the queue drained.
          if (sub.overflowed && !sub.cancelled) {
            sub.overflowed = false;
            this.trySend({ k: 'resync', topic: record.topic, cursor: this.opts.bus.head });
          }
        }
      });
  }

  /** Withheld, not sent: a record the connection may not read stays unsent.
   * The client may have needed it, so it reads its snapshot again. */
  private undecided(sub: Subscription, record: DomainRecord, error: unknown): void {
    this.opts.logger?.warn({ err: error, topic: record.topic }, 'verity: live filter failed');
    if (!sub.cancelled) this.trySend({ k: 'resync', topic: record.topic, cursor: record.cursor });
  }

  /** A send from the filter queue: one that throws must not reject the queue
   * every later record of the topic waits on. */
  private trySend(frame: LiveServerFrame): void {
    try {
      this.opts.send(frame);
    } catch (error) {
      this.opts.logger?.warn({ err: error }, 'verity: live delivery failed');
    }
  }

  private send(sub: Subscription, record: DomainRecord): void {
    if (sub.cancelled) return;
    if (this.opts.overBudget()) {
      // Holding domain frames for a socket that cannot keep up would let one
      // slow device grow server memory; it reads snapshots instead.
      if (!sub.behind) {
        sub.behind = true;
        this.opts.send({ k: 'resync', topic: record.topic, cursor: record.cursor });
        this.watchDrain();
      }
      return;
    }
    if (sub.behind) {
      // Records dropped after the first resync may be newer than the snapshot
      // the client read for it; ask once more now that the socket keeps up.
      sub.behind = false;
      this.opts.send({ k: 'resync', topic: record.topic, cursor: record.cursor - 1 });
    }
    this.opts.send({
      k: 'domain',
      topic: record.topic,
      cursor: record.cursor,
      event: record.event,
    });
  }

  /** Once the socket keeps up again, ask every topic that dropped records for
   * one more snapshot: records dropped after the first resync may be newer
   * than what the client read then, and the topic may stay quiet afterwards. */
  private watchDrain(): void {
    if (this.drainTimer !== undefined) return;
    this.drainTimer = setInterval(() => {
      if (this.opts.overBudget()) return;
      this.stopDrainWatch();
      for (const [topic, sub] of this.subscriptions) {
        if (!sub.behind || sub.cancelled) continue;
        sub.behind = false;
        this.opts.send({ k: 'resync', topic, cursor: this.opts.bus.head });
      }
    }, DRAIN_CHECK_MS);
    this.drainTimer.unref?.();
  }

  private stopDrainWatch(): void {
    clearInterval(this.drainTimer);
    this.drainTimer = undefined;
  }

  unsubscribe(topics: readonly DomainTopic[]): void {
    for (const topic of topics) {
      const sub = this.subscriptions.get(topic);
      if (sub === undefined) continue;
      this.subscriptions.delete(topic);
      sub.cancelled = true;
      sub.unsubscribe();
    }
  }

  /** End every topic this connection may no longer read. Access can change
   * while a socket stays open; a read granted at subscribe time is not
   * granted forever. */
  async recheck(): Promise<void> {
    await Promise.all(
      [...this.subscriptions].map(async ([topic, sub]) => {
        let allowed: boolean;
        try {
          allowed = await this.opts.canRead(topic);
        } catch (error) {
          // Fail closed: this runs when access may just have been revoked. The
          // client retries an `error` ending, which authorizes again.
          this.opts.logger?.warn({ err: error, topic }, 'verity: live topic recheck failed');
          this.end(topic, sub, 'error');
          return;
        }
        if (!allowed) this.end(topic, sub, 'forbidden');
      }),
    );
  }

  dispose(): void {
    this.stopDrainWatch();
    this.unsubscribe([...this.subscriptions.keys()]);
  }

  private end(topic: DomainTopic, sub: Subscription, reason: TopicEndedReason): void {
    if (this.subscriptions.get(topic) !== sub) return;
    this.subscriptions.delete(topic);
    sub.cancelled = true;
    sub.unsubscribe();
    this.opts.send({ k: 'topic_ended', topic, reason });
  }
}
