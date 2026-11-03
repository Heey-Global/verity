// Keep Expo's worker initialization atomic across concurrent database opens.
const upstream = require('@expo/metro-config/babel-transformer');

function serializeSqliteInitialization(src, filename) {
  if (!/[/\\]expo-sqlite[/\\]web[/\\]worker\.ts$/.test(filename)) return src;
  const marker = 'async function maybeInitAsync(): Promise<{';
  if (src.split(marker).length !== 2) {
    throw new Error('Expo SQLite worker changed; reassess the initialization race fix.');
  }
  return src.replace(
    marker,
    `let initialization: ReturnType<typeof initializeSqliteAsync> | null = null;
function maybeInitAsync() {
  return initialization ??= initializeSqliteAsync();
}
async function initializeSqliteAsync(): Promise<{`,
  );
}

module.exports.serializeSqliteInitialization = serializeSqliteInitialization;
module.exports.transform = (args) =>
  upstream.transform({
    ...args,
    src: serializeSqliteInitialization(args.src, args.filename),
  });
