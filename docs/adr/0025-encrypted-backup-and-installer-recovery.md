# ADR 0025: Encrypted backups and installer recovery

- Status: accepted (architecture decision; functionality not implemented)
- Date: 2026-10-03
- Amended: 2026-10-24 (simplified first release)

## Context

Verity needs recoverable backups of configuration, credentials, project files,
sessions and knowledge, including retained data of active, sleeping and paused
projects. Application state spans PostgreSQL, the `verity-data` volume
(workspaces, session worktrees, knowledge folders), a few service volumes, and
the installation identity under `/etc/verity`; a database dump alone is
insufficient. Server updates run forward-only schema migrations, which makes the
moment before an update the one where only a backup can undo damage.

Backups must be encrypted on the self-hosted host before they are stored. Local
recovery must work without Premium Uplink. The master password protects the live
secret store; its derived key is held in memory only
(`packages/store/src/crypto.ts`), and the server offers `/secret/init` and
`/secret/unlock` but no password change or rekeying.

An earlier version of this ADR specified several destinations, a code-host
dependent Git capture, writer epochs with fences and a two-pass update hook in
the first release. Review found that scope too large to deliver and to verify.
This amendment fixes a smaller first release and moves the rest to later steps
without discarding it. The mechanics live in the
[concept](../BACKUP_RECOVERY_CONCEPT.md), which holds the detail; on conflict
this ADR wins and the concept is corrected.

## Decision

### Destinations and protection level

The first release has one destination: a host directory, managed by the
installer (default `/var/lib/verity/backups`, set with `--backup-dir` at install
time and later), bind-mounted into the server. The path is set on the host, not
from the phone. A marker file with a random target id is checked before every
write, so an unmounted disk under the same path fails the run instead of filling
the host disk, and every run checks free space first.

Premium Uplink is the second destination, in a later step. Google Drive, a
user-controlled object store, a NAS or SMB adapter and app download of a
portable export are out of scope; the concept names them as possible later
destinations.

The protection level is stated in the product: a backup on the host protects
against failed updates, mistakes and partial loss, not against loss of the host
disk. The supported way to survive that is copying the backup directory
off-host, for example with `rsync`, or Premium Uplink once available. Objects
and manifests are immutable and a manifest is written after its objects, so a
copy taken during a run can at worst hold a newest manifest with missing
objects; restore detects that and falls back to the newest complete snapshot.

The server's mounts are fixed by the sealed deployment spec, so admitting the
backup mount and the identity helper's writable request directory are
deployment-spec changes in the first step. Snapshots are ordered by repository
number and sequence, and file names must match the signed repository, sequence
and kind.

### Recovery key

The only credential that opens a backup is the user's recovery key: one encoded
string with a checksum carrying the private half of an asymmetric recipient pair
(X25519 in the style of `age`, or an equivalent reviewed scheme) and the public
key that verifies manifest signatures. The user-facing term is "recovery key".
It is shown once at setup, offered for copy, save and print with an optional QR
code for another device, and confirmed by pasting it back before backups turn
on. An abandoned setup discards the keys.

The host keeps the public recipient key (confidential host state, never written
to a destination), the private signing key and a fingerprint key in
`VERITY_ROOT/backup-state/`, outside every snapshot. None of them decrypts a
snapshot, so scheduled capture works with a sealed secret store and after an
unattended restart. A compromised host can read current data and forge new
snapshots; it cannot open snapshots already written as long as nobody enters
the recovery key on it. Restore, rollback, the probe and partial restore do
enter it on the host, held in memory for that operation only; a compromised
host can capture it then. The app says so where it asks for the key. After a
suspected compromise the host's own snapshots are untrustworthy, because the
attacker held the signing key; the user restores onto a clean host from an
off-host copy made before the compromise, with `--new-identity`, and replaces
the key there.

Every manifest is signed; the signature covers the whole manifest including
each object's ID, digest and length, the repository identity, format version and
sequence number, and is verified before any field is used. A copy of the signing
key, encrypted to the recipient, lives in the repository, so a restored host
recovers it, checks it against the verification key in the recovery key, and
keeps writing snapshots that the same recovery key opens.

Do not support the master password, another passphrase or account recovery as
decryption paths. Neither Verity's hosted service nor a Uplink account can
recover a lost key. Use a maintained authenticated streaming-encryption
implementation with ordering, truncation and completeness checks, encrypt names
and metadata as well as content, bound parsing resources, and never log keys or
pass them as arguments.

