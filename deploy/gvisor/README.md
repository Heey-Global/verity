# Pinned gVisor host runtime

Brokered Secret jobs use Docker's `runsc` runtime. The runtime belongs to the Docker host, not the
Verity server or project-sandbox image.

`versions.env` pins the upstream release and SHA-512 checksum for both supported architectures.
The CI smoke runs natively on amd64 and arm64; it does not use emulation for this security boundary.
`install-runsc-host.sh` downloads that exact artifact, verifies it, installs it at the versioned
path `/opt/verity/runsc/<release>/runsc`, merges the `runsc` registration into
`/etc/docker/daemon.json`, and reloads Docker. Run it through the host's normal image/Ansible/cloud-
init rollout, not from an agent session:

```sh
sudo deploy/gvisor/install-runsc-host.sh
```

Then exercise the registered runtime with a real, secret-free, networkless container:

```sh
deploy/bin/verity-gvisor-smoke
```

The smoke image is digest-pinned in `versions.env`; `VERITY_GVISOR_SMOKE_IMAGE` may override it only
with another full digest. To make this a deployment gate, enable the opt-in preflight on every
Compose invocation:

```sh
VERITY_GVISOR_REQUIRED=1 ./deploy/bin/verity-compose up -d
```

The wrapper runs the smoke before changing the Compose stack. Missing/mismatched registration,
binary drift, mutable images, weakened container settings, runtime failure, or incomplete cleanup
all fail closed.

The registration deliberately fixes these arguments:

- `--platform=systrap`
- `--network=none`

Verity's `createDockerGvisorRuntimeVerifier` reads Docker `GET /info` and requires the exact runtime
name, versioned path, and ordered arguments before a secret job can launch. The future Docker
Policy Gateway must admit this read-only operation; see ADR 0017. The historical generic proxy
sketch is not a supported security boundary.

Updating gVisor requires changing the release and both checksums together, rolling the host asset,
reloading Docker, and updating the expected verifier path. Never point the runtime registration at
an unversioned `runsc` symlink and never fall back to `runc`.
