import { describe, expect, it } from 'vitest';
import { dependencyInputIdentity as identity } from './dependency-inputs.js';

describe('dependency input compatibility', () => {
  it('ignores release metadata while retaining dependency constraints', () => {
    const base = {
      name: 'workspace',
      version: '1',
      scripts: { test: 'old' },
      dependencies: { dep: '1' },
    };
    expect(identity('package.json', JSON.stringify(base))).toBe(
      identity('package.json', JSON.stringify({ ...base, version: '2', scripts: { test: 'new' } })),
    );
    expect(identity('package.json', JSON.stringify(base))).not.toBe(
      identity('package.json', JSON.stringify({ ...base, dependencies: { dep: '2' } })),
    );
  });
  it('retains all third-party lock metadata and rejects malformed input', () => {
    const lock = (integrity: string) =>
      JSON.stringify({
        lockfileVersion: 3,
        packages: { '': { version: '1' }, 'node_modules/dep': { version: '1', integrity } },
      });
    expect(identity('package-lock.json', lock('a'))).not.toBe(
      identity('package-lock.json', lock('b')),
    );
    expect(() => identity('package.json', 'null')).toThrow();
    expect(() => identity('package-lock.json', '{')).toThrow();
  });
});
