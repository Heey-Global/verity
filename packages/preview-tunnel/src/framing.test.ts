import { describe, expect, it } from 'vitest';

import {
  canonicalBase64,
  encodedPayloadLimit,
  validStreamFrame,
  type StreamFrame,
} from './framing.js';

const MAX_BODY_BYTES = 1024;

function base64(value: string): string {
  return Buffer.from(value).toString('base64');
}

function open(overrides: Record<string, unknown> = {}): unknown {
  return {
    kind: 'stream.open',
    streamId: 'a1',
    channel: 'http',
    meta: { method: 'GET', path: '/index.html', headers: { accept: 'text/html' } },
    ...overrides,
  };
}

function data(overrides: Record<string, unknown> = {}): unknown {
  return { kind: 'stream.data', streamId: 'a1', seq: 0, payload: base64('hi'), ...overrides };
}

describe('validStreamFrame', () => {
  it('accepts the four frame kinds', () => {
    const frames: StreamFrame[] = [
      open() as StreamFrame,
      data() as StreamFrame,
      { kind: 'stream.end', streamId: 'a1' },
      { kind: 'stream.reset', streamId: 'a1', code: 'timeout' },
    ];
    for (const frame of frames) {
      expect(validStreamFrame(frame, MAX_BODY_BYTES)).toBe(true);
    }
  });

  it('rejects unknown kinds and non-objects', () => {
    expect(validStreamFrame({ kind: 'request', id: 'a1' }, MAX_BODY_BYTES)).toBe(false);
    expect(validStreamFrame({ kind: 'stream.ping', streamId: 'a1' }, MAX_BODY_BYTES)).toBe(false);
    expect(validStreamFrame(null, MAX_BODY_BYTES)).toBe(false);
    expect(validStreamFrame('stream.open', MAX_BODY_BYTES)).toBe(false);
  });

  it('requires a stream id of bounded length on every frame', () => {
    expect(validStreamFrame(open({ streamId: '' }), MAX_BODY_BYTES)).toBe(false);
    expect(validStreamFrame(open({ streamId: 'x'.repeat(129) }), MAX_BODY_BYTES)).toBe(false);
    expect(validStreamFrame({ kind: 'stream.end' }, MAX_BODY_BYTES)).toBe(false);
    expect(validStreamFrame(open({ streamId: 'x'.repeat(128) }), MAX_BODY_BYTES)).toBe(true);
  });
});

