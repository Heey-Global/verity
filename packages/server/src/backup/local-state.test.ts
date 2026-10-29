import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decodeLocalIndex, encodeBoundedLocalIndex, encodeLocalIndex } from './local-state.js';

describe('bounded persistent deduplication cache', () => {
  it('evicts disposable mappings before the persisted cache exceeds the readable budget', () => {
    const key = randomBytes(32).toString('base64url');
    const index = Object.fromEntries(
      Array.from({ length: 100 }, (_, i) => [`file-${i}`, 'x'.repeat(80)]),
    );
    expect(encodeLocalIndex(index, key).length).toBeGreaterThan(1024);
    const encoded = encodeBoundedLocalIndex(index, key, 1024);
    expect(encoded.length).toBeLessThanOrEqual(1024);
    expect(decodeLocalIndex(encoded, key)).toEqual(index);
    expect(Object.keys(index).length).toBeGreaterThan(0);
    expect(index['file-99']).toBeDefined();
    expect(index['file-0']).toBeUndefined();
  });
  it('preserves small caches and rejects budgets above the reader ceiling', () => {
    const key = randomBytes(32).toString('base64url');
    const index = { file: 'object' };
    expect(decodeLocalIndex(encodeBoundedLocalIndex(index, key), key)).toEqual(index);
    expect(() => encodeBoundedLocalIndex(index, key, 33 * 1024 * 1024)).toThrow('budget');
  });
});
