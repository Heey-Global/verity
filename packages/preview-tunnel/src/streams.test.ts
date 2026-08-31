import { describe, expect, it } from 'vitest';

import { StreamRegistry } from './streams.js';

function registry(maxBodyBytes = 1024): StreamRegistry<string> {
  return new StreamRegistry<string>({ maxBodyBytes });
}

describe('opening streams', () => {
  it('opens only the sending direction of an http stream', () => {
    const streams = registry();
    expect(streams.openOutbound('a1', 'http', 'ctx')).toEqual({ ok: true, closed: false });
    const record = streams.get('a1');
    expect(record?.outbound.state).toBe('open');
    expect(record?.inbound.state).toBe('idle');
  });

  it('leaves the reply direction of a ws stream closed until it is accepted', () => {
    const streams = registry();
    streams.openOutbound('a1', 'ws', 'ctx');
    expect(streams.get('a1')?.outbound.state).toBe('open');
    expect(streams.get('a1')?.inbound.state).toBe('idle');
    // The acceptance is the peer's own open on the same id, exactly as an http
    // response head is.
    expect(streams.acceptOpen('a1', 'ws', 'ctx')).toEqual({ ok: true, closed: false });
    expect(streams.get('a1')?.inbound.state).toBe('open');
  });

  it('lets a response head reuse the id of a stream this side opened', () => {
    const streams = registry();
    streams.openOutbound('a1', 'http', 'ctx');
    expect(streams.acceptOpen('a1', 'http', 'ctx')).toEqual({ ok: true, closed: false });
    expect(streams.get('a1')?.inbound.state).toBe('open');
  });

  it('rejects a second open of the same direction', () => {
    const streams = registry();
    streams.acceptOpen('a1', 'http', 'ctx');
    expect(streams.acceptOpen('a1', 'http', 'ctx')).toEqual({ ok: false, code: 'protocol_error' });

    streams.openOutbound('b1', 'http', 'ctx');
    expect(streams.openOutbound('b1', 'http', 'ctx')).toEqual({
      ok: false,
      code: 'protocol_error',
    });
  });

  it('rejects an open that changes the channel of an existing stream', () => {
    const streams = registry();
    streams.openOutbound('a1', 'http', 'ctx');
    expect(streams.acceptOpen('a1', 'ws', 'ctx')).toEqual({ ok: false, code: 'protocol_error' });
  });
});

describe('sequence numbers', () => {
  it('counts each direction independently from zero', () => {
    const streams = registry();
    streams.openOutbound('a1', 'ws', 'ctx');
    streams.acceptOpen('a1', 'ws', 'ctx');
    expect(streams.nextOutboundSeq('a1')).toBe(0);
    expect(streams.nextOutboundSeq('a1')).toBe(1);
    expect(streams.acceptData('a1', 0, 2)).toEqual({ ok: true, closed: false });
    expect(streams.acceptData('a1', 1, 2)).toEqual({ ok: true, closed: false });
    expect(streams.nextOutboundSeq('a1')).toBe(2);
  });

  it('rejects a gap', () => {
    const streams = registry();
    streams.acceptOpen('a1', 'ws', 'ctx');
    expect(streams.acceptData('a1', 1, 2)).toEqual({ ok: false, code: 'protocol_error' });
  });

  it('rejects a repeat', () => {
    const streams = registry();
    streams.acceptOpen('a1', 'ws', 'ctx');
    streams.acceptData('a1', 0, 2);
    expect(streams.acceptData('a1', 0, 2)).toEqual({ ok: false, code: 'protocol_error' });
  });

  it('does not consume a sequence number for a rejected frame', () => {
    const streams = registry();
    streams.acceptOpen('a1', 'ws', 'ctx');
    streams.acceptData('a1', 5, 2);
    expect(streams.acceptData('a1', 0, 2)).toEqual({ ok: true, closed: false });
  });

  it('refuses to allocate on a direction that is not open', () => {
    const streams = registry();
    streams.acceptOpen('a1', 'http', 'ctx');
    expect(streams.nextOutboundSeq('a1')).toBeUndefined();
    expect(streams.nextOutboundSeq('missing')).toBeUndefined();
  });
});