describe('stream.open', () => {
  it('accepts a response head on the http channel', () => {
    const frame = open({ meta: { status: 200, headers: { 'content-type': 'text/html' } } });
    expect(validStreamFrame(frame, MAX_BODY_BYTES)).toBe(true);
  });

  it('rejects a status outside the response range', () => {
    for (const status of [100, 199, 600, 200.5]) {
      expect(validStreamFrame(open({ meta: { status, headers: {} } }), MAX_BODY_BYTES)).toBe(false);
    }
  });

  it('rejects unknown channels', () => {
    expect(validStreamFrame(open({ channel: 'remote' }), MAX_BODY_BYTES)).toBe(false);
    expect(validStreamFrame(open({ channel: undefined }), MAX_BODY_BYTES)).toBe(false);
  });

  it('accepts a ws open and rejects one shaped like an http request', () => {
    const wsMeta = { path: '/socket', headers: { origin: 'https://preview.example' } };
    expect(validStreamFrame(open({ channel: 'ws', meta: wsMeta }), MAX_BODY_BYTES)).toBe(true);
    expect(
      validStreamFrame(open({ channel: 'ws', meta: { status: 200, headers: {} } }), MAX_BODY_BYTES),
    ).toBe(false);
  });

  // The wire protocol document makes member tolerance normative — its `channels[]`
  // forward-compatibility argument rests on it entirely — so a validator tightened to
  // reject unknown members has to fail here rather than only break peers in the field.
  it('tolerates members it does not define, on the frame and inside meta', () => {
    expect(validStreamFrame(open({ note: 'from a newer peer' }), MAX_BODY_BYTES)).toBe(true);
    const meta = { method: 'GET', path: '/', headers: {}, priority: 3 };
    expect(validStreamFrame(open({ meta }), MAX_BODY_BYTES)).toBe(true);
  });

  // The single exception, and its scope: only an acceptance rejects a member for
  // belonging to another meta, because an empty accept is itself valid and would
  // otherwise absorb a sender that confused two channels. A request meta carrying the
  // same misplaced member stays under the tolerance rule above.
  it('rejects a misplaced member only where the frame could be an acceptance', () => {
    const accept = { protocol: 'chat', status: 200 };
    expect(validStreamFrame(open({ channel: 'ws', meta: accept }), MAX_BODY_BYTES)).toBe(false);
    // The same meta without the misplaced member, so the rejection above is attributable
    // to `status` and not to a meta that simply matched neither shape.
    const bare = { protocol: accept.protocol };
    expect(validStreamFrame(open({ channel: 'ws', meta: bare }), MAX_BODY_BYTES)).toBe(true);
    // The rule is a closed set of four, not one member: `path` and `headers` are covered
    // by the open case below, and `method` only here.
    const wrongVerb = { protocol: 'chat', method: 'GET' };
    expect(validStreamFrame(open({ channel: 'ws', meta: wrongVerb }), MAX_BODY_BYTES)).toBe(false);
    const request = { method: 'GET', path: '/', headers: {}, status: 200 };
    expect(validStreamFrame(open({ meta: request }), MAX_BODY_BYTES)).toBe(true);
    // Including the request direction of the channel that has an acceptance: a `ws`
    // open with a path is read as an open, so the misplaced member is tolerated there
    // too. Only the frame that would otherwise read as an empty accept is strict.
    const wsOpen = { path: '/socket', headers: {}, status: 200 };
    expect(validStreamFrame(open({ channel: 'ws', meta: wsOpen }), MAX_BODY_BYTES)).toBe(true);
  });

  it('rejects methods outside the allowlist', () => {
    for (const method of ['TRACE', 'CONNECT', 'get', 'GETX']) {
      const frame = open({ meta: { method, path: '/', headers: {} } });
      expect(validStreamFrame(frame, MAX_BODY_BYTES)).toBe(false);
    }
  });

  it('rejects paths that are relative, protocol-relative, or overlong', () => {
    for (const path of ['index.html', '//evil.example/', `/${'x'.repeat(8192)}`]) {
      const frame = open({ meta: { method: 'GET', path, headers: {} } });
      expect(validStreamFrame(frame, MAX_BODY_BYTES)).toBe(false);
    }
  });

  it('rejects control characters in the path', () => {
    const frame = open({ meta: { method: 'GET', path: '/a\r\nHost: evil', headers: {} } });
    expect(validStreamFrame(frame, MAX_BODY_BYTES)).toBe(false);
  });

  it('rejects hop-by-hop headers in either direction', () => {
    for (const name of ['connection', 'transfer-encoding', 'upgrade', 'Keep-Alive']) {
      const request = open({ meta: { method: 'GET', path: '/', headers: { [name]: 'x' } } });
      const response = open({ meta: { status: 200, headers: { [name]: 'x' } } });
      expect(validStreamFrame(request, MAX_BODY_BYTES)).toBe(false);
      expect(validStreamFrame(response, MAX_BODY_BYTES)).toBe(false);
    }
  });

  it('rejects headers the receiving hop owns', () => {
    for (const name of ['host', 'cookie', 'Cookie']) {
      const frame = open({ meta: { method: 'GET', path: '/', headers: { [name]: 'x' } } });
      expect(validStreamFrame(frame, MAX_BODY_BYTES)).toBe(false);
    }
    for (const name of ['set-cookie', 'content-length']) {
      const frame = open({ meta: { status: 200, headers: { [name]: 'x' } } });
      expect(validStreamFrame(frame, MAX_BODY_BYTES)).toBe(false);
    }
  });

  it('rejects header values carrying a control character but allows tab', () => {
    const injected = open({
      meta: { method: 'GET', path: '/', headers: { 'x-a': 'v\r\nx-b: c' } },
    });
    const tabbed = open({ meta: { method: 'GET', path: '/', headers: { 'x-a': 'one\ttwo' } } });
    expect(validStreamFrame(injected, MAX_BODY_BYTES)).toBe(false);
    expect(validStreamFrame(tabbed, MAX_BODY_BYTES)).toBe(true);
  });

  it('rejects header blocks over the byte budget', () => {
    const headers = Object.fromEntries(
      Array.from({ length: 20 }, (_, index) => [`x-pad-${index}`, 'v'.repeat(4096)]),
    );
    expect(validStreamFrame(open({ meta: { status: 200, headers } }), MAX_BODY_BYTES)).toBe(false);
  });

  it('rejects non-string header values', () => {
    const frame = open({ meta: { method: 'GET', path: '/', headers: { 'x-a': 1 } } });
    expect(validStreamFrame(frame, MAX_BODY_BYTES)).toBe(false);
  });
});

