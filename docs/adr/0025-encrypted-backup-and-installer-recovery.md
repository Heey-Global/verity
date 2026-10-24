# ADR 0025: Encrypted backups and installer recovery

- Status: accepted (architecture decision; functionality not implemented)
- Date: 2026-10-03

## Context

Verity needs recoverable backups of configuration, credentials, project files,
sessions and knowledge, including retained data of active, sleeping and paused
projects. Application state spans PostgreSQL, the `verity-data` volume
(workspaces, session worktrees, knowledge folders) and a few service volumes; a
database dump alone is insufficient. Large regenerable dependencies should not
inflate backups, but library originals and authored notes may be irreplaceable.
Code projects are clones of repositories on a connected code host, GitHub or
Forgejo, so their pushed history has a system of record outside Verity. Server
updates run forward-only schema migrations, which makes the moment before an
update the one where only a backup can undo damage.

Backups must be encrypted on the self-hosted Verity host before transport or
storage. Local recovery must remain available independently of Premium Uplink.
The existing master password protects the live secret store; it is derived with
scrypt and held only in memory (`packages/store/src/crypto.ts`,
`packages/server/src/secret-key.ts`). The server offers `/secret/init` and
`/secret/unlock`, but no password change and no rekeying of stored secrets.

Two threats shape the design beyond provider disclosure. First, a compromised
or ransomed host: whatever key material the host holds for scheduled backups is
available to an attacker on that host, and whatever the host may delete at the
destination, the attacker may delete too. Second, a backup that was never
restored: every prior incident class in this repository that stayed green until
it mattered argues for a recurring restore probe, not a one-time proof.

## Decision

### Recovery key as a private recipient key

The only credential that opens a backup is a locally generated, cryptographically
random 256-bit recovery key. It is the private half of an asymmetric recipient
pair (X25519 or an equivalent reviewed scheme in the style of `age`). The host
stores only the public recipient key. Each immutable object and manifest uses a fresh random data key,
wrapped to that public key; decryption needs the private recovery key, which
exists only in the user's recovery kit.

Consequences of this choice:

- Scheduled backups need no secret on the host. Encrypting to a public key works
  while the secret store is sealed, after an unattended restart, and without
  any key file that a host compromise could exfiltrate.
- A host compromise still exposes everything the host can read at that time. It
  does not give the attacker the ability to open archives already sitting at a
  destination, and it does not give them future archives' data keys unless they
  stay resident on the host.
- Rotating the recovery key means generating a new pair. Old archives still
  need the old private key. The settings UI lists which key generation each
  retained archive requires; cross-generation rewrapping is deferred. Start a new repository generation
  with a full upload and retain the old private key for older snapshots.

Do not support the master password, another passphrase or account recovery as
alternative decryption paths. Neither Verity's hosted service nor a Uplink
account can recover a lost key.

The recovery kit shows the key as text with a checksum and as a QR code. Setup
requires a successful re-entry check. Restore accepts QR scan, clipboard paste
and typed entry with checksum validation; a 256-bit key must never have to be
typed by hand on a phone as the only option. Recommend a password manager plus
an independent offline copy.

Use a maintained authenticated streaming-encryption implementation for payload
and manifest, with ordering, truncation and completeness checks. Version the
format and bound parsing resources. Final algorithm suite and nonce handling
require implementation review. Encrypt sensitive names and metadata as well as
content; storage providers can still observe sizes and upload times. TLS remains
required in addition to archive encryption. Do not log keys or pass them as
command-line arguments.

### Inner secret store unchanged

Keep the inner secret-store encryption as it is. The archive carries the
database with its encrypted secret columns, the stored salt and the password
verifier, exactly as they exist at capture time. The archive does not carry the
derived secret key, and the backup does not call the self-update key export.
After a restore, the user unlocks the secret store with the master password that
was in effect when the backup was taken, through the existing unlock route, just
as after any server restart. The recovery key protects the archive; the master
password protects the stored credentials inside it. Offline guessing against the
archive is not possible without the recovery key, so the master password's
strength does not weaken backup security. A sealed secret store can still be
backed up completely, because capture copies ciphertext without needing the key.
Restore must report that credentials remain locked until the master password is
entered, and a forgotten master password leaves stored credentials unrecoverable
even with a valid archive and recovery key.

