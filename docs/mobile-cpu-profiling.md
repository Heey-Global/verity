# Optimized iOS CPU capture

Regular **iOS staging** includes a manually started Hermes sampler with Release
optimization, the normal staging runtime and Expo Updates enabled. Production
omits the sampler. Install a new native staging build containing this integration;
an OTA update cannot add it to an older binary. Do not attach DevTools, start a
Worklets profiler or run another Hermes sampler during capture.

## Build and retain the matching map

The regular native release workflow retains `staging-cpu-map-<run-id>` before
uploading staging to Apple. It verifies the archived bundle and map hashes against
the embedded manifest and records the source commit and IPA build identity.
Download the artifact within its retention period and keep it with the capture.
Successful Apple processing does not establish installation or populated sampling.

Staging OTA uses one Hermes export with external source maps, retains the exact
bundle/map hashes and publishes that same export with `--skip-bundler`. Before
moving the staging channel, the pipeline checks the retained map and bundle hash
against the published iOS manifest. Download `staging-cpu-ota-<source-commit>`
within 90 days. A retry restores this artifact instead of re-exporting its commit;
missing or mismatched evidence blocks delivery. A cancellation before artifact
upload may require recovery of the original export; a new export is no substitute.

Captures record the actual launched bundle SHA-256, Expo update ID/runtime,
embedded/OTA state, bundle ID and native version/build at recording start. An
available or downloaded update does not label a capture until it is launched.
The converter selects the map by bundle hash and verifies its own digest and full
source commit. Maps contain source text: retain them privately, not in issues or
app assets. Keep the capture's native identity and `build.json` or `update.json`.

For a **non-publishing simulator compile** of regular staging:

```sh
gh workflow run mobile-native-verify.yml --ref <branch> -f ref=<commit-or-branch> -f regular_staging=true
```

A production compile does not exercise the staging sampler. Simulator compilation
and synthetic conversion do not establish populated on-device sampling.

The legacy dedicated diagnostic profile remains available with
`VERITY_CPU_PROFILING=1` and a full `VERITY_PROFILE_COMMIT`; it disables OTA and
uses a commit-specific runtime. Existing schema-1 captures still require their
original commit/map digest pair. Prefer regular staging for new captures.

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

The converter rejects a mismatched bundle/map digest and broken sample stacks. It
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

- The regular staging configuration compiles on Apple with the pinned Hermes API.
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
