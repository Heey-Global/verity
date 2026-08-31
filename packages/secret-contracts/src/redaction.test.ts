import { describe, expect, it } from 'vitest';
import {
  RedactionCollisionError,
  RedactionLimitError,
  StreamingSecretRedactor,
  redactorPersistenceReceiptSchema,
  streamingRedactorProfileSchema,
} from './redaction.js';

const hash = 'a'.repeat(64);
const profile = streamingRedactorProfileSchema.parse({
  id: 'redactor-v1',
  version: 1,
  implementationDigest: hash,
  algorithm: 'byte-longest-first-v1',
  minimumSecretBytes: 4,
  maximumSecretBytes: 64,
  maximumActiveSecrets: 16,
  maximumInputChunkBytes: 65_536,
  maximumScanComparisons: 8_388_608,
  maximumOutputBytes: 1024,
  replacement: '[REDACTED]',
});

const bytes = (value: string) => Uint8Array.from(value, (character) => character.charCodeAt(0));
const text = (value: Uint8Array) => String.fromCharCode(...value);

function redact(chunks: Uint8Array[], secrets = [bytes('secret-value')]): string {
  const redactor = new StreamingSecretRedactor(profile, secrets);
  return chunks.map((chunk) => text(redactor.push(chunk))).join('') + text(redactor.flush());
}

describe('streaming secret redactor', () => {
  it('redacts across every possible chunk boundary', () => {
    const input = bytes('before secret-value after');
    for (let split = 0; split <= input.length; split += 1) {
      expect(redact([input.slice(0, split), input.slice(split)])).toBe('before [REDACTED] after');
    }
  });

  it('uses deterministic longest-first matching for overlapping values', () => {
    expect(redact([bytes('token-long token')], [bytes('token'), bytes('token-long')])).toBe(
      '[REDACTED] [REDACTED]',
    );
  });

  it('redacts repeated binary values without decoding UTF-8', () => {
    const secret = new Uint8Array([0xff, 0, 0xfe, 1]);
    const redactor = new StreamingSecretRedactor(profile, [secret]);
    const first = redactor.push(new Uint8Array([7, 0xff, 0]));
    const second = redactor.push(new Uint8Array([0xfe, 1, 8, 0xff, 0, 0xfe, 1]));
    const output = new Uint8Array([...first, ...second, ...redactor.flush()]);
    expect([...output]).toEqual([...bytes('\u0007[REDACTED]\b[REDACTED]')]);
  });

  it('rejects unsafe secret counts and lengths', () => {
    expect(() => new StreamingSecretRedactor(profile, [])).toThrow(/count/);
    expect(() => new StreamingSecretRedactor(profile, [bytes('abc')])).toThrow(/length/);
  });

  it('fails closed on chunk and output limits and cannot resume', () => {
    const tiny = { ...profile, maximumInputChunkBytes: 4, maximumOutputBytes: 3 };
    const inputLimited = new StreamingSecretRedactor(tiny, [bytes('abcd')]);
    expect(() => inputLimited.push(bytes('12345'))).toThrow(RedactionLimitError);
    expect(() => inputLimited.flush()).toThrow(/terminal/);

    const outputLimited = new StreamingSecretRedactor(tiny, [bytes('abcd')]);
    outputLimited.push(bytes('1234'));
    expect(() => outputLimited.flush()).toThrow(RedactionLimitError);
    expect(() => outputLimited.push(bytes('1'))).toThrow(/terminal/);
  });

  it('fails closed when adversarial matching exhausts the work budget', () => {
    const constrained = { ...profile, maximumScanComparisons: 8 };
    const redactor = new StreamingSecretRedactor(constrained, [bytes('aaaa'), bytes('aaab')]);
    expect(() => {
      redactor.push(bytes('aaaaaaaa'));
      redactor.flush();
    }).toThrow(/work limit/);
    expect(() => redactor.push(bytes('safe'))).toThrow(/terminal/);
  });

  it('discards pending raw bytes on abort', () => {
    const redactor = new StreamingSecretRedactor(profile, [bytes('secret-value')]);
    expect(redactor.push(bytes('secret-'))).toHaveLength(0);
    redactor.abort();
    expect(() => redactor.flush()).toThrow(/terminal/);
  });

  it('fails closed when replacement output synthesizes a registered secret', () => {
    const redactor = new StreamingSecretRedactor(profile, [bytes('abcd'), bytes('x[RE')]);
    expect(() => {
      redactor.push(bytes('xabcd'));
      redactor.flush();
    }).toThrow(RedactionCollisionError);
    expect(() => redactor.push(bytes('safe'))).toThrow(/terminal/);
  });

  it('dispose renders the redactor terminal and discards pending bytes', () => {
    const redactor = new StreamingSecretRedactor(profile, [bytes('secret-value')]);
    // A partial secret is buffered as pending, unredacted, raw bytes; dispose must drop it.
    expect(redactor.push(bytes('secret-'))).toHaveLength(0);
    redactor.dispose();
    expect(() => redactor.push(bytes('safe'))).toThrow(/terminal/);
    expect(() => redactor.flush()).toThrow(/terminal/);
  });

  it('dispose is idempotent and safe after a normal flush', () => {
    const redactor = new StreamingSecretRedactor(profile, [bytes('secret-value')]);
    expect(text(redactor.push(bytes('a secret-value b')))).toBe('');
    expect(text(redactor.flush())).toBe('a [REDACTED] b');
    // The happy-path flush already terminated (and zeroized) the redactor; dispose must not throw.
    expect(() => redactor.dispose()).not.toThrow();
    expect(() => redactor.dispose()).not.toThrow();
  });

  it('dispose before any use blocks all further output', () => {
    const redactor = new StreamingSecretRedactor(profile, [bytes('secret-value')]);
    redactor.dispose();
    expect(() => redactor.push(bytes('secret-value'))).toThrow(/terminal/);
  });

  it('rejects impossible durable sequence receipts', () => {
    expect(() =>
      redactorPersistenceReceiptSchema.parse({
        jobId: 'job-1',
        redactorId: 'redactor-v1',
        redactorVersion: 1,
        firstSequence: 10,
        nextSequence: 11,
        persistedFrameCount: 7,
        persistedBytes: 42,
      }),
    ).toThrow(/sequence range/);
  });
});
