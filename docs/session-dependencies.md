# Session dependency preparation

Session checks use the project's own lint, formatting and test dependencies.
Finding an executable on a parent directory's `PATH` is not evidence that the
project's complete dependency tree matches its current manifests and lockfile.
`verity dependencies status` and `verity dependencies install` use the same
compatibility checks as the pre-push hook.

## npm release-age verification

The native npm `min-release-age` option filters dependency resolution. It does
not protect `npm ci` or all existing lockfile/cache cases. Managed sessions also
verify every pinned registry package version against public registry publication
metadata before installation or reuse. The minimum is three days; a stronger
project or effective native setting is retained. npm 11.15 or newer is required
before the wrapper reports native npmrc age protection as supported.

For an install or update, the wrapper first resolves a lockfile with
`--package-lock-only`, with lifecycle scripts disabled. It verifies that tree,
then installs the frozen tree with `npm ci`. Resolution can update manifests and
the lockfile even if subsequent age verification blocks installation. A
lockfile-only request stays lockfile-only. The reuse verification path neither
resolves nor installs packages or writes protection configuration.

Missing, malformed or unavailable publication data blocks the operation. Young
releases require an explicit exception for the exact versions in that operation;
a saved choice about setting up native protection is not an age exception.
The permission request identifies versions and their earliest eligible times.
Unknown publication dates cannot be approved as age exceptions.

The server caches validated publication timestamps for five minutes, bounded to
10,000 version records. It recalculates eligibility and checks current authority
on every request; it never caches an approval. Artifact downloads independently
revalidate current registry metadata, package identity and integrity. The
temporary artifact token limits downloads to the checked npm inventory, retains
the effective age threshold and permits only explicitly approved exceptions.
It expires after 30 minutes and is revoked when the wrapper completes. A killed
wrapper can leave a token until expiry; retirement of its original project
capability or container generation also invalidates it.

Publication verification and selected tarball metadata are parsed as streams,
with a 32 MiB transfer limit and bounded retained fields. General registry
metadata responses used for native resolution retain their existing 2 MiB
limit; unusually large resolution responses can still fail with a bounded
metadata error rather than being buffered without a limit.

Global installs, unsaved installs and npm executable-fetch operations cannot
provide a frozen project inventory and are rejected by this path. Install a
dependency in a project first, then use the project's scripts. Arbitrary Git,
remote tarball and private-registry dependencies are not treated as public npm
releases. Local source and workspace dependencies have no npm publication date.
Other package managers retain their existing native policy paths; this change
does not establish equivalent lockfile protection for every ecosystem.

## Reuse and interrupted preparation

The helper prefers a complete, compatible local or reachable shared installation.
Managed successful private installations can also be reused across session
worktrees: each session gets its own directories, with package files as hard
links to the read-only central inventory, and workspace links restored for the
destination session. Writable files are never shared between sessions; writing a
shared file fails, and `verity dependencies install --private` gives a session
writable copies of its own.
Compatibility includes dependency manifests, lockfiles, npm configuration and
runtime identity (including libc), rather than only the presence of `node_modules`.
Existing npm trees without a managed `.verity-install.json` receipt cannot prove
these inputs and require one managed preparation. Their files are preserved;
subsequent checks and compatible sessions can reuse the verified result.
Packed local `file:` sources also participate in identity; traversal is limited
to 64 MiB and 10,000 entries and rejects unsupported symlinks or special files.
Linked workspace sources remain live in the receiving session.

The internal cache retains at most two generated installation snapshots. When
publishing another identity, it retires the oldest idle validated snapshot under
its identity lock; active preparations and session or recovery files are never
evicted. If every slot is busy, the successful local installation remains usable
and snapshot publication is deferred. Snapshot files are disposable generated
state; make package changes in the session workspace instead.

Preparation is coordinated per checkout and installation identity. Native
protection setup completes under the checkout lock before the preparation
identity is frozen, so an approved `.npmrc` change does not force another install.
The effective default global npm configuration participates in identity too.
A successful native exit alone does not mark an installation complete: required package
receipts and workspace links must validate first. Only completed installations
are published for reuse. Existing partial or incompatible files are preserved
outside the active dependency path so they cannot shadow shared dependencies;
diagnostics report their recovery location. Locally changed package contents are
not deleted to repair preparation.

Direct installs also preserve existing root and workspace dependency trees before
the frozen `ci` step. If a mounted or separate-filesystem tree cannot be moved
safely, preparation fails while leaving its files intact. Recovery files are not
automatically removed.

