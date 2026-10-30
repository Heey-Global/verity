# Recover backup provisioning before standby creation

Use this only when an update is stuck in `creating-standby` and the release-owned
backup provisioning helper reports `Failed to connect to bus: No data available`.
The original Server remains active. Repeated retries cannot repair the old
Updater's missing host PID visibility.

The fixed Updater grants host PID visibility only to the bounded provisioning
job. Planning, write probes and ordinary Server containers retain their PID
isolation. This lets systemctl verify the peer credentials on the existing host
systemd private socket without adding capabilities or mounting the system bus.
The provisioning job also sets `SYSTEMD_IGNORE_CHROOT=1` so systemctl targets that
live manager instead of silently treating the container filesystem as offline.

## One-time recovery authorization

An already running old Updater cannot load the fixed orchestration code. Recovery
therefore requires a **one-time root command on the deployment host**, using a
verified fixed release image. This is an explicit local recovery action, not an
automatic app-only update. It invokes the same Updater provisioning implementation
against the existing operation's original target image, rather than editing host
configuration by hand or replacing the Server or Updater.

The command shares the Updater's crash-released journal lease. It refuses an active
attempt, any phase other than `creating-standby`, an existing journaled candidate,
or a sealed predecessor that no longer matches. Apply requires the exact operation,
generation, target and both checksums printed by check. No journal, release target
or sealed deployment is rewritten. The helper performs the normal installation
of backup prerequisites, so applying does write the backup host configuration.

## Check and apply

First obtain and verify a published release containing this command through the
normal signed-release verification process. Set `VERITY_REPAIR_IMAGE` to that
exact official digest, never a floating tag or an unverified image. The repair
image may be newer than the operation's pinned target; it only supplies the fixed
orchestration, not a replacement update target.

On the deployment host, as root:

```bash
docker volume inspect verity-managed-deployment >/dev/null

backup_repair() {
  docker run --rm --network none --read-only --user 0:0 \
    --cap-drop ALL --security-opt no-new-privileges=true \
    --pids-limit 64 --memory 256m --tmpfs /tmp:rw,nosuid,nodev,size=16m \
    --mount type=volume,source=verity-managed-deployment,target=/var/lib/verity/updater/managed-deployment \
    --mount type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock \
    --entrypoint node "${VERITY_REPAIR_IMAGE:?verified fixed release digest required}" \
    /app/packages/server/dist/backup-provision-recovery-command.js "$@"
}

backup_repair --check
```

Review the output's `snapshot`. Check launches only the read-only plan helper,
alongside the temporary journal lease; it does not provision the host. If another
Updater attempt holds the lease, wait for that attempt to finish and check again.
Never remove its lock or stop the serving generation.

With explicit authorization, pass only the exact `snapshot` object as one argument:

```bash
backup_repair --apply '<snapshot JSON from --check>'
```

If the operation or sealed deployment changed, apply refuses before starting any
provisioning job: check and review again. Helper failures leave the original
operation available for retry. A successful apply verifies both the durable
provisioning receipt and directory access as the Server user. An already completed
repair is safe to apply again without repeating host provisioning.

After `provisioned: true`, retry the existing update in the app. Normal Updater
preparation verifies the receipt, seals the backup mounts and resumes standby
creation. Do not start a different release or delete update state to bypass this
operation.

## Verification limits

The peer-credential regression uses real systemctl and Linux PID/mount namespaces
with a deliberately rejecting socket, not a complete systemd host. It reproduces
the original connection error and proves shared PID visibility passes that check.
Provisioning fixtures cover durable receipts and failed attempts; recovery tests
cover the journal lease, stale snapshots, idempotence and preservation of the
serving generation. Full recovery on a disposable Docker/systemd host is still
required before claiming live end-to-end verification.
