# Native mobile build performance

Mobile 1.31.0 (Actions run 35127184230) took 30m31s from workflow creation to
native-job completion. Fastlane archive/sign/export took 17m24s, upload acceptance
1m52s, and Apple processing 4m05s. Outer and isolated npm installs took 41s and 42s;
CocoaPods took 1m16s. These are baseline measurements, not promised savings.

The workspace npm `postinstall` prepares only EAS builds (`EAS_BUILD=true`). It
runs dependency patches and builds `@verity/mobile` in the unpacked repository,
before prebuild/pod install. EAS reinstalls dependencies and the archive excludes
node_modules/dist, so outer workflow preparation alone cannot provide those
changes. Keep explicit preparation for non-EAS local/simulator builds. Do not
replace this with `eas-build-post-install`: on iOS that hook runs after CocoaPods.
That later hook only verifies a preparation marker tied to the isolated build
directory and fails before compilation if npm skipped lifecycle scripts. The
marker is excluded from the EAS archive.

The TestFlight workflow pilots ccache with a 512-MiB local limit. Only compiler
objects are cached; signing keys, profiles, IPAs, and EAS working directories are
excluded. The cache key binds OS, architecture, Xcode/ccache versions, lockfile,
app configuration, preparation script, and patch policy. There are no broader
restore fallbacks. An exact key stores one immutable seed, bounding growth for an
unchanged toolchain/dependency set; different keys still share the repository's
Actions cache budget and normal eviction policy.

A dedicated configuration retains strict ccache validation instead of React
Native's permissive header/module/timestamp settings. Some compile operations may
therefore remain uncacheable. React Native Core and Hermes are already prebuilt;
Swift compilation, linking, signing and Apple processing are not accelerated by
this compiler-object cache. EAS local caching is otherwise unsupported, so this
uses a fixed local EAS working root and explicitly inherited compiler settings.

Job summaries record cache statistics and separate native build/IPA verification,
upload acceptance, and Apple processing durations. Compare the next normal cold
and warm releases with the same key; report hit rates, uncacheable operations,
cache transfer overhead, and native duration before claiming improvement. Do not
publish dummy app versions to benchmark. If strict caching yields no useful hits,
disable the pilot rather than weakening correctness checks without evidence.

Build-number verification, signing, and the exact uploaded build's Apple VALID
state remain mandatory. Moving the wait off macOS would save runner occupancy,
not make the app available sooner.
