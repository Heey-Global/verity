import type { SequencedEvent } from '@verity/store';
import { describe, expect, it } from 'vitest';
import { InMemoryEventBus } from './bus.js';

const text: SequencedEvent = { seq: 1, ts: 1000, event: { t: 'text', delta: 'hi' } };
const other: SequencedEvent = { seq: 2, ts: 2000, event: { t: 'text', delta: 'bye' } };

describe('InMemoryEventBus', () => {
  it('delivers published events to a session subscriber', () => {
    const bus = new InMemoryEventBus();
    const got: SequencedEvent[] = [];
    bus.subscribe('s1', (e) => got.push(e));
    bus.publish('s1', text);
    expect(got).toEqual([text]);
  });

  it('isolates sessions — a subscriber only sees its own session', () => {
    const bus = new InMemoryEventBus();
    const s1: SequencedEvent[] = [];
    bus.subscribe('s1', (e) => s1.push(e));
    bus.publish('s2', other); // different session
    expect(s1).toEqual([]);
  });

  it('fans out to multiple subscribers', () => {
    const bus = new InMemoryEventBus();
    const a: SequencedEvent[] = [];
    const b: SequencedEvent[] = [];
    bus.subscribe('s1', (e) => a.push(e));
    bus.subscribe('s1', (e) => b.push(e));
    bus.publish('s1', text);
    expect(a).toEqual([text]);
    expect(b).toEqual([text]);
  });

  it('stops delivering after unsubscribe', () => {
    const bus = new InMemoryEventBus();
    const got: SequencedEvent[] = [];
    const off = bus.subscribe('s1', (e) => got.push(e));
    bus.publish('s1', text);
    off();
    bus.publish('s1', other);
    expect(got).toEqual([text]);
  });

  it('publish to a session with no subscribers is a no-op', () => {
    const bus = new InMemoryEventBus();
    expect(() => bus.publish('nobody', text)).not.toThrow();
  });

  it('observes every session without requiring a session subscriber', () => {
    const bus = new InMemoryEventBus();
    const got: Array<{ sessionId: string; event: SequencedEvent }> = [];
    const off = bus.subscribeAll((sessionId, event) => got.push({ sessionId, event }));

    bus.publish('s1', text);
    bus.publish('s2', other);
    off();
    bus.publish('s3', text);

    expect(got).toEqual([
      { sessionId: 's1', event: text },
      { sessionId: 's2', event: other },
    ]);
  });

  it('isolates a throwing global observer from listeners and other observers', () => {
    const bus = new InMemoryEventBus();
    const listener: SequencedEvent[] = [];
    const observed: SequencedEvent[] = [];
    bus.subscribe('s1', (event) => listener.push(event));
    bus.subscribeAll(() => {
      throw new Error('bad observer');
    });
    bus.subscribeAll((_sessionId, event) => observed.push(event));

    expect(() => bus.publish('s1', text)).not.toThrow();
    expect(listener).toEqual([text]);
    expect(observed).toEqual([text]);
  });

  it('isolates a throwing listener — others still receive, publish does not throw', () => {
    const bus = new InMemoryEventBus();
    const got: SequencedEvent[] = [];
    bus.subscribe('s1', () => {
      throw new Error('bad subscriber');
    });
    bus.subscribe('s1', (e) => got.push(e));
    expect(() => bus.publish('s1', text)).not.toThrow();
    expect(got).toEqual([text]);
  });

  it('a listener that unsubscribes during dispatch does not corrupt the fan-out', () => {
    const bus = new InMemoryEventBus();
    const got: SequencedEvent[] = [];
    const off = bus.subscribe('s1', () => off()); // unsubscribes itself mid-dispatch
    bus.subscribe('s1', (e) => got.push(e));
    expect(() => bus.publish('s1', text)).not.toThrow();
    expect(got).toEqual([text]);
  });

  it('a listener subscribed mid-dispatch does not receive the current event (snapshot)', () => {
    const bus = new InMemoryEventBus();
    const late: SequencedEvent[] = [];
    bus.subscribe('s1', () => {
      bus.subscribe('s1', (e) => late.push(e)); // added during dispatch
    });
    bus.publish('s1', text);
    expect(late).toEqual([]); // missed THIS event (dispatch snapshot)
    bus.publish('s1', other);
    expect(late).toEqual([other]); // receives the next one
  });
});
