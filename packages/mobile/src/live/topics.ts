import {
  LIVE_MAX_TOPIC_SUBSCRIPTIONS,
  type DomainEvent,
  type DomainTopic,
  type LiveClientFrame,
  type TopicEndedReason,
  type TopicSubscription,
} from '@verity/events';

/** Where a topic's domain events go (ADR 0033). */
export interface LiveTopicSink {
  /** A change, in publication order. Apply it only when `event.rev` is newer
   * than the revision held for its entity. */
  event(event: DomainEvent): void;
  /** Events were missed and cannot be replayed (a server restart, a long
   * absence, a socket that fell behind). Read the topic's snapshots again;
   * events keep arriving after this. */
  resync(): void;
  /** The server refused or ended the topic for good, e.g. access was revoked. */
  ended?(reason: TopicEndedReason): void;
}

interface TopicEntry {
  /** Newest position received; replay after a reconnect resumes after it.
   * Undefined until the first event: the topic then starts live, and the
   * subscriber's own snapshot read covers what came before. */
  cursor: number | undefined;
  readonly sinks: Set<LiveTopicSink>;
}

/**
 * The client side of domain-event topics on the live connection. It holds one
 * server subscription per topic however many views listen, keeps the cursor
 * across reconnects so a drop costs no events, and turns `resync` into a
 * snapshot reload of every view that listens.
 *
 * Subscribe before reading a snapshot: an event published in between then
 * arrives after the read, and its revision decides whether it still applies.
 */
export class LiveTopics {
  private readonly topics = new Map<DomainTopic, TopicEntry>();
  /** Whether the connected server accepts topics (protocol 2). */
  supported = false;

  constructor(private readonly send: (frame: LiveClientFrame) => void) {}

  subscribe(topic: DomainTopic, sink: LiveTopicSink): () => void {
    let entry = this.topics.get(topic);
    if (entry === undefined) {
      entry = { cursor: undefined, sinks: new Set() };
      this.topics.set(topic, entry);
      if (this.supported) this.send({ k: 'topics.sub', topics: [{ topic }] });
    }
    entry.sinks.add(sink);
    const owner = entry;
    return () => {
      if (!owner.sinks.delete(sink) || owner.sinks.size > 0) return;
      if (this.topics.get(topic) !== owner) return;
      this.topics.delete(topic);
      if (this.supported) this.send({ k: 'topics.unsub', topics: [topic] });
    };
  }

  /** The connection is ready; resubscribe everything from its cursor. */
  ready(supported: boolean): void {
    this.supported = supported;
    if (!supported || this.topics.size === 0) return;
    const requests: TopicSubscription[] = [...this.topics].map(([topic, { cursor }]) =>
      cursor === undefined ? { topic } : { topic, cursor },
    );
    for (let i = 0; i < requests.length; i += LIVE_MAX_TOPIC_SUBSCRIPTIONS) {
      this.send({ k: 'topics.sub', topics: requests.slice(i, i + LIVE_MAX_TOPIC_SUBSCRIPTIONS) });
    }
    // Without a cursor nothing can be replayed: whatever changed while this
    // connection was not subscribed is only in a fresh snapshot.
    for (const entry of this.topics.values()) {
      if (entry.cursor !== undefined) continue;
      for (const sink of [...entry.sinks]) sink.resync();
    }
  }

  /** The connection dropped; nothing arrives until the next {@link ready}. */
  disconnected(): void {
    this.supported = false;
  }

  domain(topic: DomainTopic, cursor: number, event: DomainEvent): void {
    const entry = this.topics.get(topic);
    if (entry === undefined) return;
    // A replay overlapping what was already applied must not apply twice.
    if (entry.cursor !== undefined && cursor <= entry.cursor) return;
    entry.cursor = cursor;
    for (const sink of [...entry.sinks]) sink.event(event);
  }

  resync(topic: DomainTopic, cursor: number): void {
    const entry = this.topics.get(topic);
    if (entry === undefined) return;
    entry.cursor = cursor;
    for (const sink of [...entry.sinks]) sink.resync();
  }

  ended(topic: DomainTopic, reason: TopicEndedReason): void {
    const entry = this.topics.get(topic);
    if (entry === undefined) return;
    this.topics.delete(topic);
    for (const sink of [...entry.sinks]) sink.ended?.(reason);
  }
}
