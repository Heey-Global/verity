import type { DomainEvent } from '@verity/events';
import { describe, expect, it } from 'vitest';
import { DomainEventBus, type DomainRecord } from './domain-events.js';

const update = (rev: number): DomainEvent => ({
  t: 'sandbox.update',
  projectId: 'p1',
  rev,
  available: rev % 2 === 0,
});

describe('DomainEventBus', () => {
  it('replays what a subscriber missed after its cursor, in order, once', () => {
    const bus = new DomainEventBus({ now: () => 1_000 });
    const first = bus.publish('project:p1', update(1));
    bus.publish('project:p1', update(2));
    bus.publish('project:p2', update(3));
    const seen: DomainRecord[] = [];
    const { replay } = bus.subscribe('project:p1', first.cursor, (record) => seen.push(record));
    expect(replay.kind).toBe('replay');
    expect(replay.kind === 'replay' && replay.records.map((r) => r.event)).toEqual([update(2)]);
    bus.publish('project:p1', update(4));
    expect(seen.map((r) => r.event)).toEqual([update(4)]);
  });

  it('starts live without replay when the subscriber holds no cursor', () => {
    const bus = new DomainEventBus();
    bus.publish('project:p1', update(1));
    const { replay } = bus.subscribe('project:p1', undefined, () => undefined);
    expect(replay).toEqual({ kind: 'replay', records: [], head: bus.head });
  });

  it('answers gap for a cursor from an earlier server process', () => {
    // A client keeps its cursor across a server restart. Replaying from it
    // would silently skip everything the old process published last.
    let now = 1_000;
    const before = new DomainEventBus({ now: () => now });
    const old = before.publish('project:p1', update(1));
    now = 2_000;
    const after = new DomainEventBus({ now: () => now });
    after.publish('project:p1', update(2));
    expect(after.subscribe('project:p1', old.cursor, () => undefined).replay.kind).toBe('gap');
    // A cursor the bus never handed out is just as unusable.
    expect(after.subscribe('project:p1', after.head + 5, () => undefined).replay.kind).toBe('gap');
  });

  it('answers gap once the records after a cursor were dropped', () => {
    const bus = new DomainEventBus({ perTopic: 2 });
    const first = bus.publish('project:p1', update(1));
    bus.publish('project:p1', update(2));
    bus.publish('project:p1', update(3));
    bus.publish('project:p1', update(4));
    expect(bus.subscribe('project:p1', first.cursor, () => undefined).replay.kind).toBe('gap');
    const third = bus.head - 1;
    const recent = bus.subscribe('project:p1', third, () => undefined).replay;
    expect(recent.kind === 'replay' && recent.records.map((r) => r.event)).toEqual([update(4)]);
  });

  it('drops records older than the retention window', () => {
    let now = 0;
    const bus = new DomainEventBus({ retentionMs: 1_000, now: () => now });
    const first = bus.publish('project:p1', update(1));
    now = 5_000;
    bus.publish('project:p1', update(2));
    expect(bus.subscribe('project:p1', first.cursor - 1, () => undefined).replay.kind).toBe('gap');
  });

  it('does not let a forgotten topic replay an incomplete history', () => {
    const bus = new DomainEventBus({ maxTopics: 1 });
    const kept = bus.publish('project:p1', update(1));
    bus.publish('project:p1', update(2));
    // p1 has no subscriber, so a second topic evicts it with its records.
    bus.publish('project:p2', update(3));
    expect(bus.subscribe('project:p1', kept.cursor, () => undefined).replay.kind).toBe('gap');
  });

  it('keeps delivering when one listener throws', () => {
    const bus = new DomainEventBus();
    const seen: number[] = [];
    bus.subscribe('project:p1', undefined, () => {
      throw new Error('broken view');
    });
    bus.subscribe('project:p1', undefined, (record) => seen.push(record.cursor));
    const record = bus.publish('project:p1', update(1));
    expect(seen).toEqual([record.cursor]);
  });

  it('stops delivering after unsubscribe', () => {
    const bus = new DomainEventBus();
    const seen: number[] = [];
    const { unsubscribe } = bus.subscribe('project:p1', undefined, (r) => seen.push(r.cursor));
    unsubscribe();
    bus.publish('project:p1', update(1));
    expect(seen).toEqual([]);
  });
});
