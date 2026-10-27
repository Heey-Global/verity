# Devcontainer build isolation experiment

## Scope and status

The `devcontainer-gvisor-probe` workflow runs a small experiment on the same
Linux runner class already used by the Docker/gVisor smoke tests. It runs on
changes to the probe and can also be dispatched manually. No extra deployment
or user-provided test host is required.

This is **not a verified production integration**. Local checks validate the
harness and its rejection of incomplete evidence. Only a successful workflow
run establishes the behavior of the tested tool versions. No live Docker build
was executed in the authoring Sandbox, which has no Docker endpoint.

## What the CI experiment does

1. Installs the repository-locked devcontainer CLI and builds the existing
   `deploy/gvisor-ci.Dockerfile` to obtain its checksum-verified runsc binary;
   it does not start that image's Docker daemon.
2. Creates a dedicated BuildKit worker from a digest-pinned image, explicitly
   selects the instrumented runsc executable, and disables the containerd
   worker. The worker runs in a privileged CI-only container, with no published
   port, a private Unix socket, one build step at a time, one CPU, a PID limit,
   and a memory limit below available memory (at most 2 GiB).
3. Routes the pinned devcontainer CLI through a named remote buildx builder,
   without selecting it globally, and builds this fixture without cache using
   the existing digest-pinned Node/Debian base from `deploy/preview-edge.Dockerfile`.
4. Requires output markers from both a Dockerfile RUN and a local Feature
   installation in the image loaded into Docker. Extracting markers uses
   `docker create` and `docker cp`, without executing the resulting image.
5. Checks worker-side OCI bundles for both steps, runtime invocation records,
   and runsc debug logs. Guest kernel output is retained only as corroboration;
   a service container's Docker runtime or worker label alone is insufficient.
6. Disables the selected runtime and requires a new uncached build to fail;
   then stops the builder and requires another build to fail. Neither test may
   produce an image. An outer harness timeout or OOM does not count as expected
   rejection; the stopped remote builder reports BuildKit's connection deadline.
7. Retains diagnostics even on failure and removes only the experiment's
   builder, container, anonymous worker volume, and tagged images. No global
   Docker prune is run. The CI runner disposes of the temporary socket/config.

The workflow uploads logs, runtime pins, effective configuration, worker
inspection, resource limits, OCI bundles and result markers as a seven-day
artifact. It uses an empty Docker config and no registry or deployment secrets.

## Limits and interpretation

BuildKit's runc executor passes `run --keep`, which the pinned runsc does not
accept. The CI adapter removes that exact option from the run invocation and
preserves all other arguments. runsc's synchronous run cleans up its state;
BuildKit's subsequent best-effort delete can encounter already-removed state.
This is a probe-specific compatibility adapter, not a production runtime shim.
The worker also sets `--overlay2=none`: runsc's default private root overlay
discards guest writes, whereas BuildKit must capture them in the resulting image.
BuildKit still supplies each step's isolated filesystem snapshot.

A passing run establishes Dockerfile execution, local Feature installation,
image loading, and the two rejection cases for this fixture and pinned tools.
It does not establish arbitrary devcontainer compatibility, production resource
isolation, private registry authentication, OCI Feature publisher trust, or
production integration. The privileged worker is confined to CI; deploying one
on a production host requires a separate architecture/security decision.

The local Feature is instrumentation: Verity's production validator rejects
project-declared Features. The Server's build spawner also constructs a restricted
environment which currently omits `BUILDX_BUILDER`; this direct CLI experiment
does not change that behavior.

If a positive build fails, inspect the retained BuildKit/runsc logs. Do not switch
to runc or enable insecure entitlements to make the experiment pass. Production
build policy, image cleanup, and persistent audit implementation are unchanged.

## Local checks

```sh
node --test scripts/probes/devcontainer-gvisor/*.test.mjs
bash -n scripts/probes/devcontainer-gvisor/ci.sh
sh -n scripts/probes/devcontainer-gvisor/runsc-probe.sh
```

The synthetic evidence tests validate the verifier; they are not isolation tests.
`ci.sh` refuses execution outside GitHub Actions to prevent accidental use of a
production daemon. It expects the workflow's CLI path and artifact directory.

## References

- [BuildKit worker configuration](https://github.com/moby/buildkit/blob/master/docs/buildkitd.toml.md)
- [BuildKit OCI worker runtime selection](https://github.com/moby/buildkit/blob/master/worker/runc/runc.go)
- [Devcontainer CLI source at the pinned release](https://github.com/devcontainers/cli/tree/v0.89.0)

## Private registry follow-up

`devcontainer-gvisor-auth` adds a separate CI-only mode to this harness. It starts
Distribution on loopback under a temporary hostname with a one-day TLS certificate, bcrypt authentication
and randomly generated credentials; no GitHub or deployment credential is used.
The fixture base and OCI Feature are published into that registry. Two anonymous
CLI attempts must fail independently (private Feature/public base and private
base/local Feature), then the authenticated build must pass the same worker-side
runtime evidence and image-marker checks. Unavailable-worker tests still run.

Only this CI worker uses host networking to reach the loopback registry. The
certificate trust directory must not preexist and is removed with the named
registry container. Publisher configuration stays outside artifacts; setup logs are scrubbed before upload;
artifact files are scrubbed of the generated password and Docker auth value.
This tests TLS/basic-auth forwarding, not GitHub App token scope or production
registry availability. It does not approve the CI worker's host privileges for
production use.