### Scope

From the first release, create complete logical snapshots in an incremental
encrypted repository; self-contained portable exports follow in a later step.
Every snapshot includes:

- the complete application database (settings, projects, memberships, sessions,
  histories, permissions, attachments, knowledge revisions, backup policy);
- every project workspace and session worktree under `VERITY_ROOT`: working
  files, untracked files and ignored user files such as `.env`, Git metadata
  (refs, index, stash, reflogs, worktree registrations, hooks and config), and
  the Git objects that only exist locally. Objects the connected code host
  already holds are not copied; see "Git history and code hosts" below;
- knowledge folder contents on disk;
- the manifest: scope, per-project desired lifecycle state, the server release
  and schema version (`SERVER_COMPAT`), capture timestamps, excluded paths with
  counts and sizes, and every warning described below.

Record retained deprovisioned projects where data still exists. Phone-only
preferences are outside a server backup unless separately exported.

Exclusions are a fixed, documented list, not a heuristic. The initial list covers
managed dependency directories and build caches that a toolchain regenerates
from included sources (for example `node_modules`, `.venv`, `target`,
`.next/cache`, `__pycache__`, `.gradle`), managed dependency volumes, Docker
images and build caches, control sockets, and the short-lived materialized files
under `<VERITY_ROOT>/secrets`. Every skipped path is listed in the manifest with
its size. Nothing else is excluded: no folder named `library`, no ignored file
outside the list. The list lives in one source-controlled place and changes to it
are reviewed like schema changes.

Deliberately not included, each reported as a per-project warning in the
manifest and at restore:

- Writable container layers. ADR 0020 treats the stopped container as reusable
  cache with a full-provisioning fallback; `docker export` output is large and
  not portable across hosts. Anything that must survive belongs in the worktree
  or the devcontainer definition. Restore always provisions fresh containers.
- Databases and other services running inside project containers, and custom
  bind mounts outside `VERITY_ROOT`. The first release does not ship export
  adapters. The manifest names the project and the mount, and the backup is
  shown as complete for Verity state and incomplete for that project's
  in-container services.
- The agent gateway state volume with spilled provider tokens. Restore requires
  the user to sign in to Claude and Codex again.

Later selective content profiles must show omissions and size estimates. Selective
knowledge/database export needs dependency-aware import/export; do not filter rows
out of an ordinary dump. A partial backup must never appear to be a full backup.

### Git history and code hosts

History that is already pushed to the project's code host, GitHub or Forgejo, is
recoverable from that host and is not copied into the backup. This is the one
exclusion derived per repository rather than listed by path, and the largest
size saving after dependency directories: `.git/objects` is the bulk of a clone
and Git repacks it periodically, which defeats chunk deduplication even when no
commit changed. The decisions below are binding; the mechanics, command lines
and edge cases live in the concept's "Git history and code hosts" section and
are not repeated here, so that one text stays authoritative.

- A repository is `remote-dependent` only when the server's project record ties
  it to the connected code host and the server has recorded a trusted tip: the
  default branch commit it last saw on the host through its own clone, fetch or
  brokered push. Nothing read from `.git` decides classification; everything
  under `.git` is writable from the sandbox.
- For a remote-dependent repository the snapshot replaces `.git/objects` with a
  packfile of the objects reachable from local refs, reflogs and every
  worktree's index but not from the trusted tip. Only the default branch is
  excluded, because deleted feature branches leave stale remote-tracking refs.
  Reflogs and the index are included so staged blobs, stash entries and
  reflog-only commits survive.
- The objects behind the tip are verified with `git fsck` before the pack and
  a mismatch forces a self-contained copy; the full read of pushed history per
  snapshot, outside the lifecycle lock, is the accepted price.
