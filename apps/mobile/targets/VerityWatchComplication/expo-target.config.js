// Embedded in VerityWatch, not in the iPhone app's PlugIns directory.
/** @type {import('@bacons/apple-targets/app.plugin').ConfigFunction} */
module.exports = (config) => ({
  type: 'watch-widget',
  name: 'VerityWatchComplication',
  displayName: 'Verity',
  bundleIdentifier: '.watchkitapp.complication',
  deploymentTarget: '11.0',
  frameworks: ['SwiftUI', 'WidgetKit'],
  colors: { $accent: '#ff35da' },
  images: { VerityMark: '../../assets/brand/verity-v-mark.png' },
  entitlements: {
    'com.apple.security.application-groups': [`group.${config.ios.bundleIdentifier}.watch-capture`],
  },
});
