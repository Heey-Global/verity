# Release performance

Run [372](https://github.com/Heey-Global/verity/actions/runs/35106702701)
completed in 41m56s on 2026-09-16. Its Server ARM64 image was pushed at
14:42:04 UTC, but cache export continued until 14:47:15. Sandbox AMD64 and
preview edge AMD64 each spent approximately another 2m22s exporting cache after
image export. These intervals overlap other work; they are not additive savings.

Candidate sandbox and relay builds now overlap live acceptance. Only temporary
SHA/architecture tags can publish before acceptance; version tags, channels, and
release finalization retain their gates. Compiler binaries and the compatibility
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
