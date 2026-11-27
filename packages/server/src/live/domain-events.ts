import {
  parseDomainTopic,
  type DomainEvent,
  type DomainTopic,
  type DomainTopicKind,
} from '@verity/events';
import { randomUUID } from 'node:crypto';

/** One published event and its position. */
export interface DomainRecord {
  readonly topic: DomainTopic;
  readonly cursor: number;
  readonly event: DomainEvent;
}

export type DomainListener = (record: DomainRecord) => void;

/** What a subscriber missed since its cursor: the records to replay, or `gap`
 * when the bus no longer holds all of them and the subscriber must read its
 * snapshots again. `head` is the position the subscription continues from. */
export type DomainReplay =
  | { kind: 'replay'; records: readonly DomainRecord[]; head: number }
  | { kind: 'gap'; head: number };

interface TopicLog {
  records: { record: DomainRecord; at: number }[];
  /** Cursor of the newest record this topic dropped (or the bus origin):
   * anything at or before it cannot be replayed. */
  floor: number;
  listeners: Set<DomainListener>;
}

export interface DomainEventBusOptions {
  /** Records kept per topic. */
  perTopic?: number;
  /** Age after which records are dropped. */
  retentionMs?: number;
  /** Topics kept at once; the least recently used idle topic goes first. */
  maxTopics?: number;
  now?: () => number;
}

/**
 * The process-local domain event bus (ADR 0033), beside the session event bus
 * in `packages/session/src/bus.ts`. Publishers announce overview changes where
 * they happen; live connections subscribe per topic and replay what a client
 * missed while it was away.
 *
 * Cursors are positions in one sequence shared by every topic, valid within
 * one {@link epoch}. A client that kept cursors from an earlier server process
 * sees a different epoch in `ready` and drops them. As a second line, the
 * sequence starts from the wall clock in microseconds, so an old cursor that
 * still arrives is below this process's origin and answers `gap` rather than
 * a silently incomplete replay — unless the clock stepped back.
 */
export class DomainEventBus {
  /** Identifies this bus's cursor sequence; announced in `ready`. */
  readonly epoch = randomUUID();
  private readonly topics = new Map<DomainTopic, TopicLog>();
  private readonly perTopic: number;
  private readonly retentionMs: number;
  private readonly maxTopics: number;
  private readonly now: () => number;
  private readonly origin: number;
  private last: number;
  /** Highest floor of a topic that was forgotten entirely. */
  private forgottenFloor: number;

  constructor(options: DomainEventBusOptions = {}) {
    this.perTopic = options.perTopic ?? 256;
    this.retentionMs = options.retentionMs ?? 10 * 60_000;
    this.maxTopics = options.maxTopics ?? 4_096;
    this.now = options.now ?? Date.now;
    this.origin = this.now() * 1_000;
    this.last = this.origin;
    this.forgottenFloor = this.origin;
  }

  /** The newest cursor handed out. */
  get head(): number {
    return this.last;
  }

  publish(topic: DomainTopic, event: DomainEvent): DomainRecord {
    const log = this.log(topic);
    this.last += 1;
    const record: DomainRecord = { topic, cursor: this.last, event };
    log.records.push({ record, at: this.now() });
    this.trim(log);
    // Snapshot so a listener that (un)subscribes during dispatch cannot mutate
    // the set mid-iteration; a throwing listener must not stop the others.
    for (const listener of [...log.listeners]) {
      try {
        listener(record);
      } catch {
        // Delivery problems belong to the subscriber, never to the publisher.
      }
    }
    return record;
  }

  /** Ids of the topics of `kind` someone subscribes to right now: what a
   * server-side checker of an outside source needs to look at. */
  watched(kind: DomainTopicKind): string[] {
    const ids: string[] = [];
    for (const [topic, log] of this.topics) {
      if (log.listeners.size === 0) continue;
      const parsed = parseDomainTopic(topic);
      if (parsed?.kind === kind) ids.push(parsed.id);
    }
    return ids;
  }

  /** Whether someone subscribes to `topic` right now. */
  watching(topic: DomainTopic): boolean {
    return (this.topics.get(topic)?.listeners.size ?? 0) > 0;
  }

  /**
   * Subscribe to a topic, replaying from `cursor` when given. Replay and
   * subscription happen in one synchronous step, so no record published in
   * between is lost or delivered twice.
   */
  subscribe(
    topic: DomainTopic,
    cursor: number | undefined,
    listener: DomainListener,
  ): { replay: DomainReplay; unsubscribe: () => void } {
    const log = this.log(topic);
    this.trim(log);
    const replay = this.replayFrom(log, cursor);
    log.listeners.add(listener);
    return {
      replay,
      unsubscribe: () => {
        log.listeners.delete(listener);
      },
    };
  }

  private replayFrom(log: TopicLog, cursor: number | undefined): DomainReplay {
    const head = this.last;
    if (cursor === undefined) return { kind: 'replay', records: [], head };
    if (cursor > head || cursor < log.floor) return { kind: 'gap', head };
    return {
      kind: 'replay',
      records: log.records
        .filter(({ record }) => record.cursor > cursor)
        .map(({ record }) => record),
      head,
    };
  }

  private log(topic: DomainTopic): TopicLog {
    let log = this.topics.get(topic);
    if (log === undefined) {
      this.evictIfFull();
      // A topic seen for the first time cannot replay anything published while
      // it was forgotten; it starts at the highest floor the bus dropped.
      log = { records: [], floor: this.forgottenFloor, listeners: new Set() };
      this.topics.set(topic, log);
    } else {
      // Map order doubles as recency for eviction.
      this.topics.delete(topic);
      this.topics.set(topic, log);
    }
    return log;
  }

  private trim(log: TopicLog): void {
    const oldest = this.now() - this.retentionMs;
    let drop = Math.max(0, log.records.length - this.perTopic);
    while (drop < log.records.length && log.records[drop]!.at < oldest) drop += 1;
    if (drop === 0) return;
    log.floor = log.records[drop - 1]!.record.cursor;
    log.records.splice(0, drop);
  }

  private evictIfFull(): void {
    if (this.topics.size < this.maxTopics) return;
    for (const [topic, log] of this.topics) {
      if (log.listeners.size > 0) continue;
      this.forgottenFloor = Math.max(
        this.forgottenFloor,
        log.records.at(-1)?.record.cursor ?? log.floor,
      );
      this.topics.delete(topic);
      return;
    }
  }
}
