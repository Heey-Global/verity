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
A Server update can finish while repository builds remain unavailable pending
that Repair and valid filesystem evidence. Existing project containers continue
running. Configure and verify the storage roots below before testing a build.

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
`/tmp`. Successful, failed, timed-out and cancelled attempts remove their own
files. Commands run in tracked process groups; timeouts terminate their
descendants before releasing the attempt. No project volume, clone, worktree,
rollback image or BuildKit snapshot is an owned attempt artifact.

Before another attempt, recovery removes abandoned directories only when their
recorded owner and command groups are definitively gone in the same PID
namespace. A live group, unreadable record or changed namespace retains the
files and blocks admission. For a container replacement, verify host builds and
imports have stopped before reconciling only the reported owned attempt
directory. Do not remove the entire data root or infer inactivity from a missing
Server PID in a different namespace.

| Setting                     | Default | Meaning                                                                                |
| --------------------------- | ------- | -------------------------------------------------------------------------------------- |
| `VERITY_BUILD_ESTIMATE_GIB` | 306     | Total context, snapshot, export and import growth estimate for an unknown/native build |
| `VERITY_BUILD_FREE_GIB`     | 10      | Free-byte reserve left after admission                                                 |
| `VERITY_BUILD_FREE_INODES`  | 1000000 | Minimum free inode count                                                               |

These positive integer settings belong to the trusted Server environment. The
unknown-build estimate is intentionally conservative and **has not been validated
as an upper bound for arbitrary Dockerfiles**. Configure a smaller estimate only
from bounded cold/warm build measurements for the intended workload. Admission
estimates and periodic checks cannot enforce a filesystem quota or guarantee
that another host workload will not exhaust the disk between samples.

Every active command checks the reserve every two seconds. Host measurements
come from the storage timer every 15 seconds and must be no more than 120 seconds
old. Missing, invalid, stale, duplicate or unavailable root evidence rejects a
cache miss. Unknown topology never permits independent free-space budgets:
admission conservatively charges the full estimate against the lowest available
capacity and inode count across the local staging filesystem and all host roots.

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
`DockerRootDir`. Establish that root from the host runtime configuration and put
it in `/etc/verity-buildkit/storage-roots.conf`; no containerd root is guessed.
For a host using the standard containerd root and managed data volume:

```text
version=1
containerdRoot=/var/lib/containerd
dataVolume=verity-data
```

The publisher obtains `DockerRootDir` and the named volume's actual mountpoint
from Docker. For bind-mounted data, set `exportRoot=/absolute/host/data/path`;
set `projectRoot=/absolute/host/project/path` when project data is elsewhere.
Unset containerd roots remain unavailable and block new builds. Recheck these
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