describe('stream.data', () => {
  it('requires a non-negative integer sequence number', () => {
    for (const seq of [-1, 1.5, '0', undefined, Number.MAX_SAFE_INTEGER + 2]) {
      expect(validStreamFrame(data({ seq }), MAX_BODY_BYTES)).toBe(false);
    }
    expect(validStreamFrame(data({ seq: 0 }), MAX_BODY_BYTES)).toBe(true);
  });

  it('rejects payloads that are not canonical base64', () => {
    for (const payload of ['aGk', 'aG k=', 'aGk*', '!!!!']) {
      expect(validStreamFrame(data({ payload }), MAX_BODY_BYTES)).toBe(false);
    }
  });

  it('rejects payloads over the body limit, decoded', () => {
    const withinLimit = Buffer.alloc(MAX_BODY_BYTES).toString('base64');
    const overLimit = Buffer.alloc(MAX_BODY_BYTES + 1).toString('base64');
    expect(validStreamFrame(data({ payload: withinLimit }), MAX_BODY_BYTES)).toBe(true);
    expect(validStreamFrame(data({ payload: overLimit }), MAX_BODY_BYTES)).toBe(false);
  });

  it('accepts an empty payload, which is how a zero-length body is framed', () => {
    expect(validStreamFrame(data({ payload: '' }), MAX_BODY_BYTES)).toBe(true);
  });

  it('constrains the opcode when one is given', () => {
    expect(validStreamFrame(data({ meta: { opcode: 'text' } }), MAX_BODY_BYTES)).toBe(true);
    expect(validStreamFrame(data({ meta: { opcode: 'binary' } }), MAX_BODY_BYTES)).toBe(true);
    expect(validStreamFrame(data({ meta: { opcode: 'ping' } }), MAX_BODY_BYTES)).toBe(false);
    expect(validStreamFrame(data({ meta: null }), MAX_BODY_BYTES)).toBe(false);
  });

  it('tolerates unknown meta members', () => {
    expect(validStreamFrame(data({ meta: { opcode: 'text', future: 1 } }), MAX_BODY_BYTES)).toBe(
      true,
    );
  });
});

