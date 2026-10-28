# Dedicated gVisor builder

The Server builds repository devcontainers on a dedicated host BuildKit daemon.
Every OCI build command uses gVisor (`runsc`); the resulting image is exported
and loaded into the project Docker Engine. The Server's image-loading Docker
socket is never mounted into the build worker. No worker failure starts a
replacement Docker worker.

## Supported deployment

This integration requires a Linux host with systemd, Docker Engine, and the
pinned gVisor release in `deploy/gvisor/versions.env`. The installer handles
amd64 and arm64 using those checksums; the host-service CI currently exercises
ubuntu-26.04 amd64 only. Docker Desktop, rootless systemd, remote TCP BuildKit,
and non-systemd hosts are not covered by this deployment. A source-run Server
must have the pinned devcontainer CLI and Docker buildx installed on PATH.

BuildKit is a trusted root host daemon. It requires mount and network namespace
privileges and cgroup delegation. It does not run in a privileged Docker
container. The systemd unit hides Docker/containerd sockets, makes the host
filesystem read-only except for builder state, and limits the service to half
the host's CPUs (at least one), a quarter of its memory kept between 2 GiB and
8 GiB, no swap, and 512 tasks. `resources.sh` derives those limits and the
installer writes them into the unit, so they follow the host on every
installation and update. The OCI worker runs one operation at a time and
disables insecure entitlements and the containerd worker. Fresh installations use `auto`, which selects overlayfs where supported and
otherwise native. Updates preserve the configured OCI snapshotter, including
`native`. Snapshotter changes and deletion of old worker directories require
separate maintenance. BuildKit GC bounds eligible cache independently of active
snapshots, Docker images and exported archives; its budget is not an active-build
peak limit. A build can
use outbound networking; this service does not implement egress policy.

## Build-step network

Each `RUN` step gets its own network namespace, attached through CNI to the
host bridge `verity-bk0` and NATed to the host's uplink, as Docker attaches a
container. BuildKit's host-network default cannot be used with gVisor: it gives
the step no interface, so runsc's sandbox network stack cannot resolve or reach
anything. The CNI plugins (`bridge`, `host-local`, `loopback`, `firewall`) come
from the release archive pinned in `cni.env`, verified by checksum and
re-extracted on every installation. The bridge has no IPv6 address.

BuildKit keeps a step's namespace and hands it to the next step, while runsc's
sandbox network removes the addresses and routes of the interface it takes over.
Without intervention only the first step after a builder start would reach the
network. `runsc-netns.sh` records the interface's IPv4 address and default
route before each `run` and restores them after runsc exits, so the reused
namespace stays usable. Reuse does not add NAT or forwarding rules.

Steps reach the same destinations a project sandbox on its Docker network
reaches: the internet, and through NAT whatever the host can route to. They do
not share a network with project sandboxes. They do share the `verity-bk0`
bridge and its subnet with each other: a namespace per step separates their
interfaces, not their network, and nothing filters traffic between addresses
on the bridge. The worker runs one step at a time, which limits but does not
remove that exposure.

The subnet is chosen on the host, never fixed in the product. Before every
builder start, `network.sh apply` takes the first `/24` from `10.213.0.0/16`,
then `10.247.0.0/16`, that overlaps no host route in any routing table, no
Docker network, no Docker address pool (configured or default) and not
`100.64.0.0/10`. The choice is stored as `SUBNET` in
`/etc/verity-buildkit/network.env` and kept while it stays free. If a later
route takes it, such as a new VPN, the next start moves to a free range and
logs the move; steps keep no network state, so a move is safe. To choose a
subnet yourself, set `PINNED_SUBNET=<prefix>` in that file and restart
`verity-buildkit`. A pinned subnet that overlaps something is refused with the
overlap named, never replaced. If every candidate is taken, the builder does
not start and says so.

## Installation and upgrade

### Managed installations (`install.sh` / `verity-install`)

The installer sets the builder up on systemd hosts, on a first installation and
on every repair run. It runs `deploy/buildkit/install.sh`, waits for
`verity-buildkit.service` to be active and for its socket to exist, and only then:

- passes the socket's group to the managed bootstrap, which seals the read-only
  `/run/verity-buildkit` bind and that group into the Server's deployment spec;
- records `devcontainer-builder.json` in the host runtime directory, so the
  Updater can apply the same change during a later update.

### Builder updates

The builder is a host service, so a Server image alone does not change it. On
hosts set up by an installer that includes `verity-host-builder`, every guarded
Server update brings the builder to the one its release ships:

1. A release image that carries this bundle declares
   `org.verity.devcontainer-builder=2`.
2. After registering the gVisor runtimes, and before the standby is created, the
   Updater writes `builder-request.json` into the host runtime directory. The
   request names only the official target image digest.
3. `verity-host-builder`, started by its systemd path unit, pulls that digest
   from the registry and verifies the image's release signature with the pinned
   cosign verifier. It then copies `deploy/buildkit`, `deploy/gvisor` and
   `deploy/host/verity-host-runtime` out of the verified image and refuses a
   bundle that contains a symbolic link.
4. It compares the bundle's content hash, documentation excluded, with the one
   recorded at the last installation. An unchanged builder keeps running, and
   builds in progress are not interrupted.
5. Otherwise it keeps the current builder files aside and runs the bundle's
   `install.sh` with the recorded socket group. It records the new hash only
   once the unit is active and its socket exists. A failed installation, an
   interruption (including systemd stopping the unit), or a builder that does
   not come back restores the previous files and restarts the previous builder.

Staging, the signature verifier, the kept-aside files and the record live in
`/var/lib/verity/host-builder`. That directory is root-only and not mounted
into any container. From the shared host runtime directory, the component
reads only the request and the installer's receipt.

A builder that cannot be updated does not hold back the Server update. The
Updater logs the reason, the previous builder keeps serving, and the next
update asks again. Hosts set up before `verity-host-builder` existed have no
component to ask: run the installer once. That run installs the current
builder directly as well.

The request carries no files and no code. The trust anchor is the Server
release signature, which the host checks itself, so a requester can only
choose among signed Verity releases. That includes an older one, whose builder
is then installed, as a rolled-back Server would need.

Deployments sealed before this release are migrated by a repair run (rerun the
installer and choose "Repair"). The migration adds only the socket bind and its
group; every other sealed setting is kept, and the previous spec is preserved
once as `server-deployment.before-devcontainer-builder.json` in the
updater-owned deployment root. A repair never overwrites that backup.

The repair does not restart a running Server. It keeps serving, the Updater
reports the builder as pending, and the next guarded Server update creates the
replacement with the bind. A stopped Server is recreated with it immediately.
Until then, repository builds report that no builder is available.

If the builder cannot be verified (no systemd, a failed install, a socket that
does not appear), the run continues without it, removes any earlier receipt,
and says so. Nothing is sealed for a builder that was not verified, and a spec
without the bind stays valid. A Server built from such a spec reports
repository builds as unavailable instead of naming an endpoint nothing serves.

Releases that predate the builder bind cannot parse the migrated spec. Rolling
back below this release requires the preserved spec and its matching image,
restored through the normal stopped-deployment maintenance workflow, as for the
host diagnostic bind.

Re-running the installer restarts the builder and interrupts repository builds
that are in progress.

### Unmanaged (Compose) installations

1. Drain new project builds and let active builds finish. Back up deployment
   configuration. Existing project containers can remain running throughout.
2. On the Docker host, run `sudo bash deploy/buildkit/install.sh`. This verifies
   and installs pinned gVisor, extracts the pinned BuildKit daemon without
   starting that image, and starts/restarts `verity-buildkit.service`. The gVisor
   installer reloads Docker runtime configuration without restarting containers.
   Re-running this script restarts the builder and interrupts active builds.
3. Add `deploy/docker-compose.buildkit.yml` to the Server's Compose inputs.
   Mount the socket directory only into the trusted Server. Its Unix group is
   `verity-buildkit` (GID 1102); choose an unused GID using
   `VERITY_BUILDKIT_GID` for both installation and Compose if necessary.
   Do not change socket permissions to world-writable.
