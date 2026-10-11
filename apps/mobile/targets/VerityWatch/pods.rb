# Loaded into the Podfile by @bacons/apple-targets as `target 'VerityWatch'`.
# The watch app uses no pods, but CocoaPods' configuration for the target supplies
# PODS_ROOT, which React Native's project-wide REACT_NATIVE_PATH is defined
# against. With USE_CCACHE=1 the compiler and linker run through
# $(REACT_NATIVE_PATH)/scripts/xcode/ccache-clang.sh, which cannot be found
# without it.
platform :watchos, '11.0'
