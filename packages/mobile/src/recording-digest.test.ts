import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { recordingDigest } from './recording-digest.js';

it.each(['', 'abc', 'Diagnostic UTF-8: ü 🛰️'])('hashes exact UTF-8 bytes: %s', async (text) => {
  expect(await recordingDigest(text)).toBe(createHash('sha256').update(text).digest('hex'));
});

it('fails explicitly when the runtime cannot verify an export', async () => {
  vi.stubGlobal('crypto', undefined);
  try {
    await expect(recordingDigest('evidence')).rejects.toThrow('verification unavailable');
  } finally {
    vi.unstubAllGlobals();
  }
});