4. Check `systemctl status verity-buildkit` and `journalctl -u verity-buildkit`.
   Provision a disposable project with a Dockerfile and Feature; confirm its
   image was loaded into the project Engine. Stop the builder and verify that
   another build fails without replacing an existing running sandbox. CI runs
   this check using the actual Server build spawner and records OCI evidence.

### Endpoint

An explicit `VERITY_DEVCONTAINER_BUILDKIT_ENDPOINT` must point to a private
local Unix socket (`unix:///run/verity-buildkit/buildkitd.sock`). Only trusted
instance configuration supplies it. Without it, the Server uses
`/run/verity-buildkit/buildkitd.sock` when that socket exists, which is only the
case when the trusted deployment mounts the builder's runtime directory. With
neither, repository builds fail with a message pointing to an installer repair;
existing containers are not affected. To avoid repository builds for a project,
PATCH its settings with `{"devcontainerEnabled":false}` before the next
provision/recreate. This skips repository lifecycle configuration as well.

The injected Node Feature is pinned in `provisioner.ts`. The toolkit selected
from the Server bundle is resolved to a manifest digest before computing the
image cache key. Resolution failures or repository changes fail closed. Private
registries must supply an explicit toolkit digest; anonymous tag discovery does
not authenticate to private registries. This pin is an integrity check, not a
publisher signature. Runner boundary attestation still compares the resulting
toolkit with the signed Server's bundled trust root. A mismatched toolkit is
rejected there. No production rollout is implied by the integration tests.

### Storage contract upgrade

Storage management uses builder bundle contract 2. Hosts with the contract-1
host updater need one installer Repair from this release before they can apply
contract-2 builder updates. The old host component deliberately refuses the new
bundle: it does not know how to back up the additional storage service units.
A Server update can therefore finish on a host whose builder lacks managed
admission. Such a host shows neither `build-admission.lock` nor `leases` in
`/run/verity-buildkit`, and Control diagnostics report `builderAdmission` as
`not-provisioned`. Its repository builds keep the unmanaged path they used before
storage management existed: no host lock, no host storage report and no storage
admission, as on releases before contract 2. The Server logs this once, and the
Updater names the installer Repair the host needs. Such a build looks again before
its BuildKit solve and its image import: if a Repair has provisioned the host in
the meantime, it holds the shared lock and a lease marker like a managed build, so
snapshotter maintenance waits for it, or it fails with a retry while maintenance
already holds the lock.

Every other state stays closed. A directory with only one of the two markers is
`incomplete`, a `migration-pending` marker or an exclusively held lock pauses new
builds, and an unreadable directory is never taken as unprovisioned. The Repair
installs the bridge and the contract-2 builder, after which the next build is
admitted through the lock. Configure and verify the storage roots below before
testing a build.

Subsequent guarded builder updates include both storage units in their scoped
backup, retain host policy files, and restore timer activation/enabling on failure.
A Server rollback keeps the current compatible builder unless its release
explicitly supports this builder contract. Do not downgrade the builder by
running an older installer that deletes snapshotter state. Keep the previous
Server image and deployment configuration for rollback; cache or project data
removal is not part of rollback.

The service cache lives under `/var/lib/verity-buildkit`. Do not delete it during
active builds. Service upgrades and host maintenance should drain builds first.
Keep the previous pinned installation/deployment available for rollback; never
replace gVisor with `runc` to recover build availability.

## Derived image lifetime

The Server records the selected image on each project. Image collection reads
those durable selections, including explicit overrides, on every pass. A hidden
(deleted) project no longer retains an image; another visible project selecting
the same image still does. A stopped container protects its image just as a
running container does.

The provisioner reserves a derived tag before testing the cache or starting a
build and releases it after the whole provision/recreate attempt settles. The
collector shares that reservation gate, so it cannot remove an image between a
cache hit or image import and container creation. This assumes one active Server
owns a project Engine; concurrent independent Servers collecting the same Engine
are unsupported. After restart, project selections and Docker container
references remain authoritative; temporary reservations belong to the process
performing the provisioning attempt.

