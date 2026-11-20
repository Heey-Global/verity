// Loads the AbortController/AbortSignal that React Native installs on a device.
// Jest runs on Node's complete implementation, so code calling a member React
// Native lacks stays green here and fails only in the app. The module is read
// out of react-native's own polyfill setup rather than named here, so a React
// Native upgrade that changes the implementation changes what tests see.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const reactNativeRoot = dirname(require.resolve('react-native/package.json'));
const setup = readFileSync(join(reactNativeRoot, 'Libraries/Core/setUpXHR.js'), 'utf8');

function polyfilled<T>(name: 'AbortController' | 'AbortSignal'): T {
  const match = new RegExp(
    `'${name}',\\s*\\(\\)\\s*=>\\s*require\\('([^']+)'\\)\\.${name}\\b`,
  ).exec(setup);
  // A missing match means React Native no longer polyfills this global the
  // way it did; re-check what the app runs on instead of trusting Node's.
  if (match === null) throw new Error(`react-native no longer polyfills ${name} via setUpXHR.js`);
  const module = require(require.resolve(match[1]!, { paths: [reactNativeRoot] })) as Record<
    string,
    T
  >;
  return module[name]!;
}

export const ReactNativeAbortController = polyfilled<typeof AbortController>('AbortController');
export const ReactNativeAbortSignal = polyfilled<typeof AbortSignal>('AbortSignal');

/** Replaces the globals with React Native's implementation for one test. */
export async function withReactNativeAbortController<T>(run: () => Promise<T>): Promise<T> {
  const controller = globalThis.AbortController;
  const signal = globalThis.AbortSignal;
  globalThis.AbortController = ReactNativeAbortController;
  globalThis.AbortSignal = ReactNativeAbortSignal;
  try {
    return await run();
  } finally {
    globalThis.AbortController = controller;
    globalThis.AbortSignal = signal;
  }
}
