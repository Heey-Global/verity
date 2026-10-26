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
ubuntu-24.04 amd64 only. Docker Desktop, rootless systemd, remote TCP BuildKit,
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
disables insecure entitlements and the containerd worker. Snapshots use
overlayfs wherever the state directory's file system supports it: each step is
a layer over its parent rather than a full copy of the image's file system,
which keeps small steps fast and the cache within its limit. Elsewhere BuildKit
falls back to the slower `native` snapshotter. An upgrade from `native` to
overlayfs rebuilds the cache once and removes the old snapshots. BuildKit GC
bounds its own cache independently of the Server's exported images. A build can
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
   `org.verity.devcontainer-builder=1`.
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
