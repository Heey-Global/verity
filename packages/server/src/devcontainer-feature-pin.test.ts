import { describe, expect, it, vi } from 'vitest';
import { pinToolkitFeature } from './devcontainer-feature-pin.js';

const digest = `ghcr.io/trusted/toolkit@sha256:${'a'.repeat(64)}`;
const feature = {
  ref: 'ghcr.io/trusted/toolkit:1.2.3',
  identity: 'bundled-bytes',
  version: '1.2.3',
};
describe('toolkit Feature manifest pinning', () => {
  it('pins the selected bundle version and incorporates the manifest into build identity', async () => {
    const resolve = vi.fn(async () => digest);
    expect(await pinToolkitFeature(feature, resolve)).toEqual({
      ...feature,
      ref: digest,
      identity: `bundled-bytes\n${digest}`,
    });
    expect(resolve).toHaveBeenCalledWith(feature.ref);
  });
  it('preserves an explicit immutable private-registry pin without anonymous discovery', async () => {
    const resolve = vi.fn();
    const pinned = { ...feature, ref: digest };
    expect(await pinToolkitFeature(pinned, resolve)).toEqual(pinned);
    expect(resolve).not.toHaveBeenCalled();
  });
  it.each([
    'ghcr.io/foreign/toolkit@sha256:' + 'a'.repeat(64),
    'ghcr.io/trusted/toolkit:latest',
    'ghcr.io/trusted/toolkit@sha256:bad',
  ])('rejects a mismatched or nonimmutable resolution %s', async (ref) => {
    await expect(pinToolkitFeature(feature, async () => ref)).rejects.toThrow(
      'configured repository',
    );
  });
  it('fails closed on registry failure', async () => {
    await expect(
      pinToolkitFeature(feature, async () => {
        throw new Error('unavailable');
      }),
    ).rejects.toThrow('unavailable');
  });
});