- No Git command the backup runs reads a sandbox-written file. Capture freezes
  the repository first: an fd-relative, no-follow copy of the whole `.git` into
  server-owned staging that a concurrently running sandbox cannot redirect, with user `config`, `config.worktree`, `hooks`, alternates, shallow,
  graft and replace files moved out of Git's reach and carried as user content.
  Restore sets the same files aside before its first command and returns them
  after `fsck`. A hardened invocation with overrides for executable keys is
  defense in depth, not the protection. The Git floor on server and installer
  images is 2.39.
- Everything that does not qualify, including repositories without a remote,
  today's local projects, shallow or partial clones, grafts, replace refs,
  submodules, alternates, unknown extensions, and any `gitdir` or symlink
  pointing outside the project,
  is captured `self-contained` or, where Git cannot safely run, as plain files
  with a "not validated" warning.
- Rehydration at restore imports the local-only pack, fetches from the code
  host into a fresh bare repository with a Verity-written allowlisted
  configuration and the credential in the child's environment, moves the packs
  over (with `fetch.unpackLimit=1`, so nothing arrives loose), rewrites
  remote-tracking refs in one `update-ref` transaction, checks
  the prerequisite and runs `fsck`. It needs the secret store unlocked and the
  host reachable. Failure leaves the project suspended with a "Code incomplete"
  warning, its working files on disk and its local commits preserved as the
  unimported pack; the user may retry or resume in a defined "working files
  only" state.
- Pending state is captured by later snapshots under its own
  `pending-rehydration` class, carrying the original remote URL, connection and
  trusted tip forward, so a later restore can still rehydrate it. No pin on the
  source snapshot is attempted, because it could not be enforced.

This makes the backup of a code project complete only together with the code
host. The ADR accepts that: the host already is the system of record for pushed
history, and the installations Verity targets keep their code there by design.
The restore UI states this dependency per project before activation. A stale
tip errs on the safe side and includes more objects; a default branch that was
force-rewritten after the last recorded tip is the residual loss case and is
surfaced, not hidden. Self-contained repositories keep re-uploading their packs
after `git gc`; the saving applies to remote-dependent repositories.

### Mandatory incremental repository

Incremental transfer and storage are first-release requirements. Decisions:
content-defined chunking and deduplication before encryption, within one
repository and key generation; keyed fingerprints in a host-local index that is
a cache, never restore authority, rebuildable with the private key; a fresh
random data key per object wrapped to the public recipient, no deterministic
encryption and no content-derived keys; every snapshot a complete logical
description that references objects directly; objects published before the
immutable snapshot commit, and garbage collection that honours every retained
snapshot, in-flight leases and a grace period; key rotation starts a new
repository generation, cross-generation rewrapping is deferred. Portable exports
carry the same content as a snapshot and may optionally include pushed history.
The concept's section of the same name holds the detailed format and retention
rules.

### Incremental application database

The database is captured as a transaction-consistent, deterministically
segmented logical export through a read-only role whose credential lives
outside the secret store, so a sealed server can still capture. Segments are
stable across runs so that unchanged rows deduplicate; physical or WAL-based
optimizations are deferred. Details are in the concept's section of the same
name.

### Consistency without a global drain

Do not drain turns or block all mutations for capture; an agent loop can run for
hours and would turn a nightly backup into a maintenance window. Instead:

- Take one transaction-consistent logical snapshot of PostgreSQL (repeatable-read
  segmented logical export). This is the authoritative state.
- Hold a lifecycle lock only while repositories are frozen and working files
  copied, not during verification, packing or upload; it refuses provision,
  deprovision, sleep, wake, mount changes, project deletion and rehydration of
  a pending project. Turns, file
  edits and commits continue.
- Copy worktrees live with before/after change detection and bounded retries.
  This is not an atomic filesystem snapshot: Git validation cannot recover
  missing objects or guarantee coherent application files. Flag unstable paths
  and incomplete projects explicitly; never label them fully recoverable. Restore
  runs `git fsck` and `git worktree repair` and reports unrecoverable repositories.
