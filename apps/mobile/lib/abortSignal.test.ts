import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import {
  ReactNativeAbortController,
  ReactNativeAbortSignal,
} from '../__tests__/support/reactNativeAbortController';
import { AbortError, throwIfAborted } from './abortSignal';

const MOBILE_ROOT = join(__dirname, '..');
// Everything bundled into the app: its own sources and the shared data core.
const SOURCE_DIRS = [
  join(MOBILE_ROOT, 'app'),
  join(MOBILE_ROOT, 'components'),
  join(MOBILE_ROOT, 'hooks'),
  join(MOBILE_ROOT, 'lib'),
  join(MOBILE_ROOT, '../../packages/mobile/src'),
];

function sourcesIn(dir: string): string[] {
  // An empty scan would guard nothing, so a moved directory fails loudly.
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory())
    throw new Error(`sources are no longer at ${relative(MOBILE_ROOT, dir)}`);
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourcesIn(path);
    return entry.isFile() && /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)
      ? [path]
      : [];
  });
}

const withoutComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

/** Methods Node offers that React Native's implementation does not. */
function missingMethods(native: object, reactNative: object): string[] {
  return Object.getOwnPropertyNames(native).filter(
    (name) =>
      typeof Object.getOwnPropertyDescriptor(native, name)?.value === 'function' &&
      name !== 'constructor' &&
      !(name in reactNative),
  );
}

describe('throwIfAborted', () => {
  it('works on the AbortSignal React Native ships, which has no throwIfAborted', () => {
    const controller = new ReactNativeAbortController();
    expect(() => throwIfAborted(controller.signal)).not.toThrow();
    controller.abort();
    expect(() => throwIfAborted(controller.signal)).toThrow(AbortError);
    expect(() => throwIfAborted(controller.signal)).toThrow('The operation was aborted.');
  });

  it('throws the recorded reason where the runtime keeps one, like the standard method', () => {
    const controller = new AbortController();
    const reason = new Error('stopped');
    controller.abort(reason);
    expect(() => throwIfAborted(controller.signal)).toThrow(reason);
  });

  it('accepts a missing signal', () => {
    expect(() => throwIfAborted(undefined)).not.toThrow();
  });
});

// Calling one of these on a device throws "undefined is not a function" — the
// team join broke that way at its first step — while every Jest suite passes
// on Node's implementation. The list comes from the two implementations, so a
// React Native upgrade that adds a member lifts the ban by itself.
it('app sources call no AbortSignal method React Native lacks', () => {
  const instance = missingMethods(AbortSignal.prototype, ReactNativeAbortSignal.prototype);
  const statics = missingMethods(AbortSignal, ReactNativeAbortSignal);
  // Without a known gap the patterns below would be vacuous.
  expect(instance).toContain('throwIfAborted');
  const patterns = [
    ...instance.map((name) => new RegExp(`\\.\\s*${name}\\s*\\(`)),
    ...statics.map((name) => new RegExp(`\\bAbortSignal\\s*\\.\\s*${name}\\b`)),
  ];
  const offenders = SOURCE_DIRS.flatMap(sourcesIn).flatMap((file) => {
    const source = withoutComments(readFileSync(file, 'utf8'));
    return patterns
      .filter((pattern) => pattern.test(source))
      .map((pattern) => `${relative(MOBILE_ROOT, file).split(sep).join('/')}: ${pattern.source}`);
  });
  expect(offenders).toEqual([]);
});
