# Automatic storage reclamation

Verity runs its existing Docker collector at startup, daily, and under disk
pressure. Before image collection it now reconciles session storage and retired
containers. Capacity admission requests one coalesced reclamation pass before
retrying once; maintenance and unresolved build reservations still fail closed.
An admission-triggered pass has a two-minute wait bound; timing out does not
cancel a deletion already in progress or admit the waiting build.

## Dependencies

`verity-dependencies status` recognizes a complete private npm installation or a
compatible installation reachable through Node's ancestor lookup. It compares
tracked manifests, lockfiles, workspace metadata and npm configuration against
the base checkout and rejects unknown workspace manifests. Workspace symlinks
alone do not count as installed dependencies. The pre-push hook uses this check. Existing pnpm installations require a matching installed lockfile; Yarn Classic installations require a successful read-only `yarn check --integrity --offline`. Unavailable or unsupported Yarn integrity checks fail closed. npm v1 source lockfiles are also recognized; this helper installs only npm projects and never changes the package
manager of another project.
When installation is authorized, `verity-dependencies install` reuses compatible
shared dependencies, or installs privately with lifecycle scripts disabled when
the dependency inputs differ. It never installs into another checkout.

Whenever a registered session is not running a turn and has no managed dev server or preview, collection compares private
`node_modules` files with their shared counterparts. Only byte-identical files
and matching links in compatible installations qualify. Local patches, unknown
packages, tracked dependencies, unknown build output and symlink targets remain
protected. A modified or unknown package protects the entire private installation,
preserving dependency resolution through locally patched transitive packages.
Matching relative links to different source trees also protect an installation;
matching link text alone is insufficient evidence. Nested private installations remain protected because their base-checkout
copies are outside Node's ancestor lookup. No package-manager migration or writable hardlink sharing is required.

## Runner package caches and retained execution data

The managed spawn broker gives each project runtime one npm download cache at
`package-cache/npm` below its runner runtime directory. All supported backends
use that project cache, including planning and knowledge-isolated execution.
Projects do not share caches with each other. This changes npm's download cache,
not `node_modules`, dependency resolution, registry credentials or package-manager
selection. General XDG caches, backend state, authentication and transcripts stay
inside their existing session/isolation boundaries. The runner does not otherwise
configure a private pnpm store or Yarn cache; their defaults remain unchanged.

Scheduled collection and **Reclaim now** negotiate cache-maintenance version 2
and turn-ownership version 1 with the supervisor, and admission-fence version 1
with the broker. Older active runtimes remain explicit unsupported blockers.
New turn claims atomically persist the Verity session identity; this is distinct
from a backend conversation identifier. Legacy ownership is resolved from
Server running-turn identities or immutable ingested-frame bindings, with exact
matching of any local start-command and runner-instance identity. Conflicts and
missing evidence never imply settlement.

Live collection scans at most 256 turn-directory entries per request. The
supervisor retains one bounded continuation with a five-minute inactivity timeout.
The Server schedules coalesced one-second follow-up passes, prioritizes unfinished
inventories and rotates regular projects after a deadline. Passes remain bounded
and sequential; Server shutdown cancels follow-up scheduling.
Incomplete scans cannot delete legacy caches. New turn admission invalidates a
scan, and the final broker transaction excludes concurrent claims. A verified
unsettled turn blocks only its owning session. Unmapped ambiguous turns retain
all potentially affected legacy homes, while independently leased shared-cache
maintenance can proceed. Missing-state counts stay visible in diagnostics.

For known inactive sessions, collection removes only
`session-homes/<session-hash>/cache/_cacache`. It acquires the same cross-process
session-home lease as turn admission and rechecks live ownership; a busy home is
retained. Unknown ownership, unsafe paths, symlinks and unsupported broker
versions produce blockers rather than deletion. Files outside `_cacache`,
including private backend caches and session history, remain intact. Archived
known sessions are included; unknown home hashes do not establish deletion.

