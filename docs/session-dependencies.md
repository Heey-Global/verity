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
worktrees through independent copies, with workspace links restored for the
destination session. Writable packages are never hardlinked between sessions.
Compatibility includes dependency manifests, lockfiles, npm configuration and
runtime identity (including libc), rather than only the presence of `node_modules`.
Packed local `file:` sources also participate in identity; traversal is limited
to 64 MiB and 10,000 entries and rejects unsupported symlinks or special files.
Linked workspace sources remain live in the receiving session.

The internal cache retains at most two generated installation snapshots. When
publishing another identity, it retires the oldest idle validated snapshot under
its identity lock; active preparations and session or recovery files are never
evicted. If every slot is busy, the successful local installation remains usable
and snapshot publication is deferred. Snapshot files are disposable generated
state; make package changes in the session workspace instead.

Preparation is coordinated per checkout and installation identity. A successful
native exit alone does not mark an installation complete: required package
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
