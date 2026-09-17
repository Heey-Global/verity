import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error -- executable JavaScript helper
import {
  nativeCompatibilityChanges,
  nativePathKind,
  validateFingerprint,
} from './mobile-native-compatibility.mjs';

function fingerprint(hash = 'same') {
  return {
    hash,
    sources: ['expoConfig', 'expoAutolinkingConfig:ios', 'rncoreAutolinkingConfig:ios'].map(
      (id) => ({ id, hash: 'source' }),
    ),
  };
}

describe('mobile native compatibility', () => {
  it('keeps ordinary application edits on OTA without installing dependencies', async () => {
    const load = vi.fn();
    expect(
      await nativeCompatibilityChanges(
        ['apps/mobile/app/index.tsx', 'packages/mobile/src/api.ts'],
        load,
        'base',
        'head',
      ),
    ).toEqual([]);
    expect(load).not.toHaveBeenCalled();
  });

  it.each([
    'package-lock.json',
    'apps/mobile/package.json',
    'apps/mobile/app.config.ts',
    'apps/mobile/assets/icon.png',
  ])('compares actual native fingerprints for %s', async (path) => {
    const load = vi.fn().mockResolvedValue(fingerprint());
    expect(await nativeCompatibilityChanges([path], load, 'base', 'head')).toEqual([]);
    expect(load.mock.calls).toEqual([['base'], ['head']]);
  });

  it('requires native delivery when a transitive native or plugin change changes the fingerprint', async () => {
    const load = vi
      .fn()
      .mockResolvedValueOnce(fingerprint('before'))
      .mockResolvedValueOnce(fingerprint('after'));
    expect(await nativeCompatibilityChanges(['package-lock.json'], load, 'base', 'head')).toEqual([
      'Mobile native fingerprint changed',
    ]);
  });

  it.each([
    'apps/mobile/native/Drop.swift',
    'apps/mobile/plugins/withConfig.js',
    'apps/mobile/patches/fix.patch',
    'scripts/prepare-mobile-eas-build.mjs',
    'scripts/patch-mobile-native-deps.mjs',
    'apps/mobile/.fingerprintignore',
  ])('guards custom native input %s even if Expo would ignore it', async (path) => {
    const load = vi.fn();
    expect(nativePathKind(path)).toBe('native');
    expect(await nativeCompatibilityChanges([path], load, 'base', 'head')).toEqual([
      `Native input changed: ${path}`,
    ]);
    expect(load).not.toHaveBeenCalled();
  });

  it('fails closed when installation or fingerprint discovery fails', async () => {
    const load = vi.fn().mockRejectedValue(new Error('npm ci failed'));
    await expect(
      nativeCompatibilityChanges(['package-lock.json'], load, 'base', 'head'),
    ).rejects.toThrow('npm ci failed');
  });

  it('rejects fingerprints whose swallowed autolinking error would hide native changes', () => {
    const broken = fingerprint();
    broken.sources.pop();
    expect(() => validateFingerprint(broken)).toThrow('Incomplete mobile native fingerprint');
  });

  it('rejects an unreadable discovered source', () => {
    const broken = fingerprint();
    broken.sources.push({ id: 'native-file', hash: '' });
    expect(() => validateFingerprint(broken)).toThrow('unreadable source');
  });
});