A sleeping project with no supervisor listener can use a short-lived trusted
sandbox helper without waking its project. This fallback requires the project
lifecycle and preview/storage barriers, fresh idle/session/turn checks, a complete
Docker consumer inventory, the trusted managed default image and no explicit
project image override. Active, special/control-plane and unknown runtimes do not
qualify merely because their socket is absent. Unknown consumers or live leases
retain data. The helper mounts only that runtime subtree, has no network, uses a
read-only root filesystem and bounded resources, and invokes the broker's fixed
maintenance operation. It independently holds an exclusive runtime admission
flock plus home/cache leases. Brokers and their surviving children inherit the
shared admission fence; normal starts wait while offline maintenance owns it.
Project lifecycle admission also checks for unfinished helper containers after a
Server restart, protecting older toolkits that lack the fence. Transport failure
leaves a running or unverified helper and its fence intact. Helpers confirmed
stopped after successful valid results are removed without volumes. Failed work,
invalid results and lost start/wait replies retain at most one verified terminal
helper per project for diagnosis. Scheduled GC and later maintenance attempts use
the same retention check under lifecycle and storage barriers, including result
collection. Removal never forces a running container to stop.

The helper imports and calls the broker's offline operation in one Node process;
it does not keep a second Node runtime alive just to launch maintenance. Its
256 MiB memory/swap ceiling and external 25-second timeout remain unchanged.
Failures back off independently per project, from five minutes up to one hour;
success resets that delay. Pre-helper runtime-state refusals remain immediately
retryable. Retry state is in memory and resets when the Server restarts.

Helper failures include the phase (`create`, `start`, `wait`, `inspect`, `logs`
or `response`), configured `memoryBytes` and `pidsLimit`, and an exit code when
known. Output byte count and an allowlisted `reason` are included when logs are
available, in reports and Server warnings. Reasons distinguish broker import or
capability failures, invalid requests/responses, a busy runtime, maintenance
failure, timeout and resource unavailability. The exact tini `exec timeout failed:
Cannot allocate memory` diagnostic is classified as `resource-unavailable`;
it does not establish that the container memory ceiling caused the failure.
Exit 137 alone is not proof of OOM. Unknown output remains `unknown`; raw output,
exception messages and private paths are never forwarded. `cleanupFailed=true`
marks a secondary cleanup failure while preserving the primary diagnostics.

### Recovering stopped maintenance helpers

Cache-helper retention requires the exact project/component labels, managed name,
matching list/inspect image identity and a known terminal state and timestamp.
Created failed-start containers require verified creation time and are removed
without retaining them: they have never run and would otherwise keep project
admission fenced. Their failure phase remains in bounded reports. Exited/dead
containers use finish time. The newest verified completed-run evidence is retained,
with a deterministic ID tie-break. Older verified helpers are removed non-forcibly without volumes,
including helpers left by older releases. A zero exit code alone is insufficient
to establish a valid result; leftover zero-exit helpers remain diagnostic evidence.
The last retained helper may expire under the existing seven-day GC policy;
other stopped-container grace periods are unchanged.

Running helpers, ambiguous identity or timestamps, failed inventory, and removal
errors prevent further helper creation. These produce
`maintenance-helper-retention-blocked` or a cleanup failure rather than continued
accumulation. Protected unknown runs can temporarily prevent the numerical bound.
A disconnected wait is reconciled only after fresh inspection proves termination.
The existing per-project retry backoff remains unchanged. No manual deletion is
required for this scheduled convergence, and general container/volume pruning is
not a substitute for verified ownership and lifecycle checks.

After an authorized rollout, compare a read-only baseline with fresh cache and GC
`observedAt` reports: helper counts and terminal states per project, retained last
failure, cleanup blockers, selected image/runtime, image pins and filesystem
used/free bytes. Verify an actual successful helper result separately from fewer
containers. Pin estimates overlap shared image layers and do not establish
reclaimable or reclaimed bytes. Startup ENOMEM still requires evidence from the
same runtime and configured container/host limits; neither that message nor code
publication establishes a fix or host OOM. Live pulls, restarts, reconciliation
and cleanup require separate authorization.

### Offline cache policy and reporting

Offline reclamation can clear a known home's regenerable cache despite ambiguous
historical turn state only after proving no consumer can write and acquiring the
exclusive runtime fence. It does not alter the turn state or claim settlement.

