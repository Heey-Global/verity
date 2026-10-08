import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const query = require('../vendor/expo-router-query-string/index.cjs') as {
  stringify(params: Record<string, unknown>, options?: { sort: false }): string;
  parse(value: string): Record<string, unknown>;
};

describe('SDK 57 Expo query backport', () => {
  it('excludes the vulnerable decoder from the locked dependency graph', () => {
    const lock = JSON.parse(readFileSync('package-lock.json', 'utf8')) as {
      packages: Record<string, unknown>;
    };
    expect(
      Object.keys(lock.packages).filter((path) => path.endsWith('/decode-uri-component')),
    ).toEqual([]);
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
