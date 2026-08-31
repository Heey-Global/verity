import { describe, expect, it } from 'vitest';
import { decodeStreamMessage, parseStreamFrame } from './wire.js';

const textEvent = { t: 'text', delta: 'hello' };

describe('parseStreamFrame', () => {
  it('accepts an event frame carrying a canonical event', () => {
    const res = parseStreamFrame({ k: 'event', seq: 7, event: textEvent });
    expect(res.success).toBe(true);
    if (res.success && res.data.k === 'event') {
      expect(res.data.seq).toBe(7);
      expect(res.data.event).toEqual(textEvent);
    }
  });

  it('accepts caught_up and error frames', () => {
    expect(parseStreamFrame({ k: 'caught_up', seq: 12 }).success).toBe(true);
    expect(parseStreamFrame({ k: 'error', message: 'failed to load backlog' }).success).toBe(true);
  });

  it('rejects an unknown frame kind', () => {
    expect(parseStreamFrame({ k: 'bogus', seq: 1 }).success).toBe(false);
  });

  it('rejects an event frame whose inner event violates the canonical contract', () => {
    // `text` requires `delta`; an event missing it must not slip through.
    expect(parseStreamFrame({ k: 'event', seq: 1, event: { t: 'text' } }).success).toBe(false);
  });

  it('rejects a negative or fractional seq', () => {
    expect(parseStreamFrame({ k: 'event', seq: -1, event: textEvent }).success).toBe(false);
    expect(parseStreamFrame({ k: 'caught_up', seq: 1.5 }).success).toBe(false);
  });

  it('accepts an event frame WITH a ts (the real persist time, #32)', () => {
    const res = parseStreamFrame({ k: 'event', seq: 7, ts: 1_700_000_000_000, event: textEvent });
    expect(res.success).toBe(true);
    if (res.success && res.data.k === 'event') expect(res.data.ts).toBe(1_700_000_000_000);
  });

  it('accepts an event frame WITHOUT a ts (optional for back-compat)', () => {
    const res = parseStreamFrame({ k: 'event', seq: 7, event: textEvent });
    expect(res.success).toBe(true);
    if (res.success && res.data.k === 'event') expect(res.data.ts).toBeUndefined();
  });

  it('rejects a negative or fractional ts', () => {
    expect(parseStreamFrame({ k: 'event', seq: 1, ts: -1, event: textEvent }).success).toBe(false);
    expect(parseStreamFrame({ k: 'event', seq: 1, ts: 1.5, event: textEvent }).success).toBe(false);
  });
});

describe('decodeStreamMessage', () => {
  it('decodes a JSON-stringified frame (the server wire form)', () => {
    const res = decodeStreamMessage(JSON.stringify({ k: 'event', seq: 3, event: textEvent }));
    expect(res).toEqual({ ok: true, frame: { k: 'event', seq: 3, event: textEvent } });
  });

  it('returns an error result for malformed JSON instead of throwing', () => {
    const res = decodeStreamMessage('{not json');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('invalid JSON');
  });

  it('returns an error result for a JSON value that violates the frame contract', () => {
    const res = decodeStreamMessage(JSON.stringify({ k: 'event', seq: 'x', event: textEvent }));
    expect(res.ok).toBe(false);
  });
});
