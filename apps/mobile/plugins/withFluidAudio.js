const { withPodfile } = require('@expo/config-plugins');

// Inline Swift modules compile in the app target, so the FluidAudio pod must be
// declared in that target's Podfile. Pin the source tag until a native build has
// explicitly validated a newer SDK against our Swift bridge.
const FLUID_AUDIO_POD =
  "  pod 'FluidAudio/Core', :git => 'https://github.com/FluidInference/FluidAudio.git', :tag => 'v0.17.4'";

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