Deleting a project triggers an image-only collection after the row is hidden.
Unreferenced generations for repositories with no visible project are eligible
immediately. Visible repositories retain the configured generation count, even
under disk pressure, in addition to referenced images. Images are never removed
with force. A failed reference read skips image collection; a failed deletion is
logged and retried by the existing boot/daily/disk-pressure collector. A cleanup
failure does not undo project deletion. Named data volumes and the dedicated
BuildKit service's cache follow their existing, separate retention policies.

## Storage admission and owned artifacts

The Server admits one context/build/export/import attempt at a time across all
projects. Another request receives an actionable busy error and can be retried;
it does not allocate another context or TAR while waiting. A context requires
room for its existing 2 GiB input limit before copying starts. A cache miss then
reserves the complete estimated remaining build growth through image import.
Image-reference reservations continue to protect the imported image through
container creation, independently of disk admission.

Contexts, temporary registry credentials and TARs live below the Server data
root's private `build-storage/attempt-*` directories, rather than container
`/tmp`. Confirmed successful operations and failures before remote work remove
their owned files normally. Commands run in tracked process groups, but stopping
a client does **not** establish that a remote solve or Engine import has stopped.

Before each remote build/export or import, the Server durably records the
operation, host identity, host boot ID and the attempt's admitted estimate, when
the host storage report supplies the identity. The record is cleared when:

- the command succeeds;
- the command exits on its own and its last report is the remote side's final
  answer: for an export, `failed to solve` (also when wrapped in `failed to
build`) naming a build step's exit code; for
  an import, the Engine's `Error response from daemon` that is not a transport
  failure;
- reconciliation proves the operation ended. The Server reconciles at start and
  every five minutes. It releases a record when the host booted again since the
  record was written, or once the operation's client is gone and — for an
  export — the BuildKit worker then lists build history with only finished
  builds (`docker buildx history ls` through a private remote-driver record; an
  empty or unreadable history, or an unrecognised status, is no answer) for a
  record written before it was asked. The record is written before the client
  submits its work, so the worker's answer alone is never enough. A client in
  the same PID namespace is gone when its process group has exited, checked
  again after the worker answered; one of a previous Server container cannot be
  observed and is trusted gone after an hour (an import client is bounded by 15
  minutes, a build command by 30). A malformed record is never released
  automatically and holds the default estimate until it is reconciled offline.

A timeout, cancellation, lost connection or Server crash keeps the record **and
all potentially in-use owned artifacts**, including private registry
configuration. These files remain private (directory mode 0700, credential mode
0600). Such an attempt no longer blocks other builds: it holds only its own
admitted estimate (or `VERITY_BUILD_ESTIMATE_GIB` for a record written before
estimates were recorded) against admission, and Control diagnostics list it
under `buildStorageReservations` until reconciliation releases it. Without
identity fields no record is written, so remote work then runs without one, as
an unmanaged build does, and the Server logs that once. Repair an older builder
installation to restore the record.

Attempts with no pending remote operation are removed when their recorded local
owner and command groups are definitively gone in the same PID namespace. An
attempt of a previous Server process (another PID namespace) is kept, without
blocking, until its host boot changed or it outlived every command bound (two
hours). No project volume, clone, worktree, rollback image or BuildKit snapshot
is an owned attempt artifact.

The output tail of a project's last failed devcontainer build (100 lines) is kept
under the Server data root's `build-failures` directory and reported as
`projectBuildFailure` in project diagnostics until a build of that project
succeeds.

### Offline reconciliation after an uncertain operation

No normal failure path needs this. It remains a last resort for a record that
automatic reconciliation cannot release, for example while the BuildKit worker
stays unreachable. It requires a **maintenance outage of the build host**, not
just a Server restart. Do not delete marker files by hand: the evidence the Server
uses (a host reboot, the worker's build history, an import client's exit) is the
only evidence it accepts, and cache usage or image presence prove nothing.

1. Record the reported `attempt-*` name and locate its **host-side** directory
   under the Server data volume's `build-storage` root. Keep the reviewed
   repository checkout and a compatible Node.js executable available on the host.
