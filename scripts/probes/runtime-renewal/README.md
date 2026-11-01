# Runtime renewal host qualification

Run only on a disposable, rootful Docker host with systemd. This probe changes its
installed Verity runtime service and Docker runtime registrations. It never targets
a production host implicitly.

Prepare the VM using the actual old installer/runtime service, retaining both old
`runsc` registrations and the installer lock. Confirm its agent does not advertise
archive support. Use official signed image digests for the installed baseline and
the candidate containing the runtime-only renewal payload. Give the candidate a
release signature with the normal trusted workflow identity; unsigned local images
are deliberately rejected.

On that VM, with the repository and dependencies available:

```sh
printf 'disposable\n' | sudo tee /etc/verity-runtime-renewal-test-vm
sudo env VERITY_RUNTIME_RENEWAL_VM=1 \
  VERITY_RUNTIME_BASE_IMAGE='<official installed digest>' \
  VERITY_RUNTIME_TARGET_IMAGE='<official candidate digest>' \
  TMPDIR=/tmp npx vitest run scripts/probes/runtime-renewal/host.test.ts --maxWorkers=1
```

The probe independently verifies both digests, starts persistent `runc` and old
`runsc` containers, renews the host runtime service without builder admission,
registers archive runtimes through the host service, checks original process start
identities and restart counts, and starts a sandbox on the new runtime. It cleans
up only the probe containers. The upgraded service and runtime directories remain
for inspection; dispose of the VM afterward.

Repeat on Linux amd64 and arm64 for each supported engine version. Record engine,
kernel, systemd and image digests with the result. Exercise rollback and interrupted
installation in separate disposable snapshots; the deterministic fake-host suite is
`scripts/install-runtime-service.test.ts` and `scripts/verity-host-runtime.test.ts`.

This probe begins with the new updater implementation. It is not proof of delivery
to an old installed updater. Separately exercise the actual old updater through an
approved signed compatibility release and then the archive-requiring successor.
Do not publish a compatibility release with an older runtime, remove requirements,
or change live hosts as part of running repository checks. That release/security
decision remains a rollout gate described in ADR 0008 Amendment 6.
