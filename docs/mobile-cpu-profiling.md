# Optimized iOS CPU capture

Use a dedicated **staging profiling** native build to identify JavaScript CPU work
behind delayed touches and session commits. This is a diagnostic tool, not a
latency fix. Ordinary staging/production binaries do not link the sampler. OTA
cannot add it. The profiling build uses Release optimization, the existing Hermes
V1 engine, a commit-specific runtime and disabled Expo Updates. Do not attach
DevTools, start a Worklets profiler or run another Hermes sampler during capture.

## Build and retain the matching map

Build from a clean, committed checkout with the repository's pinned Node and npm.
The device binary uses the staging bundle ID and replaces the ordinary staging
installation. Distribution/signing and TestFlight upload require the normal release
authorization; the diagnostic dispatch of the native publishing workflow selects this profile.

For authorized TestFlight distribution, dispatch `mobile-native-build.yml` with
`profile-source` set to the full merged commit. This diagnostic path selects only
staging, disables OTA, retains the exact IPA-matched map before upload, and skips
normal release publication/evidence. Download `staging-cpu-map-<run-id>` within
14 days and keep it privately with the capture. `staging-cpu-build-<run-id>` records
Apple's processed build identity. Successful upload/processing does not establish
installation or populated sampling on the iPad.

On an Apple build host, from `apps/mobile`:

```sh
export VERITY_PROFILE_COMMIT="$(git rev-parse HEAD)"
export VERITY_APP_VARIANT=staging
export EXPO_UPDATE_CHANNEL=staging
export VERITY_CPU_PROFILING=1
npx expo prebuild --platform ios --no-install --clean
```

Install pods and archive the generated `VerityStaging` scheme in **Release**, or
use the repository-pinned EAS CLI with `--profile profiling --local`. Supply
`VERITY_PROFILE_COMMIT` to EAS's build environment as well. Keep the local EAS
working directory (`EAS_LOCAL_BUILD_SKIP_CLEANUP=1`) and copy the generated
`apps/mobile/profiling-artifacts` directory before deleting it. It contains
`main.jsbundle.map` and `manifest.json` with the full commit and map SHA-256. Maps
contain source text; keep them with private diagnostic artifacts, not in public
issues or app assets. Never substitute a freshly exported bundle's map.

For a **non-publishing simulator compile** of the profiling configuration:

```sh
gh workflow run mobile-native-verify.yml -f ref=<commit-or-branch> -f cpu_profiling=true
```

The workflow retains its exact map as a short-lived artifact. A successful normal
native verification does **not** compile the opt-in sampler. Simulator compilation
and a synthetic converter test do not establish populated on-device sampling.

## Capture on the affected iPad

1. Open Settings → Diagnostics and select **Record CPU activity**. This also
   enables the existing interaction diagnostics, which remain available for export.
2. Immediately repeat the slow session switches for 10–20 seconds, keeping the
   app foregrounded. Sampling is 100 Hz and stops natively after 30 seconds, even
   when the JavaScript event loop cannot execute timers. Backgrounding also stops
   recording; bridge invalidation disables the sampler.
3. Return to Diagnostics, select **Stop CPU recording** if still running, then
   **Export CPU capture**. The previous local recording is replaced on next start.
   Share only through the system share sheet; there is no automatic upload.
4. Keep the original capture, exact build/map pair, device model and repeat steps.
   Repeat at least three short recordings rather than one long run.

The native exporter refuses empty/oversized profiles and profiles without the
calling JS thread ID. A failed export is a capability failure, not a successful
CPU capture. The raw profile is limited to 8 MiB; diagnostic context to 1 MiB.
Thirty seconds bounds recording duration, not total process memory. Sampling and
serialization add overhead; compare like-for-like recordings and preserve normal
build timings as a baseline. A forced process exit can lose the current capture.

## Convert and inspect locally

From the repository root with mobile dependencies installed:

```sh
node scripts/mobile-cpu-profile.mjs extract \
  /private/path/verity-cpu-capture.json \
  /private/path/profiling-artifacts \
  /private/path/converted
```

The converter rejects a mismatched commit/map digest and broken sample stacks. It
uses the installed Expo/Metro symbolicator, then writes a symbolicated Hermes
trace, `profile.speedscope.json` and `diagnostics.json`. Open the Speedscope file
locally in a compatible viewer. The names and source locations are only as good
as the retained Hermes frame information and exact source map. Preserve raw data
when Metro cannot resolve a frame; do not treat unresolved symbols as attribution.

For pinned Hermes V1 (`hermes-v250829098.0.17`), sample timestamps and the native
`startedMonotonicUs` anchor use `CLOCK_UPTIME_RAW`, in microseconds. Interaction
wall times are Unix milliseconds. Approximate a sample's wall time with:

```text
recording.startedAt + (sample.ts - recording.startedMonotonicUs) / 1000
```

Recheck this clock contract when upgrading Hermes. Wall-clock changes during a
recording invalidate this conversion; use both start/stop anchors to detect drift.

For each retained switch, locate the touch delivery gap, native-resolve→JS-return
gap and anchor→transcript-commit gap. Inspect JS stacks in those windows and
compare several recordings. Samples identify CPU execution, not recognizer
ownership or all native thread waits. If the JS samples are mostly idle, move to
Apple Instruments thread scheduling rather than guessing a blocking JS function.
The CPU capture does not enable React's production Profiler callbacks or directly
measure React component commits; use the existing commit timing markers.

## Acceptance before attributing or fixing latency

- The opt-in configuration compiles on Apple with the pinned Hermes API.
- The affected iPad produces non-empty app-JS samples, imports into the viewer and
  resolves known application frames using the exact source map.
- Manual stop, native deadline, background stop, restart and export failures behave
  correctly; no sampler remains active after stop/invalidation.
- A proposed behavior fix addresses an observed stack and improves repeated
  same-device switches against the baseline; report any remaining slow cases.

API/clock references: React Native's installed `HermesInstance.cpp` and
`HermesRuntimeTargetDelegate.cpp`, Hermes V1's
[`hermes.h`](https://github.com/facebook/hermes/blob/hermes-v250829098.0.17/API/hermes/hermes.h),
[`SamplingProfiler.cpp`](https://github.com/facebook/hermes/blob/hermes-v250829098.0.17/lib/VM/Profiler/SamplingProfiler.cpp)
and [`OSCompatPosix.cpp`](https://github.com/facebook/hermes/blob/hermes-v250829098.0.17/lib/Support/OSCompatPosix.cpp).