2. Arrange console access and reboot that same host into systemd emergency mode
   (the one-boot kernel argument `systemd.unit=emergency.target`). This ends all
   work from the recorded boot and prevents normal runtime/socket activation.
   This interrupts every workload on the host; schedule it deliberately.
3. In the host console, with the data filesystem mounted writable, run from the
   reviewed checkout:

   ```sh
   sudo node scripts/build-storage-reconcile.mjs --attempt /absolute/server-data/build-storage/attempt-ID
   ```

   The tool verifies the same machine identity and a different boot ID, active
   emergency mode, inactive normal/socket targets, stopped BuildKit/Docker/
   containerd services, and absence of Server/runtime processes. It refuses
   ambiguous evidence. It deletes only the selected owned attempt directory;
   no daemon, image, cache, project or other attempt is selected. Run separately
   for each reported pending attempt. A malformed or missing host identity
   requires investigation; the tool deliberately provides no force flag.

4. Return the host to its normal boot target using the host's established
   maintenance procedure, refresh storage diagnostics, and retry the build.
   Normal disk/inode admission still applies.

This path does not cancel a live remote operation and does not prove that a
smaller storage estimate is sufficient. Representative native-workload sizing
remains separate acceptance work.

| Setting                     | Default | Meaning                                                                         |
| --------------------------- | ------- | ------------------------------------------------------------------------------- |
| `VERITY_BUILD_ESTIMATE_GIB` | 24      | Total context, snapshot, export and import growth estimate for an unknown build |
| `VERITY_BUILD_FREE_GIB`     | 10      | Free-byte reserve left after admission                                          |
| `VERITY_BUILD_FREE_INODES`  | 1000000 | Minimum free inode count                                                        |

These positive integer settings belong to the trusted Server environment. The
unknown-build fallback is 24 GiB. When the target or previous project devcontainer
image is present, admission instead uses 2 GiB for context plus twice the largest
measured uncompressed image size, clamped to 12–96 GiB. One image-size allowance
covers the export archive without assuming compression; the second covers changed
snapshots and import growth with shared unchanged layers. Only two image references
are inspected; missing, invalid or unavailable measurements use the fallback.
This heuristic **is not an upper bound for arbitrary Dockerfiles** or a measured
peak allocation. The fallback setting applies only to unmeasured builds.
The running build's two-second reserve check
still stops a build that outgrows the estimate before the disk is full. Admission
estimates and periodic checks cannot enforce a filesystem quota or guarantee
that another host workload will not exhaust the disk between samples.

Every active command checks the reserve every two seconds. Host measurements
come from the storage timer every 15 seconds and must be no more than 120 seconds
old. Admission acts on measurements only: it charges the full estimate against
the lowest available capacity and inode count across the local staging
filesystem and every host root that was measured, and rejects when that is too
little. Unknown topology never permits independent free-space budgets. A
missing, invalid or stale report, or a duplicate or unavailable root, is a gap
in that evidence, not a measurement of low space: the build is admitted on what
was measured, the Server logs the gaps when they change, and Control diagnostics
report them as `buildStorageEvidence` (`complete` or `partial`, with the gaps).

## Filesystem evidence and cache policy

`verity-build-storage.timer` publishes
`/var/lib/verity/host-diagnostics/storage.json` atomically. The Server reads it
through its existing read-only `/run/verity-host-diagnostics` mount. Collection
does not prune, run builds or traverse project files. It reports filesystem IDs,
mounts, byte capacity and inodes separately for BuildKit, Docker, containerd,
export and project roots. A bounded `buildctl debug workers` response reports
current worker labels separately; Docker's driver and old state-directory names
are never treated as proof of the BuildKit snapshotter. Active-solve attribution
is explicitly unavailable in this report.

Docker Engine may keep image content and snapshots in containerd outside
`DockerRootDir`. Without configuration, the publisher reads that root from the
running root-owned containerd that serves the address `docker info` reports for
Docker's containerd. The daemon's own command line decides: `--root` and
`--address` override its configuration, and `--config` names the file, read as
data in the containerd 1.x (`[grpc]`) or 2.x
(`[plugins.'io.containerd.server.v1.grpc']`) format, with containerd's built-in
defaults (`/var/lib/containerd`, `/run/containerd/containerd.sock`) where it is
silent. Nothing a process names is executed. Docker's own managed containerd
resolves the same way. No serving daemon, a root that does not exist, or more
than one daemon claiming the address leave the root unavailable rather than
naming a directory that may hold nothing. An explicit
`/etc/verity-buildkit/storage-roots.conf` always takes precedence. For a host
using the standard containerd root and managed data volume:

