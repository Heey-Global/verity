import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  decodeEnrollmentBody,
  decodePrefaceFrame,
  decodeQrPayload,
  decodeStrictJson,
} from './raw-wire.js';

const fixtures = JSON.parse(
  readFileSync(new URL('./wire-fixtures.json', import.meta.url), 'utf8'),
) as {
  name: string;
  schema: string;
  value: Record<string, unknown>;
  valid: boolean;
}[];
const accepted = (schema: string) =>
  fixtures.find((fixture) => fixture.schema === schema && fixture.valid)!.value;
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value), 'utf8');
const frame = (body: Uint8Array, declaredLength = body.length) => {
  const header = Buffer.alloc(4);
  header.writeUInt32BE(declaredLength);
  return Buffer.concat([header, body]);
};

describe('review-only raw enrollment wire', () => {
  it('decodes a complete big-endian preface frame and rejects length confusion', () => {
    const body = bytes(accepted('preface'));
    expect(decodePrefaceFrame(frame(body))).toEqual(accepted('preface'));
    expect(() => decodePrefaceFrame(frame(body, body.length - 1))).toThrow();
    expect(() => decodePrefaceFrame(frame(body, body.length + 1))).toThrow();
    expect(() => decodePrefaceFrame(frame(body).subarray(0, 3))).toThrow();
    expect(() => decodePrefaceFrame(frame(body, 0))).toThrow();
    expect(() => decodePrefaceFrame(Buffer.concat([frame(body), Buffer.from('x')]))).toThrow();
    const atLimit = Buffer.concat([body, Buffer.alloc(4096 - body.length, 0x20)]);
    expect(decodePrefaceFrame(frame(atLimit))).toEqual(accepted('preface'));
    expect(() => decodePrefaceFrame(frame(Buffer.concat([atLimit, Buffer.from(' ')])))).toThrow(
      /length mismatch/u,
    );
  });

  it('rejects duplicate object keys before decoded-message validation', () => {
    const valid = accepted('challenge');
    const encoded = JSON.stringify(valid);
    const duplicate = encoded.replace(
      '"operationId":',
      `"operationId":${JSON.stringify(valid.operationId)},"operation\\u0049d":`,
    );
    expect(JSON.parse(duplicate)).toEqual(valid);
    expect(() => decodeEnrollmentBody('challenge', Buffer.from(duplicate))).toThrow(/duplicate/u);
    const preface = JSON.stringify(accepted('preface')).replace(
      '"version":2',
      '"version":2,"vers\\u0069on":2',
    );
    expect(() => decodePrefaceFrame(frame(Buffer.from(preface)))).toThrow(/duplicate/u);
    expect(() =>
      decodeQrPayload('verity://enroll/v1#' + Buffer.from('{"a":1,"a":2}').toString('base64url')),
    ).toThrow(/duplicate/u);
    expect(() => decodeStrictJson(Buffer.from('{"outer":{"a":1,"a":2}}'), 1024)).toThrow(
      /duplicate/u,
    );
  });

  it('enforces the body byte bound on otherwise valid JSON', () => {
    const body = bytes(accepted('challenge'));
    expect(body.length).toBeLessThan(16 * 1024);
    const atLimit = Buffer.concat([body, Buffer.alloc(16 * 1024 - body.length, 0x20)]);
    expect(decodeEnrollmentBody('challenge', atLimit)).toEqual(accepted('challenge'));
    expect(() =>
      decodeEnrollmentBody('challenge', Buffer.concat([atLimit, Buffer.from(' ')])),
    ).toThrow(/byte limit/u);
  });

  it('rejects malformed UTF-8 even when replacement text would be valid JSON', () => {
    const malformed = Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xc3, 0x22, 0x7d]);
    expect(() => decodeStrictJson(malformed, 1024)).toThrow();
  });

  it('enforces canonical QR payload encoding and decoded byte length', () => {
    const prefix = 'verity://enroll/v1#';
    const payload = bytes({ version: 1 });
    const encoded = payload.toString('base64url');
    expect(decodeQrPayload(prefix + encoded)).toEqual({ version: 1 });
    expect(() => decodeQrPayload(prefix + encoded + '=')).toThrow();
    expect(() => decodeQrPayload(prefix + Buffer.from([0xc3]).toString('base64url'))).toThrow();
    const atLimit = Buffer.concat([payload, Buffer.alloc(4096 - payload.length, 0x20)]);
    expect(decodeQrPayload(prefix + atLimit.toString('base64url'))).toEqual({ version: 1 });
    expect(() =>
      decodeQrPayload(prefix + Buffer.concat([atLimit, Buffer.from(' ')]).toString('base64url')),
    ).toThrow(/byte limit/u);
  });
});
