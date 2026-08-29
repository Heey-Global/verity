import { describe, expect, it } from 'vitest';

// @ts-expect-error -- plain .mjs helper, no types
import { mobileDependencyNames, nativeLockChanges } from './mobile-native-lock-changes.mjs';

function lock(packages: Record<string, unknown>) {
  return { lockfileVersion: 3, packages };
}

const base = lock({
  'apps/mobile': { dependencies: { expo: '~56.0.0', 'react-native': '0.85.3' } },
  'node_modules/expo': { version: '56.0.15' },
  'node_modules/react-native': { version: '0.85.3' },
  'node_modules/eslint': { version: '9.0.0' },
});

describe('mobile native lockfile changes', () => {
  it('ignores lockfile churn outside the mobile dependency closure', () => {
    const head = lock({
      'apps/mobile': { dependencies: { expo: '~56.0.0', 'react-native': '0.85.3' } },
      'node_modules/expo': { version: '56.0.15' },
      'node_modules/react-native': { version: '0.85.3' },
      // A server-only tooling bump — an installed binary absorbs this over the air.
      'node_modules/eslint': { version: '9.1.0' },
    });
    expect(nativeLockChanges(base, head)).toEqual([]);
  });

  it('reports a version move of a direct mobile dependency', () => {
    const head = lock({
      'apps/mobile': { dependencies: { expo: '~56.1.0', 'react-native': '0.85.3' } },
      'node_modules/expo': { version: '56.1.0' },
      'node_modules/react-native': { version: '0.85.3' },
      'node_modules/eslint': { version: '9.0.0' },
    });
    expect(nativeLockChanges(base, head)).toEqual(['expo: 56.0.15 -> 56.1.0']);
  });

  it('prefers a nested workspace install over the hoisted copy', () => {
    const head = lock({
      'apps/mobile': { dependencies: { expo: '~56.0.0', 'react-native': '0.85.3' } },
      'apps/mobile/node_modules/expo': { version: '56.2.0' },
      'node_modules/expo': { version: '56.0.15' },
      'node_modules/react-native': { version: '0.85.3' },
    });
    expect(nativeLockChanges(base, head)).toEqual(['expo: 56.0.15 -> 56.2.0']);
  });

  it('reports added and removed native dependencies', () => {
    const head = lock({
      'apps/mobile': { dependencies: { expo: '~56.0.0', 'expo-camera': '~17.0.0' } },
      'node_modules/expo': { version: '56.0.15' },
      'node_modules/expo-camera': { version: '17.0.1' },
    });
    expect(nativeLockChanges(base, head)).toEqual([
      'expo-camera: (absent) -> 17.0.1',
      'react-native: 0.85.3 -> (absent)',
    ]);
  });

  it('unions the dependency names of both lockfiles', () => {
    const head = lock({ 'apps/mobile': { dependencies: { 'expo-camera': '~17.0.0' } } });
    expect(mobileDependencyNames(base, head)).toEqual(['expo', 'expo-camera', 'react-native']);
  });
});