The embedded Server's `runnerCacheMaxBytes` setting defaults to 4 GiB per project.
For the Server entrypoint, set `VERITY_RUNNER_NPM_CACHE_MAX_BYTES` to a positive
safe-integer byte count to override the target; unset or blank uses the default,
and invalid values prevent startup.
When the shared npm `_cacache` allocation exceeds that target, collection clears its regenerable
`_cacache` under exclusive maintenance access. Cache users hold shared leases;
maintenance does not interrupt users, and new users cannot enter destructive
maintenance. An active writer defers cleanup and remains visible as a blocker.
The target is a maintenance threshold, not an instantaneous disk quota: an active
project can exceed it until a safe collection pass. `npm cache verify` alone is
not used as a size cap. Cleanup never forces an install or changes a lockfile.
Other entries in the shared npm cache, such as `_npx`, are retained. Their presence
keeps the reported shared allocation unknown/incomplete with an explicit blocker;
eligible `_cacache` cleanup can still proceed independently. The target does not
bound these retained entries.

Runner cache reports expose remaining allocated bytes, removed allocated bytes,
legacy-cache removal counts, shared-cache cleanup counts and blockers. Missing or
partial measurements remain unknown/incomplete. These file-allocation figures
are separate from filesystem free-space change and cannot establish an exact
host-disk saving in the presence of shared allocation or concurrent host activity.
Collection is bounded and sequential; unavailable or unsafe runtimes and inventories
that exceed request limits remain explicit blockers.

Maintenance failures use allowlisted codes in `storageReclamation.runnerCaches.blockers`:
`supervisor-access-denied`, `supervisor-unavailable` (missing socket or no listener),
`supervisor-timeout`, `unsupported`, `supervisor-rejected`, `invalid-response`,
`turn-inventory-unavailable`, `turn-ownership-unknown`, and the corresponding
`broker-access-denied`, `broker-unavailable`, `broker-timeout`,
`broker-invalid-response`, or `broker-rejected` codes. Unrecognized failures are
reported as `unclassified-failure`; arbitrary peer blocker text is withheld as
`unclassified-cache-blocker`. Exception messages, state contents and private paths
are not copied into these diagnostics. Older peers without structured evidence
can still produce an unclassified refusal.

`turn-ownership-unknown` includes bounded `missingState`, `invalidState`, and
`unsettledWithoutSession` counts. A valid unsettled state without a session
identifier is protected just as a missing or invalid state is. Settled states
need no session identifier. These counts explain a refusal; they do not prove
that a turn is abandoned or authorize deletion. A sleeping project's unavailable
supervisor does not cause the collector to wake it; the separately fenced helper
reuses broker validation and leases.

Deleting a session already queues durable cleanup outside session foreign-key
cascades. The existing worker retries broker cleanup, which fences the deleted
session, waits for its children and acquires its home lease before removing the
home. Cache collection reuses that lifecycle rather than treating an unrecognized
home as a deleted session. Archiving or long idleness alone does not delete a
whole session home.

`runners/<project>/turns` contains persisted execution requests, state and events.
There is currently no scheduled age/size retention for these turn directories.
This package-cache collector does not remove them or introduce transcript
retention. Their lifecycle needs a separately approved policy that preserves recovery and
execution evidence. Settled-turn retention remains disabled. A future policy
must require Server acknowledgement of durable terminal ingestion/fencing and
retain a terminal tombstone or permanent pruned-turn index: deleting the whole
turn directory could otherwise let a retry execute the same turn identity again.
Local settled state and age alone are insufficient.

Maintenance prepares a missing trusted default sandbox image on demand. It uses
only the selected repository digest, verifies the local identity after download,
and reserves the reference against image GC until helper use finishes. Cache
maintenance and sleeping-worktree maintenance share preparation; retained Git
template containers continue to supply their own image. Downloads run before
project mutation locks, share work for the same digest, and run sequentially.
Preparation has a 30-second caller deadline (including queue time); the last
cancelled caller aborts and drains its download before releasing the reservation.
A later pass retries after a failed preparation. Server shutdown cancels downloads
and drains active cache and worktree maintenance.

