// Expo Metro config for the npm-workspace monorepo: watch the repo root and add
// both the app's and the root's node_modules so Metro resolves @verity/* from
// packages/.
const { getDefaultConfig } = require('expo/metro-config');
const exclusionList = require('metro-config/private/defaults/exclusionList').default;
const path = require('node:path');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);
config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const workspaceRootPattern = escapeRegExp(workspaceRoot);
config.resolver.blockList = exclusionList([
  new RegExp(`${workspaceRootPattern}/\\.verity-sessions/.*`),
  new RegExp(`${workspaceRootPattern}/\\.wt-[^/]+/.*`),
]);

// Resolve the @verity/* workspace packages from their TypeScript SOURCE rather
// than their built `dist`. This makes data-layer edits (reducer, api, ui/*)
// hot-reload via Fast Refresh instead of triggering a full bundle reload, and
// removes the need for a `tsc` build/watch to keep `dist` current for the app at
// runtime (the dist is still built for type-checking + CI). Two pieces:
//   1. the bare specifier `@verity/mobile` → `packages/mobile/src/index.ts`
//   2. the NodeNext `.js` extension on relative imports INSIDE that source
//      (e.g. `./reducer.js`) → resolved to the real `.ts` file
const VERITY_PACKAGES = ['mobile', 'events'];
const veritySrcIndex = Object.fromEntries(
  VERITY_PACKAGES.map((pkg) => [
    `@verity/${pkg}`,
    path.resolve(workspaceRoot, `packages/${pkg}/src/index.ts`),
  ]),
);
const veritySrcRoots = VERITY_PACKAGES.map(
  (pkg) => path.resolve(workspaceRoot, `packages/${pkg}/src`) + path.sep,
);

const upstreamResolveRequest = config.resolver.resolveRequest;
const resolveDefault = (context, moduleName, platform) =>
  (upstreamResolveRequest ?? context.resolveRequest)(context, moduleName, platform);

config.resolver.resolveRequest = (context, moduleName, platform) => {
  // 1. A bare @verity/* import → that package's TS source entry.
  const srcIndex = veritySrcIndex[moduleName];
  if (srcIndex !== undefined) {
    return { type: 'sourceFile', filePath: srcIndex };
  }
  // 2. A relative `./x.js` import FROM inside a @verity source file → drop the
  //    `.js` so Metro's sourceExts (ts/tsx) resolution finds the `.ts`.
  if (
    moduleName.startsWith('.') &&
    moduleName.endsWith('.js') &&
    veritySrcRoots.some((root) => context.originModulePath.startsWith(root))
  ) {
    return resolveDefault(context, moduleName.slice(0, -'.js'.length), platform);
  }
  return resolveDefault(context, moduleName, platform);
};

module.exports = config;
