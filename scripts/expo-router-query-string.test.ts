import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const routerRoot = dirname(require.resolve('expo-router/package.json'));
const routerRequire = createRequire(join(routerRoot, 'package.json'));
const query = routerRequire('query-string') as {
  stringify(params: Record<string, unknown>, options?: { sort: false }): string;
  parse(value: string): Record<string, unknown>;
};

describe('SDK 57 Expo query backport', () => {
  it('resolves the safe replacement from the actual consumer', () => {
    expect(routerRequire.resolve('query-string')).toContain('vendor/expo-router-query-string');
    const lock = JSON.parse(readFileSync('package-lock.json', 'utf8')) as {
      packages: Record<string, unknown>;
    };
    expect(
      Object.keys(lock.packages).filter((path) => path.endsWith('/decode-uri-component')),
    ).toEqual([]);
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

  it('round trips navigation parameters with upstream URLSearchParams encoding', () => {
    const params = {
      space: 'a b',
      plus: 'a+b',
      unicode: 'café 😀',
      array: ['first value', 'second+value'],
      symbols: '*~&=#/?',
    };
    const encoded = query.stringify(params, { sort: false });
    expect(encoded).toContain('space=a+b');
    expect(encoded).toContain('symbols=*%7E%26%3D%23%2F%3F');
    expect(query.parse(encoded)).toEqual(params);
    expect(query.parse('space=a%20b&plus=a%2Bb')).toEqual({ space: 'a b', plus: 'a+b' });
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

  it('handles empty, absent, repeated and prototype-like keys', () => {
    expect(query.stringify({ omitted: undefined, mixed: [undefined, null, '', false, 0] })).toBe(
      'mixed=&mixed=&mixed=false&mixed=0',
    );
    const parsed = query.parse('__proto__=safe&bare&duplicate=a&duplicate=b');
    expect(Object.getPrototypeOf(parsed)).toBeNull();
    expect(parsed).toEqual({ ['__proto__']: 'safe', bare: null, duplicate: ['a', 'b'] });
  });

  it('decodes malformed percent input without the recursive vulnerable decoder', () => {
    expect(query.parse(`value=${'%E0%A4'.repeat(10000)}`).value).toEqual(
      new URLSearchParams(`value=${'%E0%A4'.repeat(10000)}`).get('value'),
    );
  });

  it('ships the local override in every Docker dependency stage', () => {
    for (const path of [
      'deploy/Dockerfile',
      'deploy/secret-job-worker.Dockerfile',
      'deploy/project-relay.Dockerfile',
      'deploy/preview-edge.Dockerfile',
      'deploy/preview-connector.Dockerfile',
    ]) {
      const source = readFileSync(path, 'utf8');
      const stages = source
        .split(/^FROM /mu)
        .slice(1)
        .filter((stage) => stage.includes('npm ci'));
      for (const stage of stages)
        expect(stage).toContain(
          'COPY vendor/expo-router-query-string ./vendor/expo-router-query-string',
        );
    }
  });
});
