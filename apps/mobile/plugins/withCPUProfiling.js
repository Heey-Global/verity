const { withPodfile, withXcodeProject } = require('@expo/config-plugins');

// Only the dedicated optimized diagnostic build links the sampler. Normal
// staging/production builds cannot activate it through JavaScript or OTA.
module.exports = function withCPUProfiling(config) {
  config = withPodfile(config, (mod) => {
    const anchor = '  use_expo_modules!';
    const pod = "  pod 'VerityCPUProfiler', :path => '../plugins/cpu-profiler'";
    if (!mod.modResults.contents.includes(pod)) {
      if (!mod.modResults.contents.includes(anchor)) throw new Error('Expo Podfile anchor changed');
      mod.modResults.contents = mod.modResults.contents.replace(anchor, `${anchor}\n${pod}`);
    }
    return mod;
  });
  return withXcodeProject(config, (mod) => {
    const phases = mod.modResults.hash.project.objects.PBXShellScriptBuildPhase;
    const bundle = Object.values(phases).find(
      (phase) =>
        typeof phase === 'object' && phase.name === '"Bundle React Native code and images"',
    );
    if (!bundle) throw new Error('React Native bundle phase missing');
    bundle.shellScript = JSON.stringify(
      profileBundleScript(JSON.parse(bundle.shellScript), config.ios.infoPlist.VerityProfileCommit),
    );
    return mod;
  });
};

// Re-prebuild can change the commit without deleting the project. Replace both
// marked blocks rather than retaining an earlier commit's manifest command.
function profileBundleScript(script, commit) {
  const clean = script.replace(
    /# BEGIN VERITY CPU PROFILE[^\n]*\n[\s\S]*?# END VERITY CPU PROFILE[^\n]*\n/g,
    '',
  );
  const prefix =
    '# BEGIN VERITY CPU PROFILE SETUP\nset -e\nmkdir -p "$PROJECT_DIR/../profiling-artifacts"\nrm -f "$PROJECT_DIR/../profiling-artifacts/main.jsbundle.map" "$PROJECT_DIR/../profiling-artifacts/manifest.json"\nexport SOURCEMAP_FILE="$PROJECT_DIR/../profiling-artifacts/main.jsbundle.map"\n# END VERITY CPU PROFILE SETUP\n';
  const suffix = `\n# BEGIN VERITY CPU PROFILE IDENTITY\n"$NODE_BINARY" "$PROJECT_DIR/../../../scripts/mobile-cpu-profile.mjs" manifest "$SOURCEMAP_FILE" "${commit}"\ncp "$PROJECT_DIR/../profiling-artifacts/manifest.json" "$TARGET_BUILD_DIR/$UNLOCALIZED_RESOURCES_FOLDER_PATH/verity-profile-map.json"\n# END VERITY CPU PROFILE IDENTITY\n`;
  return prefix + clean.trimEnd() + suffix;
}
module.exports.profileBundleScript = profileBundleScript;
