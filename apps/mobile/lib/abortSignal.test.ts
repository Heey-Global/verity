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

/** Members Node offers that React Native's implementation does not, either
 *  methods or properties (such as the `reason` getter). */
function missing(native: object, reactNative: object, kind: 'method' | 'property'): string[] {
  return Object.getOwnPropertyNames(native).filter((name) => {
    if (name === 'constructor' || name in reactNative) return false;
    const isMethod = typeof Object.getOwnPropertyDescriptor(native, name)?.value === 'function';
    return kind === 'method' ? isMethod : !isMethod;
  });
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
it('app sources use no AbortSignal member React Native lacks', () => {
  const methods = missing(AbortSignal.prototype, ReactNativeAbortSignal.prototype, 'method');
  const properties = missing(AbortSignal.prototype, ReactNativeAbortSignal.prototype, 'property');
  const statics = missing(AbortSignal, ReactNativeAbortSignal, 'method');
  // Without a known gap the patterns below would be vacuous.
  expect(methods).toContain('throwIfAborted');
  expect(properties).toContain('reason');
  const patterns = [
    ...methods.map((name) => new RegExp(`\\.\\s*${name}\\s*(\\?\\.\\s*)?\\(`)),
    // Property names are common (`descriptor.reason`), so only reads on
    // something named like a signal count.
    ...properties.map((name) => new RegExp(`\\b[sS]ignal\\s*\\??\\.\\s*${name}\\b`)),
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
