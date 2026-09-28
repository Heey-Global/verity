const { withPodfile } = require('@expo/config-plugins');

// Inline Swift modules compile in the app target, so the FluidAudio pod must be
// declared in that target's Podfile. The local podspec pins the source tag and
// supplies the SwiftPM bundle symbol missing from the CocoaPods build.
const FLUID_AUDIO_POD = "  pod 'FluidAudio/Core', :podspec => '../plugins/FluidAudio.podspec'";

module.exports = function withFluidAudio(config) {
  return withPodfile(config, (mod) => {
    if (mod.modResults.contents.includes(FLUID_AUDIO_POD)) return mod;
    const anchor = '  use_expo_modules!';
    if (!mod.modResults.contents.includes(anchor)) {
      throw new Error('Could not locate Expo modules in the generated Podfile');
    }
    mod.modResults.contents = mod.modResults.contents.replace(
      anchor,
      `${anchor}\n${FLUID_AUDIO_POD}`,
    );
    return mod;
  });
};
