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
encrypted repository, with self-contained exports available for portability.
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
exclusion that is derived per repository rather than listed by path, and it is
the largest size saving after dependency directories: `.git/objects` is the bulk
of a clone, and Git repacks it periodically into differently compressed packs
that defeat chunk deduplication even when no commit changed.

For a repository whose `origin` points at the connected code host, capture
excludes `.git/objects` and replaces it with a packfile of every object that is
reachable from local refs, from reflogs or from the index of any worktree but
not from a trusted tip: the default branch commit Verity itself last saw on the
code host, recorded in the database by the server-side clone, fetch and push
paths that run outside the sandbox. Remote-tracking refs are not trusted for
this, because everything under `.git` is writable from the sandbox and a ref
moved onto a local-only commit would silently drop history from the pack. Only
the default branch is excluded, not every remote branch: feature branches are
routinely squash-merged and deleted on the host, and a stale tip for a deleted
branch would exclude commits the host no longer holds. Without a recorded tip
that exists locally, with alternates, submodules, or a shallow or partial clone,
the repository is captured self-contained. Reflogs and the index matter: staged
but uncommitted blobs, older stash entries and commits left behind by reset,
rebase or amend are reachable only from there, and the restored `index` and
`logs` would point at missing objects otherwise. The manifest records the
trusted tip and its branch as the prerequisite. Everything else in `.git` is included, so
branches, stash, index, reflogs, session worktree registrations and the remote
URL survive. Repositories without a remote, including today's local projects
that still hold an empty initial commit, shallow or partial clones, and
repositories whose `origin` is not the connected code host fall back to a
complete copy of `.git/objects`.

The manifest marks each project as `remote-dependent` or `self-contained`, with
the remote URL, the code host connection it belongs to and the set of
prerequisite commits. Restore rehydrates a remote-dependent repository by
restoring `.git` without objects, importing the local-only packfile, fetching
from the code host through the restored connection with `--refetch` so dangling
local refs do not steer the negotiation, checking the prerequisite and running
`git fsck`. The credential travels as an in-memory `http.extraheader` for that
one command, as the provisioner does today, passed through the child's
`GIT_CONFIG_*` environment rather than argv, never through a helper or a file.
Every Git command the backup runs, at capture as much as at restore, uses one
hardened invocation: the backup execution identity, no system or global config,
and command-line overrides for every key that can execute or redirect
(`core.hooksPath`, `core.fsmonitor`, `core.sshCommand`, `credential.helper`,
`protocol.allow`, `gc.auto`, `maintenance.auto`, `safe.directory`), because
`.git/config` is writable from the sandbox. Classification and the remote URL
come from the project record in the database, not from `.git/config`.
The pack is built with `--local` so objects borrowed through alternates cannot
enter a project's backup. Rehydration additionally sets the restored `config`,
per-worktree `config.worktree` files and `hooks` aside durably next to the
project and puts a sanitized configuration in its place that carries only the
remote URL from the project record, the repository-format keys
(`core.repositoryformatversion`, `core.bare`, `extensions.*`) and the standard
`remote.origin.fetch` refspec. Users and agents can edit `config` and `hooks`,
and settings such as `core.sshCommand`, `core.fsmonitor`, `credential.helper`
or `url.*.insteadOf` would otherwise run code or redirect the fetch credential
during restore. The restored `config` and
`hooks` are put back only after `fsck` passes, and never run during restore.
Rehydration needs the secret store unlocked, because the connection credentials
live there, and it needs the code host reachable. When the host is unreachable,
the connection is revoked, or the prerequisites no longer exist because history
was rewritten or the repository was deleted, the project stays suspended with a
"Code incomplete" warning and its working files and local commits intact. The
user can retry rehydration after reconnecting. The restore never reports such a
project as recovered.

This makes the backup of a code project complete only together with the code
host. The ADR accepts that: the host already is the system of record for pushed
history, and the installations Verity targets keep their code there by design.
The restore UI states this dependency per project before activation. A
stale default branch tip errs on the safe side and includes more objects; a
default branch that was force-rewritten after the last fetch is the residual
loss case and is surfaced, not hidden. Self-contained repositories keep
re-uploading their packs after `git gc`; the saving applies to remote-dependent
repositories.

### Mandatory incremental repository

Incremental transfer and storage are first-release requirements. The first
snapshot uploads all included content; later snapshots reuse unchanged encrypted
objects and upload only new objects and a new manifest. Each snapshot describes
its complete logical state and references objects directly, rather than requiring
a replay of every intervening backup. Shared objects remain necessary for restore;
a manifest alone is not a standalone backup.

Use content-defined chunking for files so insertions do not shift every later
block boundary. Deduplicate before encryption, within one repository and recovery
key generation only. Never use plaintext hashes as public object names, derive
encryption keys from content, or use deterministic encryption. The host keeps a
restricted local index mapping keyed content fingerprints to random opaque
object IDs; the fingerprint key is random per repository, kept in the same
restricted host-local storage as the index because sealed capture must work, and
stored in the repository encrypted to the recipient for index rebuilds. It
protects a leaked index, not a compromised host.
That index contains sensitive information and must not be uploaded unencrypted.
Destination observers can still infer sizes, timing and reuse patterns.

