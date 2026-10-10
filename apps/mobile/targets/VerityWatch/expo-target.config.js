// Companion Watch app records audio and transfers it to the paired iPhone.
/** @type {import('@bacons/apple-targets/app.plugin').Config} */
module.exports = {
  type: 'watch',
  name: 'VerityWatch',
  displayName: 'Verity',
  bundleIdentifier: '.watchkitapp',
  deploymentTarget: '11.0',
  icon: '../../assets/brand/verity-v-app-icon-source.png',
  colors: { $accent: '#ff35da' },
  frameworks: ['SwiftUI', 'AVFoundation', 'WatchConnectivity'],
};
