# Release performance

Run [372](https://github.com/Heey-Global/verity/actions/runs/35106702701)
completed in 41m56s on 2026-09-16. Its Server ARM64 image was pushed at
14:42:04 UTC, but cache export continued until 14:47:15. Sandbox AMD64 and
preview edge AMD64 each spent approximately another 2m22s exporting cache after
image export. These intervals overlap other work; they are not additive savings.

Candidate sandbox, relay, Matrix connector, and Server builds now overlap live
acceptance. Before acceptance only temporary SHA/architecture tags and the
`candidate-vX.Y.Z` relay and connector indexes the Server bakes in by digest can
publish; version tags, channels, and release finalization retain their gates.
The gated relay and connector publish jobs point `vX.Y.Z` at the staged digest
and fail if the registry reports any other. Compiler binaries and the compatibility
ledger are prepared once and consumed by both toolkit and Server builds.

Release image cache exports use final-image layers (`mode=min`), a 60-second
export timeout, and `ignore-error=true`. Architecture-specific scopes prevent
AMD64 and ARM64 from replacing the same index. AMD64 CI and the update smoke
continue sharing their architecture's Server scope. Intermediate dependency and
compiler stages may rebuild after a minimal export; the first run also starts
with new cache scopes. The timeout applies to cache export, not the image build
or push. A failed cache export never substitutes for a successful image build.

Metadata-only release PR CI waits at most 20 minutes for an already-running
push check on its exact immutable base. Success permits inheritance; failure,
missing evidence, API errors, or timeout retain full validation. Main pushes do
not wait and keep their existing merged-tree validation.

Every push queues each train's metadata job behind one `release-metadata` lock.
The mobile train's Expo fingerprint (about two minutes) runs before that lock in
`classify-native-changes`, still inside the mobile train's own lock; the
metadata job reuses its verdict only while the latest native release tag still
names the same commit, and recomputes it otherwise. The job runs for every
train so that a skip never propagates to publication. The cost is one more runner
allocation ahead of the lock for every train, and a job-level failure there
(runner, action download, timeout) now stops the backend and website trains as
visibly as a failed metadata job always has.

## Comparison protocol

After merging, record the next two normal backend release runs. Do not publish
a dummy release or skip acceptance to benchmark this change. Separate the first
cold-scope run from the next warm run. Compare:

- Workflow creation to finalization, including queue time.
- Live acceptance start/end and candidate build overlap.
- Image push completion versus cache export completion, for each architecture.
- Cache hits, export timeout warnings, and intermediate rebuild durations.
- Release PR CI inherited versus full-check paths and exact base completion.

Use Actions job/step timestamps and completed BuildKit logs. Keep approval delays
separate from execution time. A 10–15 minute release improvement is a target,
not a validated result; report observed totals before claiming a speedup.
