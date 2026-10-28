# Installer recovery from a copied backup

The recovery acceptance gate remains closed. This implementation must pass the
complete v1 acceptance requirements in [ADR 0025](adr/0025-encrypted-backup-and-installer-recovery.md)
before backup setup and scheduling become available. A successful restore probe
alone does not satisfy that gate.

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
pairing key and CA, issues new host credentials, and creates a new installation
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