describe('half-close', () => {
  it('keeps the stream alive while the other direction is open', () => {
    const streams = registry();
    streams.openOutbound('a1', 'ws', 'ctx');
    streams.acceptOpen('a1', 'ws', 'ctx');
    expect(streams.endOutbound('a1')).toEqual({ ok: true, closed: false });
    expect(streams.get('a1')).toBeDefined();
  });

  it('closes and forgets the stream once both directions have ended', () => {
    const streams = registry();
    streams.openOutbound('a1', 'ws', 'ctx');
    streams.acceptOpen('a1', 'ws', 'ctx');
    streams.endOutbound('a1');
    expect(streams.acceptEnd('a1')).toEqual({ ok: true, closed: true });
    expect(streams.get('a1')).toBeUndefined();
    expect(streams.size).toBe(0);
  });

  it('rejects data after the sending direction ended', () => {
    const streams = registry();
    streams.acceptOpen('a1', 'ws', 'ctx');
    streams.acceptEnd('a1');
    expect(streams.acceptData('a1', 0, 2)).toEqual({ ok: false, code: 'protocol_error' });
  });

  it('rejects a second end on the same direction', () => {
    const streams = registry();
    streams.acceptOpen('a1', 'ws', 'ctx');
    streams.acceptEnd('a1');
    expect(streams.acceptEnd('a1')).toEqual({ ok: false, code: 'protocol_error' });
  });

  it('does not let an http response arrive before its head', () => {
    const streams = registry();
    streams.openOutbound('a1', 'http', 'ctx');
    expect(streams.acceptData('a1', 0, 2)).toEqual({ ok: false, code: 'protocol_error' });
    streams.acceptOpen('a1', 'http', 'ctx');
    expect(streams.acceptData('a1', 0, 2)).toEqual({ ok: true, closed: false });
  });
});

describe('body limit', () => {
  it('bounds the cumulative request body of an http stream', () => {
    const streams = registry(10);
    streams.acceptOpen('a1', 'http', 'ctx');
    expect(streams.acceptData('a1', 0, 6)).toEqual({ ok: true, closed: false });
    expect(streams.acceptData('a1', 1, 5)).toEqual({ ok: false, code: 'body_limit' });
  });

  it('leaves the response direction of an http stream unbounded', () => {
    // The response is relayed frame by frame and never accumulated, so the byte
    // total says nothing about memory — bounding it would kill every long-lived
    // response once it passed one body's worth.
    const streams = registry(10);
    streams.openOutbound('a1', 'http', 'ctx');
    streams.acceptOpen('a1', 'http', 'ctx');
    for (let seq = 0; seq < 5; seq += 1) {
      expect(streams.acceptData('a1', seq, 10)).toEqual({ ok: true, closed: false });
    }
    expect(streams.nextOutboundSeq('a1')).toBe(0);
  });

  it('does not accumulate a limit across a ws stream', () => {
    const streams = registry(10);
    streams.acceptOpen('a1', 'ws', 'ctx');
    for (let seq = 0; seq < 5; seq += 1) {
      expect(streams.acceptData('a1', seq, 10)).toEqual({ ok: true, closed: false });
    }
  });
});

describe('teardown', () => {
  it('reports every http stream still waiting for its head', () => {
    const streams = registry();
    streams.openOutbound('a1', 'http', 'ctx');
    streams.openOutbound('a2', 'http', 'ctx');
    streams.openOutbound('a3', 'ws', 'ctx');
    streams.acceptOpen('a2', 'http', 'ctx');
    expect(streams.awaitingHead().map((record) => record.streamId)).toEqual(['a1']);
  });

  it('hands back every live stream on drain and empties itself', () => {
    const streams = registry();
    streams.openOutbound('a1', 'http', 'ctx');
    streams.acceptOpen('b1', 'ws', 'other');
    const drained = streams.drain();
    expect(drained.map((record) => record.context).sort()).toEqual(['ctx', 'other']);
    expect(streams.size).toBe(0);
    expect(streams.drain()).toEqual([]);
  });

  it('drops a reset stream and returns it once', () => {
    const streams = registry();
    streams.openOutbound('a1', 'ws', 'ctx');
    expect(streams.reset('a1')?.context).toBe('ctx');
    expect(streams.reset('a1')).toBeUndefined();
    expect(streams.acceptData('a1', 0, 1)).toEqual({ ok: false, code: 'protocol_error' });
  });

  it('treats frames for an unknown stream as a protocol error', () => {
    const streams = registry();
    expect(streams.acceptData('gone', 0, 1)).toEqual({ ok: false, code: 'protocol_error' });
    expect(streams.acceptEnd('gone')).toEqual({ ok: false, code: 'protocol_error' });
    expect(streams.endOutbound('gone')).toEqual({ ok: false, code: 'protocol_error' });
  });
});
