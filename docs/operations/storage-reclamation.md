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

## Worktree lifecycle and recovery

Collection claims the session turn lock and project mutation barrier, excludes
meeting jobs, moves, managed dev servers and previews, and rechecks activity.
Source and Git metadata stay intact while regenerable dependencies are slimmed.

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
starts. Explicit image overrides are protected. Stopped containers of deleted
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