An interrupted command reports failure and does not produce a successful reuse
receipt. The caller must wait for preparation and inspect its exit status before
running checks or finishing the turn. Background shell processes are not durable
continuations. Lint, formatting, secret scanning and code review gates remain in
place; repeated installation failures are not a reason to skip them.

## Deployment and verification boundaries

The server, toolkit package-manager wrapper and session seed helper must all be
updated. Existing containers retain installed toolkit files until rebuilt or
recreated through their normal managed lifecycle; updating repository source
alone does not update an already running sandbox. The helper refuses managed
reuse verification when the required companion verifier is missing.

Regression tests cover publication dates, exact exceptions and token revocation,
cached inventories, lockfile changes, dependency identity, concurrent preparation,
interrupted retries and preserved partial files. These fixture and source checks
do not certify a deployed container or reproduce a particular historical session
termination. Verify a recreated sandbox with two compatible session worktrees,
one changed lockfile and an interrupted preparation before declaring live rollout
complete.

## Copy capacity and recovery admission

Managed activation measures the complete root and workspace installation before
creating another tree. It walks at most 250,000 entries for 20 seconds, never
follows symlinks, and refuses an incomplete or unreadable inventory. The measured
full-copy bound includes files that may subsequently be shared. Both root and
hard-link fallback paths must retain the configured build reserve (by default
10 GiB and 1,000,000 free inodes). `install --private` uses the same admission
before changing package files. Refusal preserves the active installation and
recovery data and reports the measured requirement and available capacity.

An installation may retain one measured full installation's worth of recovery
blocks. Before replacement, the helper accounts for existing preserved trees and
all root/workspace trees that it cannot prove unchanged. If that would exceed the
larger of the measured replacement footprint and the newly preserved data, it
refuses the replacement before moving any active tree. The allowance uses the
requested replacement, not the current installation: a previously unknown
identity must first be prepared and measured, while an existing central inventory
can be checked before preparation. This allowance is based on
bytes, not directory counts: small workspace recovery trees do not each consume a
full installation slot. Unknown recovery content remains protected. Resolve its
unique edits before explicitly approving removal of redundant recovery data;
waiting for an age threshold does not establish that it is disposable.

All dependency preparation, activation and private-copy commands in a project
hold a cross-process capacity lock. The npm child inherits that lock, so a killed
supervisor cannot admit another dependency copy while npm continues writing.
The activation record retains the full-copy estimate, actual copied file count
and allocated bytes, sharing mode, reserve and observed free capacity.

Managed sessions additionally require a current Server grant from
`/internal/dependency-storage`, authenticated with the existing project broker
capability. Measured activation and private copies reserve their complete copy
bound; central npm preparation reserves the Server's conservative preparation
estimate because a lockfile does not bound downloaded or unpacked bytes. These
grants share capacity accounting with other projects and build reservations.
Each request has a 30-second deadline; missing or stale protocol support blocks
additional dependency work. Standalone tools without a managed session retain
the local filesystem checks.

The helper reserves one operation identity, opens its root-owned lock read-only,
acquires a shared kernel lock and obtains a start acknowledgement before writing
additional dependency data. Lost replies are checked against the same identity.
Descriptor 4 carries the holder through the package wrapper and native npm; a
trusted preload forwards it through Node's asynchronous and synchronous child
process APIs, including children with explicit environments. A conflicting use
of descriptor 4 is refused rather than dropping the holder. This supports
legitimate npm descendants; it is not a sandbox for hostile package processes.
The holder survives a killed helper while an inherited writer remains alive.
Settlement is only a hint: the Server releases the reservation after exclusive
lock acquisition proves all holders closed. A missing acknowledgement or a
surviving child leaves the reservation uncertain and charged for reconciliation.
A stopped, replaced or removed sandbox whose broker evidence is unavailable
remains uncertain. Neither a reused container name nor an empty inventory on a
possibly changed Docker daemon proves termination of the original writer.
Automatic release across those transitions requires a durable original-daemon
identity and independently verified termination; this protocol retains the
allowance until it can prove retirement through the original generation.

Legacy builds without host admission retain their own durable operation journal.
Disposing a local call cannot release dependency admission while its remote
outcome or any recorded child process group is still unconfirmed. These journals
survive Server restarts and use the existing build reconciliation evidence;
unaccounted host admission markers also keep new dependency work paused.

Admission estimates and live free-space checks are conservative safeguards,
not filesystem quotas or a guarantee against unrelated writers consuming the
reserve afterward. Existing installations and recovery files are never removed
to manufacture capacity for an admission.
