// Apple Watch quick capture. The watch records audio itself and hands the file
// to the paired iPhone, which transcribes it (watchOS has no Speech framework)
// and stores the task. Linked into the Xcode project by @bacons/apple-targets.
/** @type {import('@bacons/apple-targets/app.plugin').Config} */
module.exports = {
  type: 'watch',
  name: 'VerityWatch',
  displayName: 'Verity',
  // Must sit under the iPhone app's bundle identifier for the companion pairing.
  bundleIdentifier: '.watchkitapp',
  deploymentTarget: '11.0',
  icon: '../../assets/brand/verity-v-app-icon-source.png',
  colors: { $accent: '#ff35da' },
  frameworks: ['SwiftUI', 'AVFoundation', 'WatchConnectivity'],
};
