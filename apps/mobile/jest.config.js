// Jest config for the Expo app (apps/mobile) ONLY. The TS data-core in
// packages/mobile uses vitest and has its own CI job; the two runners are kept
// strictly separate — `roots` + `testMatch` below scope jest to this directory,
// and packages/mobile is never picked up here (nor is this file picked up by the
// root vitest run, which globs `packages/*/src/**/*.test.ts`).
//
// `jest-expo` is pinned to the Expo SDK major (SDK 57 → jest-expo 57.x). It wires
// the babel-preset-expo transform, the RN/Expo module mocks, and the platform
// haste map. We only extend its `transformIgnorePatterns` so the RN / Expo /
// unistyles ESM packages under node_modules are transformed rather than left as
// untranspiled ESM (which Node's jest CJS runtime can't `require`).
/** @type {import('jest').Config} */
module.exports = {
  preset: 'jest-expo',
  // Pin jest's cache under .cache so CI can persist it across runs via
  // actions/cache (default is an OS tmpdir, wiped between runners). .cache/ is
  // gitignored.
  cacheDirectory: '<rootDir>/.cache/jest',
  // Scope discovery to this app dir so packages/mobile's vitest specs are invisible.
  roots: ['<rootDir>'],
  testMatch: ['<rootDir>/**/*.test.tsx', '<rootDir>/**/*.test.ts'],
  setupFilesAfterEnv: ['<rootDir>/jest.setup.ts'],
  // React Native UI tests can spend several seconds transforming modules and
  // flushing async effects on a shared CI runner. Keep the test-level ceiling
  // above RNTL's async-query timeout so a real query failure remains diagnostic.
  testTimeout: 15_000,
  // Resolve `@verity/mobile` to its BUILT output rather than the TS source. The
  // source uses NodeNext `.js`-extension ESM imports (`export … from './wire.js'`)
  // that jest's resolver can't map back to the `.ts` files; the compiled `dist/`
  // is plain resolvable JS. This mirrors CI: the `mobile-app` job runs
  // `npm run -w @verity/mobile build` before this test job, so `dist/` always
  // exists. Locally, run that build once first (it's a prerequisite of the test).
  moduleNameMapper: {
    '^@verity/mobile$': '<rootDir>/../../packages/mobile/dist/index.js',
  },
  // jest-expo's default resolver plus the react-native-worklets `.native` shim
  // reanimated needs under jest — see the comments in jest.resolver.js.
  resolver: '<rootDir>/jest.resolver.js',
  transformIgnorePatterns: [
    'node_modules/(?!((jest-)?react-native|@react-native(-community)?|expo(nent)?|@expo(nent)?/.*|@expo-google-fonts/.*|react-navigation|@react-navigation/.*|@unimodules/.*|unimodules|sentry-expo|native-base|react-native-svg|react-native-unistyles|react-native-nitro-modules|react-native-edge-to-edge|@shopify/flash-list|react-native-safe-area-context|react-native-gesture-handler|react-native-reanimated|react-native-worklets|react-native-keyboard-controller|react-native-screens|react-native-uitextview))',
  ],
};
