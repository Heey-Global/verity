import { describe, expect, it } from 'vitest';

import {
  decodeDockerAttachFrames,
  decodeSecretWorkerMessages,
  encodeSecretWorkerMessage,
  MAX_DOCKER_ATTACH_FRAME_BYTES,
  SecretWorkerProtocolError,
  type SecretWorkerWireMessage,
} from './secret-worker-protocol-codec.js';

async function* chunks(...values: Uint8Array[]) {
  yield* values;
}

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const value of source) result.push(value);
  return result;
}

function dockerFrame(stream: 1 | 2, payload: Uint8Array): Buffer {
  const frame = Buffer.alloc(8 + payload.length);
  frame[0] = stream;
  frame.writeUInt32BE(payload.length, 4);
  Buffer.from(payload).copy(frame, 8);
  return frame;
}

const message: SecretWorkerWireMessage = {
  protocolVersion: 1,
  type: 'challenge',
  payload: { jobId: 'job-1', nonce: 'nonce' },
};

describe('secret worker protocol codec', () => {
  it('demultiplexes fragmented and coalesced Docker stdout/stderr frames', async () => {
    const wire = Buffer.concat([
      dockerFrame(1, Buffer.from('hello')),
      dockerFrame(2, Buffer.from('failure')),
    ]);
    const frames = await collect(
      decodeDockerAttachFrames(
        chunks(wire.subarray(0, 3), wire.subarray(3, 11), wire.subarray(11)),
      ),
    );
    expect(frames.map((frame) => [frame.stream, Buffer.from(frame.payload).toString()])).toEqual([
      ['stdout', 'hello'],
      ['stderr', 'failure'],
    ]);
  });

  it.each([
    ['unknown stream', Buffer.from([3, 0, 0, 0, 0, 0, 0, 0])],
    ['nonzero reserved byte', Buffer.from([1, 1, 0, 0, 0, 0, 0, 0])],
    ['truncated header', Buffer.from([1, 0, 0])],
    ['truncated payload', dockerFrame(1, Buffer.from('abc')).subarray(0, 9)],
  ])('rejects a malformed Docker frame: %s', async (_label, wire) => {
    await expect(collect(decodeDockerAttachFrames(chunks(wire)))).rejects.toBeInstanceOf(
      SecretWorkerProtocolError,
    );
  });

  it('rejects an oversized Docker frame before buffering its payload', async () => {
    const header = Buffer.alloc(8);
    header[0] = 1;
    header.writeUInt32BE(MAX_DOCKER_ATTACH_FRAME_BYTES + 1, 4);
    await expect(collect(decodeDockerAttachFrames(chunks(header)))).rejects.toThrow(
      /exceeds limit/,
    );
  });

  it('accepts one coalesced chunk larger than the per-frame buffer', async () => {
    const wire = Buffer.concat([
      dockerFrame(1, Buffer.alloc(8, 1)),
      dockerFrame(1, Buffer.alloc(8, 2)),
    ]);
    await expect(collect(decodeDockerAttachFrames(chunks(wire), 8))).resolves.toHaveLength(2);
  });

  it('round-trips fragmented worker messages deterministically', async () => {
    const encoded = encodeSecretWorkerMessage(message);
    expect(encodeSecretWorkerMessage(message)).toEqual(encoded);
    await expect(
      collect(
        decodeSecretWorkerMessages(
          chunks(encoded.subarray(0, 1), encoded.subarray(1, 7), encoded.subarray(7)),
        ),
      ),
    ).resolves.toEqual([message]);
  });

  it.each([
    ['zero length', Buffer.alloc(4)],
    [
      'oversized length',
      (() => {
        const b = Buffer.alloc(4);
        b.writeUInt32BE(262_145);
        return b;
      })(),
    ],
    ['truncated body', Buffer.from([0, 0, 0, 5, 123])],
    ['invalid JSON', Buffer.from([0, 0, 0, 1, 123])],
  ])('rejects a malformed worker message: %s', async (_label, wire) => {
    await expect(collect(decodeSecretWorkerMessages(chunks(wire)))).rejects.toBeInstanceOf(
      SecretWorkerProtocolError,
    );
  });

  it('rejects unknown message types and extra envelope fields', async () => {
    for (const body of [
      { protocolVersion: 1, type: 'future', payload: {} },
      { protocolVersion: 1, type: 'proof', payload: {}, extra: true },
    ]) {
      const json = Buffer.from(JSON.stringify(body));
      const wire = Buffer.alloc(4 + json.length);
      wire.writeUInt32BE(json.length);
      json.copy(wire, 4);
      await expect(collect(decodeSecretWorkerMessages(chunks(wire)))).rejects.toThrow(/shape/);
    }
  });

  it('accepts multiple valid messages coalesced beyond the per-message buffer', async () => {
    const large = encodeSecretWorkerMessage({
      protocolVersion: 1,
      type: 'frame',
      payload: { data: 'x'.repeat(140_000) },
    });
    await expect(
      collect(decodeSecretWorkerMessages(chunks(Buffer.concat([large, large])))),
    ).resolves.toHaveLength(2);
  });

  it('rejects malformed UTF-8 instead of replacement-decoding it', async () => {
    const prefix = Buffer.from('{"protocolVersion":1,"type":"error","payload":"');
    const suffix = Buffer.from('"}');
    const body = Buffer.concat([prefix, Buffer.from([0xff]), suffix]);
    const wire = Buffer.alloc(4 + body.length);
    wire.writeUInt32BE(body.length);
    body.copy(wire, 4);
    await expect(collect(decodeSecretWorkerMessages(chunks(wire)))).rejects.toThrow(/UTF-8/);
  });
});
