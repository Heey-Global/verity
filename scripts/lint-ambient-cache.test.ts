import { afterEach, expect, it, vi } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { AmbientClassificationCache } from './lint-ambient-cache.mjs';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  mkdirSync('.cache', { recursive: true });
  const root = mkdtempSync(resolve('.cache/ambient-test-'));
  roots.push(root);
  const project = join(root, 'tsconfig.json');
  const create = () => new AmbientClassificationCache(project, root);
  return { root, create };
}
it('reuses only matching current content and file identity and prunes removed roots', () => {
  const { root, create } = fixture();
  const file = join(root, 'first.ts');
  const classify = vi.fn(() => false);
  const first = create();
  expect(first.classify(file, 'export {};', classify)).toBe(false);
  first.save();
  const next = create();
  expect(next.classify(file, 'export {};', classify)).toBe(false);
  expect(classify).toHaveBeenCalledTimes(1);
  expect(next.classify(join(root, 'second.ts'), 'export {};', classify)).toBe(false);
  expect(classify).toHaveBeenCalledTimes(2);
  const changed = vi.fn(() => true);
  expect(next.classify(file, 'declare const globalValue: any;', changed)).toBe(true);
  next.save();
  const last = create();
  last.classify(file, 'declare const globalValue: any;', changed);
  last.save();
  const state = JSON.parse(readFileSync(last.path, 'utf8'));
  expect(Object.keys(state.files as Record<string, unknown>)).toEqual([file]);
  expect(changed).toHaveBeenCalledTimes(1);
});
it.each(['invalid json', 'version', 'digest', 'ambient', 'oversize'])(
  'falls back on %s metadata',
  (kind) => {
    const { root, create } = fixture();
    const file = join(root, 'target.ts');
    const first = create();
    first.classify(file, 'same', () => true);
    first.save();
    const state = JSON.parse(readFileSync(first.path, 'utf8'));
    if (kind === 'version') state.version = 'different TypeScript or classifier version';
    if (kind === 'digest') state.files[file].digest = 1;
    if (kind === 'ambient') state.files[file].ambient = 'false';
    writeFileSync(
      first.path,
      kind === 'invalid json'
        ? '{'
        : kind === 'oversize'
          ? ' '.repeat(4 * 1024 * 1024 + 1)
          : JSON.stringify(state),
    );
    const fallback = vi.fn(() => false);
    expect(create().classify(file, 'same', fallback)).toBe(false);
    expect(fallback).toHaveBeenCalledTimes(1);
  },
);
it('bounds the aggregate store, discards oversized snapshots and tolerates write failures', () => {
  const { root, create } = fixture();
  const cache = create();
  mkdirSync(cache.directory, { recursive: true });
  writeFileSync(join(cache.directory, 'old.json'), ' '.repeat(4 * 1024 * 1024));
  cache.classify(join(root, 'target.ts'), 'same', () => false);
  cache.save();
  expect(
    readdirSync(cache.directory).reduce(
      (n, file) => n + statSync(join(cache.directory, file)).size,
      0,
    ),
  ).toBeLessThanOrEqual(4 * 1024 * 1024);
  cache.classify(join(root, 'x'.repeat(4 * 1024 * 1024)), 'same', () => true);
  expect(() => cache.save()).not.toThrow();
  const other = fixture();
  mkdirSync(join(other.root, '.cache'), { recursive: true });
  writeFileSync(join(other.root, '.cache/lint-ambient'), 'blocked');
  const blocked = other.create();
  expect(blocked.classify('target.ts', 'same', () => true)).toBe(true);
  expect(() => blocked.save()).not.toThrow();
});

it('does not rewrite unchanged metadata and safely skips a contended writer', () => {
  const { root, create } = fixture();
  const file = join(root, 'target.ts');
  const first = create();
  first.classify(file, 'same', () => true);
  first.save();
  const before = statSync(first.path).mtimeMs;
  const next = create();
  next.classify(file, 'same', () => false);
  next.save();
  expect(statSync(first.path).mtimeMs).toBe(before);
  mkdirSync(join(first.directory, '.write-lock'));
  const blocked = create();
  blocked.classify(file, 'changed', () => false);
  expect(() => blocked.save()).not.toThrow();
  expect(create().classify(file, 'same', () => false)).toBe(true);
});
