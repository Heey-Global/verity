// Embedded in VerityWatch, not in the iPhone app's PlugIns directory.
/** @type {import('@bacons/apple-targets/app.plugin').Config} */
module.exports = {
  type: 'watch-widget',
  name: 'VerityWatchComplication',
  displayName: 'Verity',
  bundleIdentifier: '.watchkitapp.quickcapture',
  deploymentTarget: '11.0',
  frameworks: ['SwiftUI', 'WidgetKit'],
  images: {
    VerityMarkOriginal: '../../assets/brand/verity-v-mark.png',
    VerityLauncherArtwork: '../../assets/brand/verity-v-app-icon-source.png',
  },
  colors: { $accent: '#ff35da' },
};
