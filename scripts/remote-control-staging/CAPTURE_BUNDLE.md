# Independent capture collection

`capture-bundle.mjs` assembles already exported local files. It does not activate
recording, start an app test, retrieve remote logs, verify clock synchronization,
or prove an end-to-end result. The actual Core host and Uplink administrative
collection adapters must be supplied separately. A successful preflight means
only that matching initial observations were imported during the local window.
It must not automatically trigger a device test or imply future output is available.

Detailed recording remains opt-in. Prepare a window of at most 120 seconds to
match the native recorder, activate each source using its existing independent
administrative procedure, and retrieve an initial sample before asking for the
phone action. Baseline logs and bounded detailed recording are different things.
Core's existing admin API accepts the absolute expiry; it does not activate Uplink.
The app controls its local recording and exports that recording without needing
to retrieve Core logs. Stop each source using its existing procedure after the
attempt; its expiry remains the backstop.

```sh
node scripts/remote-control-staging/capture-bundle.mjs prepare /tmp/remote-run INSTALLATION_FINGERPRINT 120
node scripts/remote-control-staging/capture-bundle.mjs collect /tmp/remote-run core-status /private/core-status.json
node scripts/remote-control-staging/capture-bundle.mjs collect /tmp/remote-run core /private/core.jsonl
node scripts/remote-control-staging/capture-bundle.mjs collect /tmp/remote-run uplink /private/uplink.jsonl
node scripts/remote-control-staging/capture-bundle.mjs preflight /tmp/remote-run
node scripts/remote-control-staging/capture-bundle.mjs collect /tmp/remote-run app /private/app.json
node scripts/remote-control-staging/capture-bundle.mjs report /tmp/remote-run
```

The tool creates a new directory with mode 0700 and files with mode 0600. Each
source can be imported once, at most 4 MiB, with its byte count and SHA-256 saved
in the manifest. Later reports verify those values. Keep initial-sample and final
collection bundles separate when importing a later export; the collector never
overwrites an earlier artifact. A final collection can be imported after expiry.

Core/Uplink inputs must be filtered JSONL containing `remote.return_path`
schema-version-1 records. Core uses numeric `time` (Unix milliseconds) and
an `events` array. Uplink uses UTC `at`, flat `stage`/`outcome`/`direction`,
`eventOrder` and `elapsedMs`; it does not require Core's `events` array.
The importer preserves original bytes and normalizes timestamps only for analysis.
Uplink dropped-stream and logger-error counters remain explicit gaps. A flat
initial event establishes an observation, not complete summary coverage.
Both formats require session/generation fingerprints and party.
Unknown formats are rejected. This does **not** establish compatibility with a
particular deployed Uplink collector. Its native cluster diagnostic bundle needs
an explicit adapter that preserves section failures, rotation and omission limits;
do not pass it through as if it were this format. The current cluster bundle is a
finite retrospective snapshot, not a continuously running collector.

App input is a native snapshot array; import checks its structural envelope only.
Use the app's validated export. This tool is **not a sanitizer**: supplied files
can contain private metadata or credentials. Do not commit or publicly upload the
directory. The printed report includes only fixed gaps, run ID and fingerprints.

The report always sets `complete: false`: local file integrity cannot establish
capture completeness, independent clock accuracy, ongoing recording, or successful
authenticated application traffic. Missing sources and saturated diagnostic detail
remain explicit. Matching session fingerprints are initial correlation evidence;
local generation identifiers are never equated between processes. Local send
acceptance never establishes remote receipt. No fault location is inferred.

Verification: `node --test scripts/remote-control-staging/capture-bundle.test.mjs`.

## Core log projection

Project a privately retrieved Core Pino JSONL file (or Docker `json-file`
records) before import:

```sh
node scripts/remote-control-staging/project-core-recording.mjs /private/core-raw.jsonl /private/core-metadata.jsonl
```

This command writes only allowlisted `remote.return_path` metadata to a new
mode-0600 file and prints counts of ignored, invalid and rejected records.
It exits with code 2 if no usable records exist or some input records failed
validation. Preserve that result as a collection gap; do not treat partial
projection as a full capture. Input is bounded to 16 MiB. Pino's numeric `time`
is retained when present; timestamps are never invented for records that lack
one. The bundle importer requires timestamped records. Rotation, truncated
upstream exports and clock offsets remain unknown even if every line parses.
This projector supports Core's schema only, not raw cluster bundles or Uplink
schemas. It never calls a server or activates recording.