Image failures report `image-unavailable`, `image-preparation-failed`,
`image-preparation-timeout` or `image-preparation-cancelled`, rather than claiming
an unsupported broker. Preparation never substitutes an older sandbox or wakes a
project, and preserves all ownership and idle checks. Publication of an image
does not prove local availability: after an authorized rollout verify the selected
sandbox digest, its local availability and a fresh maintenance `observedAt`.
No separate Docker toolkit image is required for this helper; the sandbox must
contain the matching broker. Existing running runtimes still need supported
reconciliation to gain new capabilities.

Rollout requires both the Server release and the matching sandbox toolkit/broker.
An older active broker cannot perform the new maintenance protocol; the Server
reports that state instead of falling back to direct filesystem deletion. After the usual release
and production promotion, verify the installed sandbox version, cache paths,
activity blockers, remaining cache allocation and filesystem change. Capture a baseline and post-rollout observations of sleeping-helper attempts,
legacy-cache count and allocated bytes removed/remaining, shared-cache allocation,
unknown-home and turn blockers, turn-directory count/allocation, stopped
helper/image pins, and filesystem used/free bytes. Compare growth again after
24 and 48 hours. Verify capabilities of existing custom and default runtimes,
not only the Server version. Rollback disables the new maintenance path and
preserves additive identity metadata; removed npm download caches regenerate on
demand. A successful code test does not establish live host reclamation or a
converged growth trend. Release publication, promotion and deployment require
their normal approvals.

## Worktree lifecycle and recovery

Collection claims the session turn lock and project mutation barrier, excludes
meeting jobs, moves, managed dev servers and previews, and rechecks activity.
Source and Git metadata stay intact while regenerable dependencies are slimmed.
Storage collection waits for an existing project mutation within its one-minute
pass budget, then rechecks active work. Timeout retains the existing owner and
reports a blocker; collection never clears another operation's lock.

A session with a closed or merged PR may have its whole worktree retired after
seven idle days only when its current commit is reachable from a freshly fetched
remote branch, the worktree has no changes, stashes or index flags that hide changes, and no unknown untracked
or ignored files remain. A closed PR alone does not prove work has been saved.
The base checkout, document workspaces and Knowledge are never retirement targets.
Git errors and uncertain ownership retain the worktree and appear as blockers.

Managed worktree locks are released only after safety checks and restored on
failure or resume; unknown lock reasons retain the worktree. Sandbox Git uses
clone-relative mutation paths and translates inventory paths back to the host.

Before non-force Git removal, a dedicated Git ref pins the exact commit and a
synced recovery record is atomically written under the base repository's
`.git/verity-storage`. It preserves the session identity, path, branch, commit
and worktree sidecar. The session and transcript are kept. Resume restores the
worktree while holding the session turn lock, verifies the commit, repairs
workspace links, and only then clears its recovery record. If the branch moved
meanwhile, restoration uses the saved commit detached and preserves that branch.
Sleeping-project maintenance uses an isolated sandbox with a writable checkout,
a read-only root filesystem and disabled Git hooks. Its default metadata-query
mode remains read-only and offline. Missing retired project containers use the
current sandbox image with bounded resources. Maintenance helpers stop after two
minutes and carry explicit ownership labels; GC can retire stopped leftovers
after seven days. Remote verification must succeed;
Forgejo retirement currently retains worktrees while dependency slimming remains
available. GitHub fetch authorization is scoped to GitHub and is not persisted.
An interrupted removal or restoration can be retried safely; unknown paths are
not recreated without a matching record.

Registered orphan worktrees are discovered through Git's worktree inventory,
not directory-name guesses. First observation is recorded durably; deletion
requires another seven days and the same local-work and remote-reachability
checks. Orphan recovery records and pinned commits remain available for manual
recovery. Collection never force-removes a branch.

## Containers and release images

Outdated project sandboxes stopped for at least 24 hours and eligible stopped
relays can be removed under the same project/preview lifecycle barriers used by
starts. For sleeping projects, the grace starts at the durable sleep transition,
not Docker's latest stop timestamp. A temporary vulnerability-scan wake restores
the original sleep timestamp only if no other work took over. Explicit image overrides are protected. Stopped containers of deleted
projects need seven days and Verity identity labels. Unknown containers, including
unlabelled containers merely using a Verity image, remain protected.

