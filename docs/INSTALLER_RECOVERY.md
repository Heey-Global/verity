# Installer recovery from a copied backup

The recovery acceptance gate remains closed. This implementation must pass the
complete v1 acceptance requirements in [ADR 0025](adr/0025-encrypted-backup-and-installer-recovery.md)
before backup setup and scheduling become available. A successful restore probe
alone does not satisfy that gate.
The [acceptance evidence matrix](BACKUP_RECOVERY_EVIDENCE.md) separates verified
scenarios from remaining implementation and evidence gaps.

Recovery requires the entire copied local backup directory, its recovery key,
the master password current at capture time, Docker and a supported Linux host.
Keep the original directory intact. Recovery downloads the authenticated,
digest-pinned release recorded by the snapshot; that release must explicitly
support restricted recovery for the host architecture. Older releases without
that capability are refused before live state changes.

## Select and verify

Run the installer as root. Select the repository, sequence and kind explicitly;
never select a snapshot using its copied file modification time. Repository and
snapshot names can be inspected below `repositories/<repository>/snapshots/`.

```sh
verity-install --restore /mnt/copied-backup \
  --restore-repository <installation-id>-r1 \
  --restore-snapshot 1 --restore-kind manual
```

The default action is `trial`. Add `--new-identity` to the initial command when
old paired devices must not reconnect. That choice creates new deployment keys
and retains no old device credentials. The default preserves the deployment ID,
pairing key, CA and pinned TLS public key, reissues the leaf certificate for the
new addresses, issues new host credentials, and creates a new installation
ID. Do not run two hosts with the same deployment identity concurrently.

The installer prompts privately for the recovery key. For unattended operation,
`--restore-secrets-stdin` reads exactly two lines: the recovery key and master
password. Supply those through a private pipe; keep them out of shell arguments,
environment variables, history and logs.

## Review the restricted installation

The installer records a private restore checkpoint under its state directory and
holds its installer lock. It imports into isolated data/database volumes and
stages host credentials. Previous installation containers and restart policies
are checkpointed before stopping them. Existing data and host configuration
remain recoverable until acceptance.

```sh
verity-install --restore /mnt/copied-backup --restore-action status
verity-install --restore /mnt/copied-backup --restore-action devices
verity-install --restore /mnt/copied-backup --restore-action review \
  --keep-device <reviewed-device-id>
```

Device inspection and review require the master password. Repeat `--keep-device`
for each reviewed device, or use `--keep-no-devices`. Review is explicit and
final for this trial. Revoked devices cannot be retained. Both snapshot outbox
revocations and authenticated revocations added to the copied directory after
capture apply; final acceptance rechecks them and removes newly revoked devices.
Keep the copied revocation history complete.

The trial exposes only a local installer Unix socket. Ordinary device/API
access, pairing, project startup, queued work, updates, backup scheduling and the
CA helper remain disabled. The credential store remains sealed. Projects are
suspended and interrupted turns are cleared rather than restarted automatically.

## Accept, resume or abort

```sh
verity-install --restore /mnt/copied-backup --restore-action accept
```

Acceptance requires the recovery key and master password again. It publishes
staged data and host configuration through durable checkpoints, starts the
restricted canonical database, rechecks authorization and revocations, and marks
acceptance before initializing backups. The new installation gets its own
repository; recovery never takes over or prunes the source repository. Encrypted
CA material is published before enabling the helper. The installer activates the
authenticated release's bundled deployment payload and retains the previous
containers and volume checkpoints after startup.

If the command is interrupted, repeat the same action and source directory.
Status reports the durable phase. Publication and initialization are retryable;
an accepted job must finish activation before another restore can begin. Normal
installation and repair refuse an unfinished restore checkpoint.

Before acceptance, abort with:

```sh
verity-install --restore /mnt/copied-backup --restore-action abort
```

Abort removes only resources belonging to this restore, restores checkpointed
volumes and host configuration, then resumes the previous containers with their
saved restart policies. It refuses ownership collisions. An accepted restore
cannot be aborted; resume its activation instead. Retained previous checkpoints
are not an automatic same-host update rollback facility.

After activation, reconnect reviewed devices and unlock credentials with the
master password. New identity recovery requires pairing again. Start projects
explicitly. Verify settings, worktrees, knowledge and credentials before retiring
any retained original installation or independent backup copy.

## Replace a lost or exposed recovery key

An administrator starts `POST /api/backups/key-replacement` with `reason` set to
`lost` or `exposed`, saves the returned recovery key offline, then confirms it
with `POST /api/backups/key-replacement/confirm` using the returned `id` and
`recoveryKey`. Cancel an unconfirmed candidate with
`POST /api/backups/key-replacement/cancel`; cancellation leaves the configured
key and repository unchanged. These routes remain behind the closed backup
acceptance gate.

Confirmation records a durable replacement intent and publishes a new repository
and key generation. Retry interrupted publication; a confirmed intent cannot be
cancelled. Only public encryption recipients and host signing material enter
that intent, never the recovery private key. Old snapshots remain encrypted for
the old key, including after a lost-key replacement. Keep the old key if it is
still available and retain complete revocation history for every generation.

For exposure, the root helper durably retires the locally available old CA
bundle before publishing the replacement and refuses requests that would
republish that retired generation. This removes only the exact owned bundle;
it does not erase copied backups or external identity material. Replacing the
recovery key alone does not remove the identity from old snapshots. Rotate the
live identity as well.

## Rotate a compromised live identity

Run on the installed host as root:

```sh
verity-install --rotate-identity
```

The installer exclusively locks identity publication, stops normal runtime and
backup writers, prepares and validates replacement CA, TLS and Ed25519 pairing
keys, records retirement, and revokes device credentials before publishing the
replacement identity. The installation's sealed deployment ID stays unchanged.
Failures leave runtime fenced; rerun the same command to resume the durable
checkpoint. Keep `identity-rotation/` and `retired-identity-ca-sha256` in the
root-owned installer state directory. Missing or malformed retirement history
blocks preserved-identity recovery.

A completed command is idempotent. For a later, separate compromise, explicitly
start another rotation with:

```sh
verity-install --rotate-identity --restart-rotation
```

All devices must remove their saved server and pair again using the replacement
invitation. After rotation, restore a pre-rotation snapshot only with
`--new-identity`; its old device credentials must not be activated on this host.
Offline devices still retain their old pin and identity until you reset them.
Rotation does not invalidate external copies for those offline devices. Native
device and pin-reset acceptance remains open until tested on actual devices.
