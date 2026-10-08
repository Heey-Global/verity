import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const routerRequire = createRequire(require.resolve('expo-router/package.json'));
const routerRoot = dirname(routerRequire.resolve('expo-router/package.json'));
const query = routerRequire('query-string') as {
  stringify(params: Record<string, unknown>, options?: { sort: false }): string;
  parse(value: string): Record<string, unknown>;
};

describe('installed SDK 57 query backport', () => {
  it('resolves the safe replacement from the actual consumer', () => {
    expect(routerRequire.resolve('query-string')).toContain('vendor/expo-router-query-string');
  });

  it('supports every query API referenced by installed Expo Router', () => {
    const calls = new Set<string>();
    function scan(directory: string) {
      for (const file of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, file.name);
        if (file.isDirectory()) scan(path);
        else if (file.name.endsWith('.js')) {
          const source = readFileSync(path, 'utf8');
          if (!source.includes('require("query-string")')) continue;
          for (const match of source.matchAll(/queryString\.(\w+)/gu)) calls.add(match[1]!);
        }
      }
    }
    scan(join(routerRoot, 'build'));
    expect(calls.size).toBeGreaterThan(0);
    for (const method of calls) expect(query).toHaveProperty(method, expect.any(Function));
  });

  it('round trips through the SDK 57 bundled navigation helpers', () => {
    const { getPathFromState } = routerRequire(
      './build/react-navigation/core/getPathFromState.js',
    ) as {
      getPathFromState(this: void, state: unknown, options: unknown): string;
    };
    const { getStateFromPath } = routerRequire(
      './build/react-navigation/core/getStateFromPath.js',
    ) as {
      getStateFromPath(
        this: void,
        path: string,
        options: unknown,
      ): { routes: Array<{ name: string; params: Record<string, unknown> }> };
    };
    const config = { screens: { Preview: 'preview' } };
    const params = { text: 'café 😀 +', tags: ['a b', 'c+d'] };
    const path = getPathFromState({ routes: [{ name: 'Preview', params }] }, config);
    const route = getStateFromPath(path, config).routes[0]!;
    expect(route.name).toBe('Preview');
    // SDK 57 converts array params to strings before invoking the serializer.
    expect(route.params).toMatchObject({ text: params.text, tags: params.tags.join(',') });
  });

  it('supports the URLSearchParams implementation shipped by native Expo', () => {
    const expoRequire = createRequire(routerRequire.resolve('expo/package.json'));
    const native = expoRequire('whatwg-url-minimum') as { URLSearchParams: typeof URLSearchParams };
    const original = globalThis.URLSearchParams;
    try {
      globalThis.URLSearchParams = native.URLSearchParams;
      const params = { text: 'café 😀 +', tags: ['a b', 'c+d'] };
      expect(query.parse(query.stringify(params, { sort: false }))).toEqual(params);
      expect(query.parse('text=a%20b')).toEqual({ text: 'a b' });
    } finally {
      globalThis.URLSearchParams = original;
    }
  });
});