- Record in the manifest the database snapshot time and the file-copy window, and
  mark every turn that was active in that window. Restore already has to mark
  interrupted turns and refuse to replay them; capture relies on that instead of
  duplicating it with a drain.

Docker pause is not used; it neither establishes application consistency nor is
needed under this model. Do not wake sleeping projects to copy retained files.
Release the lifecycle lock on every exit path and restore the prior lifecycle
state on the original host.

Session worktrees point to their main repository through an absolute `gitdir`
path. Restore either reinstates the same `VERITY_ROOT` or rewrites the `.git`
pointer files and the `worktrees/<name>/gitdir` entries before validation.

### Backup before server updates

A server update is the one moment Verity itself puts the data at risk: the
promoted Server runs forward-only schema migrations on start, and there is no
downgrade path. Every update on an installation with a backup destination
therefore takes a snapshot first. An update without a destination runs and is
recorded as unbacked; the
administrator setting "require a backup before updates" makes it a refusal.

The hook lives in the existing update sequence (ADR 0008). While the old Server
is still serving, before the Updater creates the standby, it requests a full
incremental snapshot over the Server-Updater control channel; this warms the
destination and usually takes only the delta since the last scheduled backup.
After `quiescing-old`, when no turn is writing anymore and before
`handing-off-key` and `activating-candidate`, the Updater requests a final
incremental snapshot. That second pass contains seconds of changes and is the
exact pre-migration state. The Updater continues only after the destination has
durably acknowledged that final snapshot, because it is the rollback point; the
warm pass exists so this wait is short, and the update status shows it as its
own phase. Quiescing must therefore leave the old Server's control socket and
database connection usable, and a failed or timed-out snapshot returns the old
Server to serving through a rollback path from `quiescing-old`; both are new
Updater work, and the Updater's request preempts a running scheduled capture. The snapshot is tagged `pre-update` with the previous and target
release and is retained by a separate rule, at least the last two pre-update
snapshots, independent of the ordinary schedule's retention.

One rule, in three cases, decides whether the Updater continues after the final
snapshot. With no destination configured, no snapshot is attempted and the
update runs, recorded as unbacked. With a destination, the Updater continues
when the final snapshot is durably committed at one of them. If every configured
destination needs the unlocked secret store and the store is sealed, which can
happen because an update may run sealed and the promoted Server then starts
sealed too, the Updater continues once the snapshot is durably in the local
spool and records the update as "backed up locally only". Anything else, a
failed or timed-out final snapshot or a spool that is full, aborts the update
before any irreversible step, never after it. The warm snapshot's failure is
logged and never aborts by itself. "Require a backup" tightens
the rule: only a destination commit satisfies it, a spool-only snapshot is a
refusal, and the refusal names the destination that blocked. The snapshot is
written through the same code path as scheduled backups, so it is incremental,
encrypted to the public recovery key and works with a sealed secret store for
destinations that do not need it. Rolling back an update uses the pre-update
snapshot through the installer's restore path and is documented as such; the
Updater's own rollback phases remain the first line, because they do not touch
data.

### Authorization and execution identity

Full backup creation, download, deletion and policy changes require installation
administrator authorization; project-level access alone is insufficient. Enforce
this server-side on every request, including resumed downloads. Agents and project
containers receive no backup authority.

In the first release, capture runs inside the server process with streaming and
bounded memory, using a dedicated read-only PostgreSQL role for the dump whose
credential is provisioned like the server's own database credential, outside
the secret store, so sealed capture works. A
separate backup worker would buy little isolation today: the server still holds
the raw Docker socket (ADR 0017) and can already read every byte the worker
would read, while a sidecar adds a trust boundary and a coordination protocol to
maintain. Keep the capture interface free of server internals so capture can
move behind the Docker policy gateway when that lands. Reading all backup data is
itself highly privileged regardless of UID; the authorization above is the real
boundary.

### Destinations and retention

Server-side destinations are the default: a configured local path such as an
explicitly mounted NAS, a user-controlled object store, Google Drive, or Premium Uplink. The
server writes ciphertext there without the app being open. Scheduled backups and
large instances use these paths; an archive with many projects is not pulled
through a phone.

