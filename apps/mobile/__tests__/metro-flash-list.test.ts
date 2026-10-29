import path from 'node:path';
jest.mock('expo/metro-config', () => ({
  getDefaultConfig: () => ({ resolver: { assetExts: [] } }),
}));
jest.mock('metro-config/private/defaults/exclusionList', () => ({
  __esModule: true,
  default: (patterns: RegExp[]) => patterns,
}));
// Exercise the resolver used by the export: a correct helper that Metro never
// selects would leave all layout tests green while shipping the original bug.
const config = require('../metro.config');
const resolveRequest = jest.fn(() => ({ type: 'sourceFile', filePath: 'upstream' }));
const appRoot = path.resolve(__dirname, '..');
it.each(['src/recyclerview/RecyclerView.tsx', 'dist/recyclerview/RecyclerView.js'])(
  'uses corrected web measurements from FlashList %s',
  (source) => {
    const result = config.resolver.resolveRequest(
      {
        originModulePath: path.join(appRoot, '../../node_modules/@shopify/flash-list', source),
        resolveRequest,
      },
      './utils/measureLayout',
      'web',
    );
    expect(result.filePath).toBe(path.join(appRoot, 'lib/flashListMeasureLayout.web.ts'));
  },
);
it.each(['ios', 'android'])('keeps %s measurement unchanged', (platform) => {
  expect(
    config.resolver.resolveRequest(
      {
        originModulePath: path.join(
          appRoot,
          '../../node_modules/@shopify/flash-list/dist/recyclerview/RecyclerView.js',
        ),
        resolveRequest,
      },
      './utils/measureLayout',
      platform,
    ).filePath,
  ).toBe('upstream');
});
