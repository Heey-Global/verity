# Recover backup provisioning before standby creation

Use this only when an update is stuck in `creating-standby` and its release-owned
backup helper reports `Failed to connect to bus: No data available`. The previous
Server remains active; retries through the old Updater repeat the same failure.

The fixed Updater grants host PID visibility only to the bounded provisioning
job and sets `SYSTEMD_IGNORE_CHROOT=1`. systemctl can then verify the peer on the
mounted host manager socket and operate that manager instead of treating the
container filesystem as offline. Planning, write probes and ordinary Server
containers retain their PID isolation and existing security/resource settings.

## Recovery needs the corrected Updater

An already running old Updater cannot load the fixed orchestration. Provisioning
backup prerequisites separately is insufficient: the old Updater always launches
its original failing helper again, even when a provisioning receipt already exists.

Recovery requires an explicitly authorized **Updater-only replacement on the
host**, using a verified fixed release image. This is a one-time recovery
procedure, not an automatic app-only fix. Do not edit backup/systemd configuration
by hand, replace the Server, change the operation target, delete the journal,
or rerun managed bootstrap.

## Prepare the replacement

Obtain and verify a published release containing the fix through the normal
signed-release verification process. Use that exact official image digest,
never a floating tag or an unverified PR image. The fixed Updater can execute the
existing operation's original pinned target helper; changing the Server target
is unnecessary.

Before applying, confirm the operation is still at `creating-standby`, the old
Server is serving, and no provisioning helper is running. Wait for any active
helper to exit rather than overlapping host preparation. Record the existing
Updater container identity, its image and its mounts using bounded read-only
inspection; do not print its full environment or inspect payload because those
may contain secrets.

Using the installation's original Compose project, environment, file selection
and overlays, recreate **only** `verity-updater` with the verified fixed digest.
For the standard managed file selection the command is:

```bash
VERITY_SERVER_IMAGE='<verified fixed release digest>' docker compose \
  -f deploy/docker-compose.yml -f deploy/docker-compose.managed.yml \
  --profile managed up -d --no-deps verity-updater
```

Run this in the existing installation context with its original Compose settings;
never guess a different project or regenerate credentials. If that context cannot
be established, stop and prepare a reviewed replacement preserving the actual
container's configuration instead. No host mutation is authorized merely by
reading this procedure.

## Resume and verify

The corrected Updater reads and resumes the existing journal on startup. It repeats
backup provisioning using host PID visibility, verifies the durable receipt and
Server-user directory access, and continues the normal guarded Server replacement.
If an attempt fails for another reason, inspect its bounded failure details before
retrying the same operation. Do not bypass the journal or activation fencing.

Companion reconciliation follows the original operation's target image. If that
release predates the fix, completion may hand the Updater back to its old version.
Before requesting another update, inspect its actual image and, if necessary,
repeat the same Updater-only recreation with the verified fixed digest. Then
request the fixed Server release normally so all companions converge on it.

## Verification limits

The regression uses real systemctl and Linux PID/mount namespaces with a rejecting
socket and a controlled offline-root fixture. It reproduces the peer connection
failure and verifies the corrected connection path; it is not a complete systemd
host. Preparation tests exercise the actual provisioning orchestration and prove
an old executor still fails despite an existing receipt, while the corrected one
can prepare the original target without rewriting its journal. Full recovery on
a disposable Docker/systemd host remains required before claiming end-to-end
verification. This procedure has not been executed on a production host.
