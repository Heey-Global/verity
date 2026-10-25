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
filesystem read-only except for builder state, and limits the service to 2 GiB
memory, no swap, one CPU, and 512 tasks. The OCI worker runs one operation at a
time and disables insecure entitlements and the containerd worker. BuildKit GC
bounds its own cache independently of the Server's exported images. A build can
use outbound networking; this service does not implement egress policy.

## Installation and upgrade

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
4. For managed deployments, seal the override into the deployment bundle so
   replacement Server generations inherit the socket mount, group, and endpoint.
   Recreate the Server using the normal deployment procedure, without replacing
   existing project containers. Upgrading Server alone leaves repository builds
   unavailable until the builder endpoint is configured.
5. Check `systemctl status verity-buildkit` and `journalctl -u verity-buildkit`.
   Provision a disposable project with a Dockerfile and Feature; confirm its
   image was loaded into the project Engine. Stop the builder and verify that
   another build fails without replacing an existing running sandbox. CI runs
   this check using the actual Server build spawner and records OCI evidence.

`VERITY_DEVCONTAINER_BUILDKIT_ENDPOINT` must point to the private local Unix
socket (`unix:///run/verity-buildkit/buildkitd.sock`). Only trusted instance
configuration supplies it. Removing the endpoint stops future repository builds;
it does not terminate existing containers. To avoid repository builds for a
project, PATCH its settings with `{"devcontainerEnabled":false}` before the next
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
