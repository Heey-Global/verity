module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    // Unistyles v3 needs its Babel plugin to make components theme-reactive.
    // `root` points at the folder holding the styled components (the Expo Router
    // app dir); files there are processed for StyleSheet.create usage.
    plugins: [['react-native-unistyles/plugin', { root: 'app' }]],
  };
};