Removal uses Docker's non-force, volume-preserving API. A start that wins the
race causes Docker to refuse removal. Project workspaces stay on their existing
volumes; the next wake recreates a missing sandbox from the current configured
image. The last-used default image of a sleeping project is historical, while
explicit overrides and in-flight image reservations remain protected. Every
container still present continues to pin its image.

After successful managed deployment and companion reconciliation, completed
Compose seed/init jobs are removed without their volumes. Failed jobs remain
available for diagnosis. GC also reconciles old successful bootstrap jobs once
a newer matching Compose server is running. The two-generation release-image
retention policy remains unchanged, including under low disk.

## BuildKit and diagnostics

The root-owned snapshotter reconciler publishes `native-retirement.json` next
to its migration status. It retires only the canonical `runc-native` directory,
under the install/migration lock and the exclusive admission fence. Overlayfs
configuration and worker verification, no migration recovery, a complete mount
inventory (including descendant mounts), known consumers, no runtime leases and
no in-use cache records are required. A fresh root-owned challenge additionally
requires every running socket consumer to attest an independent empty on-disk
reservation inventory. Unknown files and remote-operation records block deletion;
this check never reconciles or removes reservations. Stopped socket consumers
without independent evidence also block retirement. Their presence must be
resolved through existing lifecycle/maintenance processes, not by forging receipts
or deleting lease markers. Missing, stale or incomplete evidence retains data.

The reconciler journals the exact transaction and fences admission before stopping
the dedicated daemon, renames native state to a fixed quarantine on the same
filesystem, starts and verifies the overlay worker with a bounded gVisor probe,
and only then removes the quarantine. Shared daemon metadata and overlay state
are preserved. A durable marker prohibits automatic native rollback after
retirement. Interrupted work retains its journal and admission blocker until a
subsequent pass can verify and finish recovery; an unsupported state requires
maintenance. File allocation and filesystem free-space change are reported
separately. Other host activity can affect the latter; no exact future saving is
guaranteed by an inventory estimate.

The matching signed host-builder bundle must be installed as well as the Server
release. The existing root-owned snapshotter timer services native requests on its next
minute pass. The Server writes only a fixed request file in the dedicated
group-writable evidence directory; requests carry no executable command or path.
No additional systemd unit is installed, so existing host-bridge rollback coverage
continues to cover the complete helper bundle.
No host state mount or general root-execution API is exposed. Old host helpers
remain safe but cannot perform the new action. Existing BuildKit cache settings
are unchanged.

## Manual reclamation

Administrators can use **Settings → Diagnostics → Host storage → Reclaim now**.
The confirmation describes effects across all projects. The authenticated,
origin-protected API is `POST /settings/storage/reclamation` with no body;
`GET /settings/storage/reclamation` reports status. Both require active
administrator membership. The POST returns 202 without waiting for a long pass;
concurrent requests reuse the scheduler's single-flight collector, also used by
scheduled and capacity-admission passes. Native host work is asynchronous and is
reported as pending until a host receipt arrives. A completed Docker/dependency
pass does not imply completed native retirement. Refresh remains available if
leaving the screen stops polling. There is no additional unaudited Control tool;
the existing Control diagnostics can read results.

Results separate removal counts, retained-container reasons, dependency blockers,
actual observed filesystem free-space change and native receipts. Release-image
retention, stopped-container grace and whole-worktree retirement safeguards apply
equally to the manual action. It does not force-delete protected resources.

`verity_diagnostics` includes the last GC result, containers retired, images
pinned by stopped containers and their estimated sizes, per-image pin reasons,
session-storage blockers, dependency bytes compared, database size, and available
native/overlay host inventory. Missing measurements are unknown, not zero. Image
sizes and file blocks can double-count shared layers or reflinks: never sum them
with filesystem totals or interpret them as measured bytes freed. Database
retention and unrelated host workloads are outside this collector's ownership.

Missing or invalid native retirement receipts are reported as blocked with unknown
byte counts, rather than omitted. A missing receipt does not prove the helper is
absent: verify the matching host bundle, its timer and the Server receipt mount.
Stale or future-dated receipts retain their timestamp and gain an explicit blocker.
A synthetic missing-receipt report uses the Unix epoch as an unknown-time sentinel.
Blockers remain visible while a manual host request is pending.