```text
version=1
containerdRoot=/var/lib/containerd
dataVolume=verity-data
```

The publisher obtains `DockerRootDir` and the named volume's actual mountpoint
from Docker. For bind-mounted data, set `exportRoot=/absolute/host/data/path`;
set `projectRoot=/absolute/host/project/path` when project data is elsewhere.
A containerd root that is neither configured nor established this way is
reported unavailable; admission then checks only the roots it measured. Recheck these
paths after moving Docker, containerd or data storage. Config files are parsed
as data, never sourced as shell programs.

For a bounded one-time physical tree sample, pass established host paths:

```sh
VERITY_STORAGE_REPORT_USAGE=1 bash deploy/buildkit/storage-report.sh \
  /var/lib/verity-buildkit /var/lib/docker /var/lib/containerd \
  /actual/export/root /actual/project/root
```

Each optional `du -sx` has a ten-second timeout; a timeout is unknown, not zero.
Root tree totals can overlap (for example Docker volumes and project data).
Do not sum overlapping roots, mounted merged views, or logical image/cache sizes
with physical tree totals. A physical snapshot total is not reclaimable-cache
evidence. For phase peaks, sample filesystem availability before, during and
after a separately budgeted representative build/export/import; retain timestamps,
phase boundaries, cancellation outcome and collector timeouts. A historical TAR
size alone cannot establish the next build's snapshot or import budget.

The installer renders version-1 `/etc/verity-buildkit/storage-policy.conf` when
present. Without it, the cache target is 10 GiB, retained floor 1 GiB, free-space
target 5 GiB and age eligibility 72 hours. Example:

```text
version=1
reservedGiB=1
budgetGiB=10
freeGiB=5
ageHours=72
```

Reapply the current installer after editing the policy; editing generated TOML
is not persistent configuration. Invalid settings fail before installation
mutates binaries or runtimes. Existing OCI snapshotter configuration is retained;
an unsupported custom state root fails for explicit maintenance. BuildKit owns
reference-safe GC: active/shared records may keep physical usage above the cache
target. Image retention continues to protect durable project selections,
container references and the existing Server rollback policy. No generic Docker
system prune or volume cleanup is added by storage management.

## Tooling reuse

The toolkit CLI installer reuses a pinned installation only when the source
lockfile, installer/hardening code, Node runtime, installed bytes, ownership,
permissions and executable links match its installation receipt. Missing or
changed entries trigger a complete locked reinstall. Version overrides are
installed afresh. Claude ACP is rebuilt because it receives additional external
patches; their application is never skipped by this receipt. Compatible Docker
CLI/plugin copies share Dockerfile steps with identical source stage,
destination and permissions.

## Acceptance after deployment

Use an isolated test host and a numeric disk/time budget for cold, warm and
repeated representative builds. Record timestamped filesystem samples at
context, build/export and import boundaries; sampling may miss brief peaks.
Compare peak growth and final retained usage, including a completed GC pass.
Demonstrate convergence of eligible cache while keeping active references,
required rollback images and project data. Exercise low-space/inode rejection,
concurrent requests, cancellation and restart recovery within that budget.
The disposable host-service CI fixture records bounded cold/warm/repeated
phase samples; its small-workload estimate does not calibrate larger projects.
The disposable runner also creates ten independent 128 MiB COPY results under
a 4 GiB growth allowance, 2 GiB free reserve and six-minute deadline. A bounded
BuildKit prune applies a 1 GiB cache target while a real RUN holds references;
the test checks those references survive and observes remote solve completion
after cancelling the client. This tests the GC budget mechanism, not automatic
GC scheduling, and does not substitute for a representative native-snapshotter
workload. Import cancellation uses a partial-input Unix-socket test transport
to observe the Engine's terminal error and then a successful import. It does
not establish arbitrary daemon-internal cleanup after a direct disconnect or
cancellation through the production provisioning API.