Each new object receives an independent random data key, authenticated encryption
and an envelope to the public recovery recipient. Encrypt manifests the same way.
Manifests carry ordered object references, envelopes, integrity information,
file metadata and the repository/key-generation identity. Bind those identities,
object type and format version into authentication. Reusing an object reuses its
existing ciphertext and envelope; encrypting new objects never reuses a nonce or
key. Use reviewed maintained primitives; the exact container format, chunk sizes
and library selection require implementation review and cross-version fixtures.

The host holds only the public recovery key and the fingerprint/reference index,
not persistent object decryption keys. It can create new encrypted manifests by
copying opaque envelopes from its index without opening old objects. The index is
a cache, not restore authority: every committed snapshot contains the encrypted
information needed to reconstruct its files and rebuild the index. After index
loss, supply the private key in a controlled recovery process to rebuild it, or
start a new repository with a full upload. Never silently persist the private key
for unattended deduplication. A new recovery key starts a new repository generation
with a full upload; sharing old objects across generations is deferred. Old
snapshots still need their original private key.

Publish immutable objects first and an immutable snapshot commit last, after the
destination durably acknowledges all references. Resume uploads by opaque object
ID, verify stored ciphertext checksums and lengths, and serialize publication and
pruning with repository concurrency control. Missing or corrupt dependencies make
a snapshot incomplete and trigger repair or re-upload when source data is
available. A partial job never replaces a committed snapshot. Checksums detect
transfer faults; they do not replace authenticated decryption during restore.

Retention removes snapshots first; garbage collection removes objects only when
no retained snapshot references them, no upload or restore lease needs them, and
a safety grace period has elapsed. Reference tracking and deletion must survive
crashes and concurrent jobs. Premium's destination-side protection covers both
manifests and every referenced object for the entire protected lifetime; a host
cannot erase shared dependencies to bypass snapshot retention. Other destinations
must explicitly report whether equivalent protection is available. Write-only
credentials alone do not provide immutable retention or enough listing/read
access for repository reconciliation.

Restore reads a selected manifest and all its referenced objects, authenticates
them and stages a complete installation. App export assembles a self-contained
bundle of that manifest and its reachable encrypted objects, without decrypting
on the source host; downloading that bundle transfers the full selected state.
Repository-to-repository replication transfers only objects missing at the target.
An export carries the same content as the snapshot, so a remote-dependent code
project keeps its code host dependency in the export; the export dialog offers
"include pushed history", which adds that project's full `.git/objects` to the
export only, and shows the size difference. The UI distinguishes incremental
repository backups from full portable downloads and reports scanned bytes, new
ciphertext bytes and total retained storage.

### Incremental application database

Do not equate chunking a compressed PostgreSQL dump with efficient database
backup: small row changes can rewrite large portions of that stream. In the first
release, use a versioned complete logical export under one repeatable-read
snapshot, with stable table/primary-key ordering and bounded deterministic
segments. Deduplicate segments before per-object compression and encryption.
Include schema/migration metadata, sequence state, all stored secret ciphertext
and a supported transactional import path. Define deterministic encodings for
binary values, nulls and types; tables without stable keys require an explicit
ordering strategy. Do not promise unchanged segment boundaries across schema or
export-format changes: those may require a new full database upload.

This approach still scans the database each time; it reduces transfer and retained
storage, not necessarily capture time. Acceptance must measure a representative
large database after a small row edit, insertion and deletion and prove that
unrelated tables are not uploaded again. No incremental success claim without
those measurements and a full restore. Physical base backups plus WAL are a
possible later optimization, with different privileges, PostgreSQL-version
coupling and retention dependencies; they are not silently added to version one.

### Consistency without a global drain

Do not drain turns or block all mutations for capture; an agent loop can run for
hours and would turn a nightly backup into a maintenance window. Instead:

- Take one transaction-consistent logical snapshot of PostgreSQL (repeatable-read
  segmented logical export). This is the authoritative state.
- Hold a lifecycle lock during local capture (not remote upload) that refuses provision, deprovision,
  sleep, wake, mount changes and project deletion. Turns, file edits and commits
  continue.
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
downgrade path. Every update therefore attempts a snapshot first. By default an
update without a destination still runs and is recorded as unbacked; the
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
Server to serving through the journal's existing rollback path from
`quiescing-old`. The snapshot is tagged `pre-update` with the previous and target
release and is retained by a separate rule, at least the last two pre-update
snapshots, independent of the ordinary schedule's retention.

One rule decides whether the Updater continues after the final snapshot. It
continues when the snapshot is durably committed at a configured destination.
If every configured destination needs the unlocked secret store and the store is
sealed, which can happen because an update may run sealed and the promoted
Server then starts sealed too, the Updater continues once the snapshot is
durably in the local spool and records the update as "backed up locally only".
Anything else, a failed or timed-out snapshot or a spool that is full, aborts the
update before any irreversible step, never after it. "Require a backup" tightens
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
Every update is preceded by a snapshot, which adds its duration to the update
and makes a configured destination part of a healthy installation. Live worktree copies
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
`config.worktree` never executes during restore, and that a repository without
a remote restores without any network. Prove that an
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
