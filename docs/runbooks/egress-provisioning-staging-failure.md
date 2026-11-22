# Network protection provisioning fails during staging

An update can stop with an Updater log line such as:

```text
ProjectEgressProvisioningError: Project network protection preparation failed
(install, exit 1, operation <operation>, phase staging, code command_failed).
```

The app then reports that host runtime recovery needs attention. The current
version keeps serving.

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

`phase staging` means the helper failed before it submitted a host systemd unit.
No `verity-egress-provision-<operation>.service` exists, so there is no unit
journal, and no host firewall change was applied by that attempt. The
configuration step can still have updated the protected database role, which is
why older Updaters keep the operation `recovery-required`.

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

Run these read-only commands as root on the deployment host. Replace
`<operation>` with the 24-character operation from the log line.

```sh
ls -la /var/lib/verity-egress/provision/ /var/lib/verity-egress/provision/<operation>/
df -h /var/lib/verity-egress
docker info --format '{{.LoggingDriver}}'
```

- With a helper that names staging steps, a missing stage directory means the
  failure happened before the configuration generator ran. A failed attempt
  removes its new stage only in that case. A remaining directory shows how far
  staging got: `release/`, the two `project-egress-*.py` scripts,
  `assessment-authorization.json` and `config/` are created in that order.
  Directories of older helpers can be compacted later and prove less.
- Copying the release payload needs a few hundred MiB of free space under
  `/var/lib/verity-egress`.
- With the `journald` logging driver, the removed helper's error output is still
  in the host journal:

  ```sh
  journalctl --no-pager CONTAINER_NAME=verity-egress-install-<operation>
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
  correct that state, then update through the app again.
- **Cause in the installed Updater's orchestration:** a newer target cannot
  change it. Replace only the Updater as described in
  [Direct update recovery](direct-update-recovery.md#upgrade-only-the-updater),
  then update through the app.

The official installer in Repair mode stays pinned to the installed release. It
provisions network protection directly, without the provisioning helper or the
staging assessment. It keeps all data and leaves the update journal and the
failed operation's record unchanged. It helps only when the cause is host state
that Repair recreates.

After a successful update, verify the server version in the app and that network
protection reports ready.