App download is the convenience path for manual exports on small instances. The
server keeps a temporary encrypted archive; the app shows progress, downloads
ciphertext directly to a file with bounded memory and resumable transfer, and
hands it to the platform file-save or share flow. Downloads are authenticated
administrator requests bound to one immutable archive, never permanent links.
The UI shows server-copy expiry, offers deletion, and distinguishes a copy on
the original server from an independent off-host copy. A completed download
proves neither an independent durable copy nor a successful restore.

Retention must not be shortenable by the source host. Premium enforces a
server-side minimum retention and delete protection that no credential held on
the host can override; this is a core part of what Premium offers, not a
billing detail. For user-controlled destinations, document that a share the
host can write and delete gives no protection against a ransomed host, and
support append-only or write-only credentials and target-side snapshots where
the destination offers them. Interrupted jobs, full disks and failed uploads
never replace the last good backup.

Premium archives belong to the user's account, not to the deployment identity
that produced them. A fresh installation enrolled under the same account can
list and download them; the lost installation never has to approve anything.

Google Drive delivery uses a dedicated administrator-owned folder and resumable
uploads. Its token remains in the live secret store: sealed capture can spool
ciphertext locally, but upload waits for unlock. Report pending delivery and
bounded spool capacity. Drive does not offer the protected retention promised by
Premium. Restore on a fresh host uses a portable bundle or a complete repository
copy without depending on the lost installation's Google credentials. NAS writes
must validate the mounted destination before capture, avoiding accidental local
writes when the mount is absent.

### Installer recovery

Offer "New installation" and "Restore encrypted backup" in the installer and CLI.
Local-file recovery requires no Uplink service or subscription. Premium download
requires account authorization plus the locally supplied recovery key.

The archive names the server release and schema version it was taken from. The
installer pins that release, restores into it, verifies, and then moves forward
through the normal self-update path. Refuse archives newer than the installer
can run and unsupported downgrades.

Restore into isolated staging volumes. Authenticate the complete archive and
validate paths, links, resource limits, scope and version compatibility before
activation. On a host with an existing installation, staging means a second
PostgreSQL volume and a second data volume exist at the same time; the installer
checks free space for both before starting and tells the user the requirement.
Preserve the existing installation for rollback until acceptance.

The installer regenerates host-specific state rather than restoring it: the
`/etc/verity` state directory and updater token, the host runtime under
`/var/lib/verity/host-runtime`, image pins and gVisor configuration from the
pinned release, TLS and pairing material, and the deployment identity. What
travels in the archive is application state only. Require device pairing and
Uplink re-enrollment. Preserve durable users, roles and integration credentials,
but do not reactivate old device tokens, ephemeral capabilities, preview links,
enrollment recovery records or queued jobs. Reconcile external revocations
before enabling remote access. Validate integrations and report credentials that
require reconnection, including the provider logins lost with the gateway state
volume.

Restore projects suspended, with their desired prior state recorded. Sleeping and
paused projects remain inactive; resume active projects only after verification
and user action. Mark interrupted turns without automatically replaying work.
Same-identity migration is deferred until it can fence the original installation.

### Core and Premium boundary

Core owns local capture, encryption, archive format, recovery, scheduling,
user-controlled destinations and the open ciphertext transfer contract. Premium
Uplink adds managed off-site storage, account-owned archives, host-independent
retention, quotas and billing in the separate hosted service. Both destinations
use the same recoverable format; Premium never receives plaintext or recovery
keys.

The goal is an unattended backup that simply runs, so the first release delivers
the scheduled, incremental, encrypted backup to a host-path or mounted-NAS
destination together with the pre-update hook, and the installer restore that
proves it. App download, Google Drive and Premium follow once the round trip is
proven. Reference tracking, atomic publication, index recovery and safe deletion
are first-release requirements. Defer selective database content and physical
database/WAL optimizations.

## Consequences

