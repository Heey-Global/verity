# Pinned gVisor host runtime

Brokered Secret jobs use Docker's `runsc` runtime; project Sandboxes that serve public previews use
`runsc-project`, a second registration of the same pinned binary. Both belong to the Docker host,
not the Verity server or project-sandbox image.

`versions.env` pins the upstream release, the SHA-512 checksum for both supported architectures, and
the arguments of both registrations. The CI smoke runs natively on amd64 and arm64; it does not use
emulation for this security boundary.

Managed installations need nothing done by hand. `deploy/bin/verity-install` installs the host
component `deploy/host/verity-host-runtime` (with a systemd path unit) and uses it to download the
pinned artifact, verify its checksum and version, install it at `/opt/verity/runsc/<release>/runsc`,
merge exactly the `runsc` and `runsc-project` entries into `/etc/docker/daemon.json`, and reload
Docker. A reload re-reads the runtimes without restarting any container; a reload Docker does not
take restores the previous `daemon.json`. Afterwards the managed Updater asks the same component
before it activates a release that declares runtimes the host lacks (see
[ADR 0008 Amendment 2](../../docs/adr/0008-verity-server-self-update.md)).

Hosts without the managed installer, or rolled out through image/Ansible/cloud-init, run the same
implementation directly:

```sh
sudo deploy/gvisor/install-runsc-host.sh
```

Then exercise the registered runtime with a real, secret-free, networkless container:

```sh
deploy/bin/verity-gvisor-smoke
```

The smoke image is digest-pinned in `versions.env`; `VERITY_GVISOR_SMOKE_IMAGE` may override it only
with another full digest. The preflight is a mandatory deployment gate on every Compose invocation:

```sh
./deploy/bin/verity-compose up -d
```

The wrapper runs the smoke before changing the Compose stack. Missing/mismatched registration,
binary drift, mutable images, weakened container settings, runtime failure, or incomplete cleanup
all fail closed.

The registrations deliberately fix these arguments:

| Runtime         | Arguments                                                    | Used by                                          |
| --------------- | ------------------------------------------------------------ | ------------------------------------------------ |
| `runsc`         | `--platform=systrap` `--network=none`                        | Secret jobs: short-lived, networkless, no mounts |
| `runsc-project` | `--platform=systrap` `--network=sandbox` `--host-uds=create` | Project Sandboxes                                |

A project Runner cannot work under the Secret-job arguments, which is why it has its own entry:

- `--network=sandbox` gives the Sandbox gVisor's own netstack, so it reaches its relay (model
  egress, the MCP gateway, the signing broker) and the preview connector reaches its dev server.
  Under `--network=none` all of those fail with `ENETUNREACH`.
- `--host-uds=create` makes a Unix socket bound inside the Sandbox a real host socket. The Server
  reaches the Runner supervisor through exactly that (`runners/<project>/supervisor.sock` in the
  data volume); without it the socket exists only inside gVisor and every turn fails with "the
  project supervisor socket is missing". `create` does not include `open`: the Sandbox still
  cannot connect to sockets the host created.

Docker's embedded DNS (127.0.0.11) is not reachable from gVisor's netstack. The Server therefore
pins the relay in the Sandbox's `/etc/hosts` and writes a `resolv.conf` with upstream resolvers:
`VERITY_SANDBOX_DNS_SERVERS` (comma-separated IPs) when set, otherwise the upstream servers Docker's
resolver forwards to, read from the Server container's own `/etc/resolv.conf`.

The smoke checks both registrations and runs a `runsc-project` container that binds a Unix socket
in a volume and serves TCP on an internal network, and fails unless a `runc` peer reaches both.

Verity's `createDockerGvisorRuntimeVerifier` reads Docker `GET /info` and requires the exact runtime
name, versioned path, and ordered arguments before a secret job can launch, and before a project
Sandbox is replaced under `runsc-project`. The future Docker
Policy Gateway must admit this read-only operation; see ADR 0017. The historical generic proxy
sketch is not a supported security boundary.

Updating gVisor requires changing the release and both checksums together, rolling the host asset,
reloading Docker, and updating the expected verifier path. Never point the runtime registration at
an unversioned `runsc` symlink and never fall back to `runc`.