### Inner secret store unchanged

Snapshots carry the database with its encrypted secret columns, salt and
verifier as they are. No derived key is exported and the self-update key export
is not used. After restore the user unlocks with the master password that was
current at capture time, through the existing route. A forgotten master
password leaves stored credentials unrecoverable even with a valid snapshot and
recovery key; restore says so before unlock.

### Format and key lifecycle

Manifests carry a format version, and every format version gets a test fixture.
A repository is never rewritten in place: a new format or a replaced recovery
key starts a new repository with a full first run, and the old one expires under
normal retention. The app shows which recovery key generation each snapshot
needs. One recovery key per installation; the envelope format stays extensible
to several recipients.

### Scope

Every snapshot includes the complete application database, everything under
`VERITY_ROOT/workspaces`, `VERITY_ROOT/sessions` and the knowledge folders, the
installation identity, and a manifest with scope, lifecycle states, release and
schema version (`SERVER_COMPAT`), excluded paths with sizes, per-project size
and warnings.

Exclusions are one fixed, source-controlled list (regenerable dependency and
cache directories, managed dependency volumes, Docker images and caches, control
sockets, materialized secrets, Verity's own backup state and capture staging),
reviewed like a schema change; every skipped path is listed with its size.
Version one has no user-defined exclusions. The status shows captured size per
project and warns above 2 GB.

Not included, each warned per project: writable container layers (restore always
provisions fresh containers, ADR 0020), services inside project containers and
custom mounts outside `VERITY_ROOT`, and the agent gateway state with provider
sign-ins.

### Self-contained Git capture

Every Git repository is captured self-contained, with all its objects. Nothing
depends on a code host at restore time. No Git command the backup runs reads a
sandbox-written file: capture freezes each `.git` with an fd-relative, no-follow
copy into server-owned staging, replaces `config` with a sanitized one, moves the
user's `config`, `config.worktree`, hooks and alternates out of Git's reach and
stores them as user content, and checks connectivity on the frozen copy with
bounded re-freezes. Restore validates every worktree pointer before the first
Git command, keeps user configuration staged until the last Git command has run,
and then reinstates it. Every command also uses a hardened invocation as defense
in depth.

Leaving pushed history on the code host is a later optimization, enabled only
when measured sizes justify it.

### Database export

The server exports the database through its existing PostgreSQL client with
per-table `COPY` in fixed table and key order under one repeatable-read
transaction, through a dedicated read-only role whose credential lives outside
the secret store. The server image does not ship `pg_dump`. Segmentation for
row-level deduplication is deferred.

### Incremental, installation-owned repositories

The repository is incremental from the first release: content-defined chunking,
deduplication before encryption within one repository, a keyed host-local index
that is a cache and never restore authority, a fresh data key per object,
objects published before the immutable manifest, and garbage collection that
honours every retained snapshot, every lease and a grace period. Because the host
cannot read manifests, it records each snapshot's object references at publish time
and garbage collection fails closed when they are missing.

Each installation writes only to its own repository, identified by an
installation id that the installer writes on every fresh install and every
fresh-host restore and that is never restored from a backup. A restored host
opens a new repository and never writes or prunes another installation's.
A same-host rollback keeps the installation id and continues its current repository.
The next sequence number is read from the repository, not from restorable state.

### Consistency without a global drain

Take one transaction-consistent database export whose snapshot is opened under
the lifecycle lock, hold that lock only while the snapshot is opened and `.git`
directories are frozen, copy working files live with change
detection, and record the copy window and active turns, which restore marks
interrupted. Do not drain turns, pause containers or wake sleeping projects.

### Identity in snapshots

Each run reads the allowlisted identity files the server can read (deployment
id, pairing identity key, TLS key and certificate, CA certificate) from its
read-only mount of `/etc/verity` and stores them as a separate encrypted
manifest section. The CA private key is root-only by design; a host helper that
the installer installs, in the pattern of the host runtime helper of ADR 0008
Amendment 2, encrypts it to the recipient key and writes it into the backup
directory whenever backups are set up, the key is replaced or the CA changes.
Restore authenticates that file against the CA certificate in the signed
snapshot. A fresh-host restore always reinstates the identity, with the device
tokens, so devices reconnect without pairing and without a question in the flow.

Every device revocation is also written, when it happens, as a signed entry into
the backup directory outside any snapshot. Fresh-host restore and same-host
rollback apply every entry the entered key can open before the restored server
starts, so a device revoked after the snapshot stays revoked; entries under a
later key generation are reported and the restore requires a review of paired
devices. The first screen after a restore lists paired devices with a revoke
action for revocations a stale copy cannot know. The installer
flag `--new-identity` generates a new identity and revokes device tokens, for a
compromised source host or a trial restore beside a running original. Preview
links, capability generations, enrollment recovery records and queued jobs are
never revived.

### Operations and alerting

Defaults: a run every six hours, configurable from hourly to daily; retention of
every snapshot of the last 48 hours, then 7 daily, 4 weekly and 6 monthly, plus
the last two pre-update snapshots; one catch-up run after downtime; a six-hour
run timeout and a one-hour timeout for the pre-update snapshot; no overlapping runs; retry with backoff when the directory is
unwritable or full; low CPU and IO priority. The snapshot sequence number is
authoritative for order and retention; timestamps are for display.

Alerts use the existing push sender and stay on the backup screen until
resolved: no committed snapshot for twice the interval or 48 hours, two
consecutive failed runs, an unwritable, unmarked or nearly full directory,
unreadable identity files, and a restore probe older than 90 days.

### Backup before server updates

The Updater requests one snapshot over the control channel after `preflight`
and before `creating-standby` ([ADR 0008](0008-verity-server-self-update.md)),
while the old Server still serves. With backups configured, "Updates wait for a
backup" is on by default: a failed snapshot holds the update with the reason in
the app. The administrator may choose "Update anyway", which records the update
as unbacked. Automatic updates never override the gate. Without configured
backups, or while paused, the update runs with a note in the update history.
Changes made between the snapshot and the switch are not in it; the rollback
prompt says so.

### Restore

The installer offers fresh-host restore from a backup directory on local media,
without Uplink or a subscription: pick a snapshot, paste the recovery key over
SSH, check that the snapshot's release has an image for the host's architecture
before touching anything, restore into staging, validate, write a new
installation id, regenerate host-specific state, reinstate the identity and
start the pinned release. Projects come back suspended and are resumed by the
user.

The installer's same-host rollback restores database and data from a pre-update
snapshot into the existing installation, keeps identity, pairing and the
host's own backup state (keys, index, target id), applies the revocation
journal, pins the snapshot's release and writes the automatic update hold into
the restored database before starting it. The Updater's own rollback phases stay the first line.

The app offers restoring one project from a snapshot as a new project and
downloading a single file. Both ask for the recovery key for that operation and
hold it in server memory only.

### Restore probe

A backup counts as verified only after a probe passed. The app starts it with
the recovery key entered for that run and held in memory only; it authenticates
every object of the newest snapshot, imports the database into a throwaway
container, checks Git connectivity in temporary staging and compares with the
manifest, without changing the installation. CI runs the probe on fixtures of
every format version. Backups show "unverified" until a probe passes, and the
alerting reminds after 90 days.

### Deletion and shutdown

A single snapshot can be deleted with confirmation. "Pause backups" stops the
schedule and the pre-update snapshot and keeps the data. "Delete all backups"
removes this installation's repositories, CA key files and revocation entries
after typed confirmation; older-generation CA key files are removed with the
last repository of their generation. There is no
per-file purge in version one.

### Authorization and execution identity

Setup, runs, restore operations, the probe, deletion and policy changes require
installation administrator authorization, enforced server-side on every
request; agents and project containers receive no backup authority. Capture runs
inside the server process with bounded memory. A separate worker would add a
trust boundary without removing the server's Docker socket access (ADR 0017);
the capture interface stays free of server internals so it can move behind the
policy gateway later.

### Core and Premium boundary

Core owns capture, encryption, the format, the host-path destination, restore,
the probe and an open ciphertext transfer contract. Premium Uplink adds managed
off-site storage, account-owned repositories, host-independent minimum
retention, quotas and billing in the separate hosted service, and never receives
plaintext or recovery keys.

### Sequence

1a: self-contained capture, host-path destination, schedule, retention with
garbage collection, the disk-full alert, recovery key, identity in snapshots,
minimal installer restore and restore probe. Existing hosts re-run the
installer once for the mount, the identity helper, the installation id and the
read-only database role, in the pattern of ADR 0008 Amendment 2; until then the
app shows that backups need the installer. 1b:
pre-update snapshot with the gate and "Update anyway". 1c: alerting, retention settings
and snapshot list, snapshot deletion, project and file restore, same-host
rollback. 2: Premium Uplink upload and account-based installer download,
enrollment continuity. 3: remote-dependent Git, takeover, quiesced pre-update
snapshot, database segmentation, several recovery keys, per-project exclusions.

## Consequences

Users must keep their recovery key; losing every copy makes the backups
unrecoverable. Snapshots carry device tokens, the pairing identity and the TLS
keys, and the backup directory carries the CA key: whoever holds the directory
and the recovery key can stand up a host that the paired devices accept. That
is the price of restoring without pairing, and `--new-identity` is the way out
when it is unwanted. Snapshot file names reveal count, kind and order of
snapshots in plaintext, so the app can list them without the key. Each snapshot's stored credentials need the master password that
was current at capture time.

Version one does not survive loss of the host disk unless the administrator
copies the backup directory elsewhere; the product says so at setup and in the
status. Self-contained Git capture costs storage and lock time, because a repack
re-writes the objects and the freeze copies every `.git` where reflinks are
unavailable; both are measured and shown.

Fresh-host restore keeps the deployment identity (deployment id, pairing and
TLS keys) but writes a new installation id, which alone owns repositories. Two
hosts restored from the same snapshot would therefore answer as one deployment; `--new-identity` is the
documented way around that. Two restored hosts never damage each other's
backups, because each owns its repository. The pre-update snapshot misses
changes made between the snapshot and the switch.

Because the host holds no private key, verifying a backup always means a restore
probe with the recovery key. A successful run is not a verified restore; status
shows last backup, last passed probe and scope separately.

Deferred, with their mechanics kept in the concept's "Later" part:
remote-dependent Git capture with trusted tips, local-only packs and
rehydration; takeover of another installation's repository with fences;
the quiesced final pre-update snapshot and the two Updater changes it needs;
database segmentation; further destinations; several recovery keys; per-project
exclusions; Premium minimum retention.

## Verification requirements

Prove fresh-host recovery with only the copied directory, the recovery key and
the master password, with the original host and its index destroyed: settings,
usable credentials after unlock, knowledge, all worktrees, active, sleeping and
paused projects, and devices reconnecting without pairing. Prove that
`--new-identity` requires pairing, that a device revoked after the snapshot
stays revoked after restore and rollback, and that a CA key file not matching
the snapshot's certificate is refused.

Test wrong keys, tampering, truncation, an unsigned manifest encrypted to the
recipient, unsafe paths and links, a sealed secret store, a full disk, a missing
marker, interrupted runs and unsupported formats; each must fail safely and
never replace the last good snapshot. For Git, prove that staged-only blobs,
stash and reflog entries survive, that malicious `config`, `config.worktree` or
hooks never execute, that pointers outside the project are refused, and that a
concurrent `git gc` is detected. Prove that two restored hosts never prune each
other's repositories, that the pre-update snapshot precedes `creating-standby`,
that a failed one holds the update, that "Update anyway" records an unbacked
update and that automatic updates never override the gate.

Measure transferred and retained bytes after small edits, and the lock duration
on a large installation without reflinks. Prove retention, shared-object
survival on snapshot deletion, same-host rollback including the architecture
abort, and that a recovery key entered for a probe or partial restore never
reaches disk or logs. Deliberately break each guard before trusting it.

## References

- [Detailed backup and recovery concept](../BACKUP_RECOVERY_CONCEPT.md)
- [App mockups](../assets/backup/)
- [Credential and isolation architecture](0002-credential-and-isolation-architecture.md)
- [Verity server self-update](0008-verity-server-self-update.md)
- [Docker policy gateway](0017-docker-policy-gateway.md)
- [Knowledge realms and namespaces](0018-knowledge-realms-and-namespaces.md)
- [Project sandbox sleep and automatic wake](0020-project-sandbox-sleep-and-automatic-wake.md)
- [Enrollment storage and recovery lifetime](../protocols/uplink-enrollment-storage-v1.md)