Users must preserve their recovery key independently. Losing every copy makes
archives unrecoverable. Recovery-key rotation starts a new repository generation and does not change
old snapshots. Master-password changes do not change archive access,
but each archive's stored credentials require the master password that was
current at capture time; the restore flow must state this before unlock.

Because the host holds only a public key, it cannot verify an archive by
decrypting it. Verification of a backup therefore always means a restore probe
with the private key, performed where the user supplies it.

Complete backups need privileged read coverage and local capacity. Recreating
containers requires network access, compatible images and usable integration
credentials; in-container services and custom mounts are the user's own
responsibility in the first release and are flagged as such. Code projects
depend on their code host for pushed history: a restore without a reachable
GitHub or Forgejo leaves their Code area incomplete until rehydration succeeds.
Every update on an installation with a destination is preceded by a snapshot,
which adds its duration to the update.
A missing destination is a persistent settings warning and an entry in the update
history, not a degraded health state, unless "require a backup before updates"
is set. Live worktree copies
may need repair at restore. Staging restore on an occupied host needs roughly
twice the disk.

A successful export or download is not a verified restore. Show last completed
backup, scope, destination and last restore verification separately.

## Verification requirements

Prove fresh-host recovery with only archive, recovery key and master password,
including encrypted credentials, settings, knowledge revisions, all worktrees and
active/sleeping/paused projects. Verify administrator authorization and denial
for project users and agents. Test wrong keys, tampering, truncation, unsafe
paths, sealed secret stores, full disks, interrupted captures/downloads/uploads,
incompatible versions, revoked access, and repositories copied mid-write.
Demonstrate that restore cannot revive obsolete authority or automatically
execute work. Deliberately break each guard before trusting it. Prove that a restored code
project equals the original after rehydration from GitHub and from Forgejo, that
an unreachable or revoked code host, a deleted repository and rewritten history
each leave the project suspended and flagged rather than silently truncated,
that a session worktree with staged-only blobs and a branch deleted on the host
after a squash merge both restore intact, that a missing trusted tip falls
back to a self-contained copy, that a remote-tracking ref moved onto a
local-only commit from inside the sandbox does not remove anything from the
pack, that a malicious
`config.worktree` in the main or a linked worktree never executes during
restore, that a symlink or `gitdir` entry pointing outside the project is
refused at freeze and before `worktree repair`, that a commit-graph, replace
ref, graft or shallow file written by the
sandbox cannot shrink the pack, and that a repository without a remote restores
without any network. Prove that an
update takes the final pre-update snapshot after quiescing and before the
candidate runs migrations, that a failed snapshot aborts the update before the
key hand-off, that the default records an unbacked update, and that the
"require backup" setting refuses an update whose snapshot only reached the local
spool.

Incremental verification must measure uploaded and retained bytes after small
file edits and database row edits, insertions and deletions. Prove restoration of
older snapshots after source deletion, recovery without the host index, safe key
rotation, interrupted publication, concurrent pruning and shared-object retention.
Missing dependencies must never appear as a complete backup. A portable export
must restore without the originating repository or host; a remote-dependent code
project in it additionally needs its code host unless the export included pushed
history.

Add a restore probe in the pattern of `deploy/bin/verity-clean-install-smoke`:
it restores the newest archive into throwaway containers, checks database
integrity, worktree `git fsck`, settings presence and the manifest against what
was restored, then reports a timestamp that settings show as "last restore
verification". CI runs it against a fixture archive; operators can schedule it
on the host or run it from the installer. A backup whose probe has never passed
is shown as unverified.

## References

- [Detailed backup and recovery concept](../BACKUP_RECOVERY_CONCEPT.md)
- [Credential and isolation architecture](0002-credential-and-isolation-architecture.md)
- [Docker policy gateway](0017-docker-policy-gateway.md)
- [Knowledge realms and namespaces](0018-knowledge-realms-and-namespaces.md)
- [Project sandbox sleep and automatic wake](0020-project-sandbox-sleep-and-automatic-wake.md)
- [Enrollment storage and recovery lifetime](../protocols/uplink-enrollment-storage-v1.md)