After separately approving a production rollout, a project Repair is successful
only when the build process exits successfully, the archive imports, the
gVisor sandbox starts, and an agent responds. Confirm owned archive cleanup as
well. A completed export, an existing image tag or a running control-plane
container alone does not demonstrate project recovery. Deployment, host data
cleanup and snapshotter changes remain separate maintenance actions.

### Managed snapshotter convergence

Releases ship `snapshotter-policy.conf` as versioned desired state. The verified
builder installer installs a systemd reconciler and timer; users of a managed
installation do not run SSH commands to switch snapshotters. The installer still
preserves an existing snapshotter. The separate reconciler applies the explicit
`overlayfs` policy only after compatible clients have drained. It retries deferred
work every minute, including after the new Server has been promoted.

The Server image declares admission protocol 1. Its fixed builder-directory bind
is writable so the dedicated builder group can create markers **only inside the
`leases` subdirectory**; the directory, lock, configuration and status remain
root-owned. Legacy read-only seals remain valid and are migrated during guarded
Server replacement, with a separate authority backup. The host checks all running
containers exposing the builder socket; an unknown or legacy consumer defers the
migration. This coordinates managed clients, not arbitrary host-root processes.

Every build holds a shared `flock` descriptor from context staging through image
import. An exclusive host lock pauses new admissions and waits at most 30 seconds
for current work. A host-visible lease marker remains after an ambiguous remote
failure or Server crash. Such markers are not deleted by the migration: uncertain
work defers it. A boot clears the runtime markers only after the old processes and
daemons have ended; persistent Server storage reservations retain their separate
offline reconciliation requirements. The existing conservative build estimate is
unchanged; snapshotter convergence does not calibrate a full provisioning budget.

Before switching, the reconciler requires 20 GiB free, no in-use BuildKit cache
records, the supported state root, and actual overlay copy-up on that filesystem
in a private mount namespace. It changes only the OCI snapshotter, restarts the
dedicated service, verifies its worker labels, and executes a bounded, network-free
gVisor RUN using the installed static buildctl binary. It neither imports an
image into Docker nor deletes native state, project volumes or rollback data.
The free-space check is headroom, not a quota or a guarantee against concurrent
host allocations.

A root-only, synced configuration backup and journal under
`/var/lib/verity/buildkit-snapshotter` protect this configuration transaction.
Validation failure restores and verifies the prior worker. `ExecStartPre` restores
an interrupted transaction before the next service start; `ExecStartPost` keeps
the journal and admission blocker until the previous worker is verified. The timer recovers
an interrupted transaction on the same boot. A failed restoration retains the
journal and blocks new admissions. This is configuration rollback; daemon metadata
is shared and it is not a full state backup. Old native state is retained and is
never treated as disposable merely because overlayfs is running.

Control diagnostics also report `builderAdmission`: `provisioned`,
`migration-pending`, `incomplete`, `not-provisioned` or `unreadable`, read from the
builder directory on every request, so a missing migration report can be told
apart from a host that never received the reconciler.

Control diagnostics include fresh `builderMigration` evidence with `deferred`,
`migrating`, `converged`, `rolled-back` or `blocked` status, a bounded explanation
and observation time. Missing or stale evidence does not imply success. The
underlying root-owned report is `/run/verity-buildkit/migration-status.json`.

Hosts that already have the managed host-builder bridge receive the reconciler
from a signed release through the existing updater. Hosts without that bridge
cannot bootstrap host-root execution from a Server container: they need their
existing infrastructure-management channel to install the verified host component
once. No SSH fallback is added to the app. Upgraded host bridges also acquire the release lock and admission fence before
installing a changed builder bundle. Older bridges retain their historical
bundle-install restart semantics, including the first introduction of this
protocol; snapshotter convergence itself always requires the compatible-client
fence. A failed migration revision is latched until its versioned policy or helper
changes, rather than restarting the builder every minute. Periodic timer retries
of a deferred transaction do not restart it.
