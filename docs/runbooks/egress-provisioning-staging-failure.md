# Network protection provisioning fails during staging

An update can stop with an Updater log line such as:

```text
ProjectEgressProvisioningError: Project network protection preparation failed
(install, exit 1, operation <operation>, phase staging, code command_failed).
```

The current version keeps serving. The app may report that host runtime recovery
needs attention. Updaters that recognize proof of an unchanged host can report
the failed attempt as retryable instead.

## What the diagnostic means

Two images take part in network protection provisioning:

- The **installed** Updater orchestrates the update. It verifies the target
  signature, starts the provisioning helper with fixed mounts, environment and
  limits, and turns the helper's diagnostic into the log line and the app status.
- The provisioning helper (`deploy/host/verity-egress-provision`), its
  configuration generator and the host payload come from the **target** image.

A correction to the helper therefore takes effect in the next signed target,
also when the installed release is older. A correction to orchestration or to
error classification takes effect only once the installed Updater contains it.

`phase staging` means this invocation failed before submitting a host systemd
unit. An earlier invocation of the same operation may have submitted
`verity-egress-provision-<operation>.service` and left journal entries or firewall
changes. The configuration step can also update the protected database role
before submission. Both cases can require recovery.

Lock and fence failures at the very start of the helper exit without any
diagnostic. A log line that names `phase staging` therefore comes from the
staging steps themselves.

Helpers that name staging steps report one of `preflight`, `stage_prepare`,
`release_copy`, `scripts`, `assessment_authorization`, `config` or `launcher`.
Updaters that predate those names drop them. For those Updaters the helper also
reports `reason assessment_authorization_invalid` for the staging assessment
check and `reason provisioning_failed` for the configuration generator. When
the target's helper reports these reasons, a staging failure without either
reason comes from another step.

## A failed operation does not block a new attempt

The `recovery-required` record belongs to the failed operation and target. A
later release creates a new operation with its own record, so updating to a
newer target remains possible. Retrying the same target is not offered.

Do not run the installer with `--reinstall`: it deletes all Verity data.

## Locate the failing step on the host

Run these read-only commands as root on the deployment host. Set
`operation` to the 24-character operation from the log line.

```sh
operation='paste-operation-id-here'
ls -la /var/lib/verity-egress/provision/ "/var/lib/verity-egress/provision/$operation/"
df -h /var/lib/verity-egress
docker info --format '{{.LoggingDriver}}'
```

- With a helper that names staging steps, a missing stage directory means the
  failure happened before the configuration generator ran. A failed attempt
  removes its new stage only in that case. An uncompacted directory shows how far
  staging got: `release/`, the two `project-egress-*.py` scripts,
  `assessment-authorization.json` and `config/` are created in that order.
  Compaction can remove those files and leave the directory in place.
- Copying the release payload needs a few hundred MiB of free space under
  `/var/lib/verity-egress`.
- With the `journald` logging driver, the removed helper's error output is still
  in the host journal:

  ```sh
  journalctl --no-pager CONTAINER_NAME="verity-egress-install-$operation"
  ```

  That output can contain host paths. Review it before sharing it.

For the staging assessment check, confirm that the Updater's channel record is a
root-owned private file that contains `"staging"`:

```sh
channel="$(docker volume inspect verity-managed-deployment --format '{{.Mountpoint}}')/update-channel.json"
stat -c '%F %a %u:%g %s' "$channel" && cat "$channel"
```

## Recover

- **Cause in the helper, its configuration generator or the payload:** update
  to a signed target that contains the correction through the app. No host
  action is needed first.
- **Cause in host state** (free space, a stale stage, the channel record):
  correct that state, then update through the app again. If recovery is still
  required for the failed operation, choose a newer target offered by the app.
- **Cause in the installed Updater's orchestration:** a newer target cannot
  change it. Follow [Direct update recovery](direct-update-recovery.md#verify-the-target-before-replacing-anything)
  to verify the signed target, then replace only the Updater using the exact
  image digest returned by that check and continue with the runbook.

The official installer in Repair mode stays pinned to the installed release. It
provisions network protection directly, without the provisioning helper or the
staging assessment. It keeps all data and leaves the update journal and the
failed operation's record unchanged. It helps only when the cause is host state
that Repair recreates.

After a successful update, verify the server version in the app and that network
protection reports ready.
