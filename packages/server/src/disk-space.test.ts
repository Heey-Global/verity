import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { diskSpaceAt } from './disk-space.js';

// The low-disk warning trusts these two numbers; swapped or unscaled they would
// either never warn or warn on every healthy host.
describe('diskSpaceAt', () => {
  it('reports free bytes within the total of a real filesystem', async () => {
    const { freeBytes, totalBytes } = await diskSpaceAt(tmpdir());
    expect(totalBytes).toBeGreaterThan(1024 ** 2);
    expect(freeBytes).toBeGreaterThanOrEqual(0);
    expect(freeBytes).toBeLessThanOrEqual(totalBytes);
  });
});