describe('stream.end', () => {
  it('accepts a bare half-close', () => {
    expect(validStreamFrame({ kind: 'stream.end', streamId: 'a1' }, MAX_BODY_BYTES)).toBe(true);
  });

  it('accepts a websocket close status and reason', () => {
    const frame = {
      kind: 'stream.end',
      streamId: 'a1',
      meta: { code: 1001, reason: 'going away' },
    };
    expect(validStreamFrame(frame, MAX_BODY_BYTES)).toBe(true);
  });

  it('rejects close codes that cannot be sent on the wire', () => {
    // Reserved by RFC 6455 §7.4.1 or set locally, never received: handing one
    // of these to `WebSocket.close` throws, so the frame is refused instead.
    for (const code of [1004, 1005, 1006, 1015, 2000, 2999]) {
      expect(
        validStreamFrame({ kind: 'stream.end', streamId: 'a1', meta: { code } }, MAX_BODY_BYTES),
      ).toBe(false);
    }
    for (const code of [1000, 1001, 1011, 1014, 3000, 4999]) {
      expect(
        validStreamFrame({ kind: 'stream.end', streamId: 'a1', meta: { code } }, MAX_BODY_BYTES),
      ).toBe(true);
    }
  });

  it('rejects close codes outside the websocket range', () => {
    for (const code of [999, 5000, 1000.5]) {
      expect(
        validStreamFrame({ kind: 'stream.end', streamId: 'a1', meta: { code } }, MAX_BODY_BYTES),
      ).toBe(false);
    }
  });

  it('rejects a reason with no code to carry it', () => {
    const meta = { reason: 'going away' };
    expect(validStreamFrame({ kind: 'stream.end', streamId: 'a1', meta }, MAX_BODY_BYTES)).toBe(
      false,
    );
    expect(
      validStreamFrame(
        { kind: 'stream.end', streamId: 'a1', meta: { ...meta, code: 1001 } },
        MAX_BODY_BYTES,
      ),
    ).toBe(true);
  });

  it('rejects a reason longer than a close frame can carry', () => {
    const meta = { code: 1001, reason: 'x'.repeat(124) };
    expect(validStreamFrame({ kind: 'stream.end', streamId: 'a1', meta }, MAX_BODY_BYTES)).toBe(
      false,
    );
  });

  it('measures the reason in bytes, not characters', () => {
    // 62 codepoints, 124 bytes — a character count would wrongly accept this.
    const meta = { code: 1001, reason: 'ä'.repeat(62) };
    expect(validStreamFrame({ kind: 'stream.end', streamId: 'a1', meta }, MAX_BODY_BYTES)).toBe(
      false,
    );
  });
});

describe('stream.reset', () => {
  it('accepts every defined code', () => {
    for (const code of [
      'timeout',
      'client_gone',
      'body_limit',
      'concurrency_limit',
      'share_ended',
      'upstream_error',
      'protocol_error',
    ]) {
      expect(validStreamFrame({ kind: 'stream.reset', streamId: 'a1', code }, MAX_BODY_BYTES)).toBe(
        true,
      );
    }
  });

  it('rejects an undefined code', () => {
    expect(
      validStreamFrame({ kind: 'stream.reset', streamId: 'a1', code: 'boom' }, MAX_BODY_BYTES),
    ).toBe(false);
    expect(validStreamFrame({ kind: 'stream.reset', streamId: 'a1' }, MAX_BODY_BYTES)).toBe(false);
  });
});

describe('size helpers', () => {
  it('accepts only whole base64 quanta', () => {
    expect(canonicalBase64('aGk=')).toBe(true);
    expect(canonicalBase64('aGk')).toBe(false);
    expect(canonicalBase64('')).toBe(true);
  });

  it('rejects a padded quantum carrying bits no byte reaches', () => {
    // `AB==` and `AA==` decode to the same byte, and `aGl=`/`aGk=` to the same
    // pair — one payload must not have two spellings on the wire.
    expect(canonicalBase64('AA==')).toBe(true);
    expect(canonicalBase64('AB==')).toBe(false);
    expect(canonicalBase64('aGl=')).toBe(false);
    for (const tail of ['A', 'Q', 'g', 'w']) expect(canonicalBase64(`A${tail}==`)).toBe(true);
    for (const tail of ['E', 'I', 'M', 'U']) expect(canonicalBase64(`A${tail}==`)).toBe(false);
  });

  it('leaves room for the envelope on top of the encoded body', () => {
    const body = 1024;
    expect(encodedPayloadLimit(body)).toBeGreaterThan(Math.ceil(body / 3) * 4);
  });
});
