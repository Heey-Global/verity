# Encrypted backup and recovery concept

Status: supporting implementation proposal, not implemented. Architecture decisions
are recorded in [ADR 0025](adr/0025-encrypted-backup-and-installer-recovery.md).
Selected recovery policy: recovery key only, held as a private recipient key.
Scope: self-hosted Core backup and recovery, with an optional separately operated
Premium Uplink storage destination.

## Product behavior

Local encrypted export and recovery belong to Core. The same backup engine can
send ciphertext to user-controlled storage or Premium Uplink. Premium adds
managed off-site storage, account-owned archives and retention the host cannot
shorten, rather than exclusive access to recovery. Initial delivery should
support an incremental local repository, portable export and installer restore; scheduling, server-side
destinations and hosted storage follow after restore is proven.

Encryption happens on the self-hosted Verity machine before bytes leave it.
"On device" means this host, not necessarily the phone controlling it. TLS remains
required in addition to backup encryption. Uplink never receives plaintext data
or recovery keys. Backups protect against storage-provider disclosure and, with
host-independent retention, against a ransomed host deleting its own history.
They do not protect data a compromised host can read at capture time.

## Current evidence

- Production requires PostgreSQL: `packages/server/src/embedded.ts:595`.
  PGlite archives in `packages/store/src/knowledge-backup.test.ts:10` demonstrate
  test coverage, not an existing product backup implementation.
- Database state includes configuration, credentials, sessions and knowledge:
  `packages/store/src/schema.ts:1263`.
- Worktrees and project clones share persistent storage:
  `packages/server/src/provisioner.ts:744`. Knowledge also has filesystem state:
  `packages/server/src/knowledge-folder.ts:49`.
- Managed dependencies have dedicated volumes, but custom mounts exist:
  `packages/server/src/provisioner.ts:966`, `:1157`, `:1183`.
- Secret columns already have inner encryption:
  `packages/store/src/crypto.ts:4`. The master-password key is memory-only:
  `packages/server/src/secret-key.ts:4`. The server offers init and unlock only
  (`packages/server/src/secret-lifecycle-routes.ts`); there is no password change
  or rekey.
- The server holds the raw Docker socket (`deploy/docker-compose.yml`,
  `VERITY_DOCKER_BASE_URL`); ADR 0017 plans the policy gateway.
- Installer state and deployment identity live outside the application database:
  `deploy/bin/verity-install:22`; persistent volumes are defined at the end of
  `deploy/docker-compose.yml` (`verity-db`, `verity-data`,
  `verity-agent-gateway-state`, control-socket volumes).
- Enrollment recovery records explicitly do not support backup restore:
  `docs/protocols/uplink-enrollment-storage-v1.md:120`.
- Release and schema compatibility is already expressed as `SERVER_COMPAT`
  (`packages/server/src/self-update/compat.ts`).
- Smoke-script pattern for a restore probe: `deploy/bin/verity-clean-install-smoke`.

## Backup scope

Always include general and project settings, integration configuration,
recoverable credentials in their stored encrypted form, project/session
identities, histories, permissions, attachments, knowledge revisions and backup
policy. Capture installation configuration through an explicit allowlist and
portable manifest, rather than replaying host configuration files. Mobile-local
preferences require a separate inventory; a host backup cannot claim to include
state stored only on a phone.

Each snapshot includes the complete logical application database plus everything under
`VERITY_ROOT/workspaces`, `VERITY_ROOT/sessions` and the knowledge folders:
working files, untracked files and ignored user files such as `.env`, Git
metadata and local-only Git objects. Pushed history is left to the code host
(see "Git history and code hosts"). Include active, sleeping, paused and retained
deprovisioned projects. Record desired lifecycle state and the actual scope of
each project.

Knowledge folders hold Sources and Documents outside Git
(`knowledge/<projectId>/sources`, `knowledge/<projectId>/insights`). They are
user data without any other copy and are always included in full. A local
project without a repository therefore restores completely from the backup alone.

### Exclusion list

Exclusions are one fixed, source-controlled list, reviewed like a schema change.
Initial entries:

- toolchain-managed dependency and cache directories regenerated from included
  sources: `node_modules`, `.venv`, `target`, `.next/cache`, `__pycache__`,
  `.gradle`, `.turbo`, `.cache` under a workspace root (final list at
  implementation);
- managed dependency volumes created by the provisioner;
- Docker images, build caches and anonymous volumes;
- control sockets and the short-lived materialized files under
  `VERITY_ROOT/secrets`.

Every skipped path appears in the manifest with its size. Nothing outside the
list is excluded. Rebuilding dependencies may need credentials and network
access; report unavailable artifacts at restore time.

### Not included, warned per project

- Writable container layers. ADR 0020 keeps them as reusable cache with a full
  provisioning fallback; they are not portable and restore always provisions
  fresh containers. Persistent state belongs in the worktree or the devcontainer
  definition.
- Services inside project containers (databases, queues) and custom bind mounts
  outside `VERITY_ROOT`. No export adapters in the first release. The manifest
  names project and mount; settings show "Verity state complete, in-container
  services not covered" for that project.
- The agent gateway state volume with spilled provider tokens. Restore asks for
  a fresh Claude and Codex sign-in.

### Git history and code hosts

A clone's `.git/objects` is most of its size, and `git gc` rewrites it into new
packs with different delta compression, so chunk deduplication does not save the
re-upload even when nothing was committed. Pushed history already lives on the
code host, GitHub or Forgejo, and is recoverable from there. The backup therefore
carries only what exists nowhere else.

Capture, per repository whose `origin` is the connected code host:

1. Exclude `.git/objects` (loose objects and packs) from the file copy. Keep the
   rest of `.git`: `HEAD`, `refs`, `packed-refs`, `index`, `logs`, `config`,
   `hooks`, `info`, `worktrees/*` and the stash. The remote URL never contains a
   token (`packages/server/src/provisioner.ts:37`), so `config` is safe to carry.
2. Write a packfile of the local-only objects, equivalent to
   `git rev-list --objects --all --reflog --indexed-objects --not --remotes=origin | git pack-objects`.
   `--reflog` and `--indexed-objects` are what make the restored `index` and
   `logs` consistent: staged blobs, older stash entries and commits reachable
   only from a reflog after reset, rebase or amend have no ref, and a plain
   `--all` bundle would leave dangling pointers behind. The pack is small
   because it holds only unpushed work. Chunk and encrypt it like any other file.
3. Record in the manifest: remote URL, the code host connection id, the
   remote-tracking tips as prerequisites, the local ref list, and the project as
   `remote-dependent`.

Repositories that do not qualify are copied completely, including
`.git/objects`, and marked `self-contained`: no remote, an `origin` that is not
the connected code host, or a shallow or partial clone with a promisor remote,
whose object set cannot be reasoned about locally. Today's local projects, which
still start from an empty initial commit, fall under this; after the "project
files without a repository" concept lands they have no Git at all and nothing
changes here.

No fetch runs during capture: the backup has no network and no credentials. A
remote-tracking ref that is behind the real remote only makes the packfile larger.
A remote-tracking ref that is ahead of the real remote, because the remote was
force-pushed or deleted after the last fetch, is the one case that loses
history; restore detects it through the recorded prerequisites and reports it.

Restore, per remote-dependent repository, after the master password has unlocked
the secret store so the code host connection credentials are usable:

1. Restore `.git` without objects and the working files from the snapshot. Move
   the restored `config` and `hooks` aside and write a sanitized `config` that
   contains only the remote URL from the manifest. Run every Git command below
   in the backup execution identity with `core.hooksPath` pointing at an empty
   directory, `GIT_CONFIG_NOSYSTEM` and an empty global config. Users and agents
   can edit `config` and `hooks`; `core.sshCommand`, `core.fsmonitor`,
   `credential.helper`, `url.*.insteadOf` or a `reference-transaction` hook
   would otherwise execute during restore or redirect the fetch credential.
2. `git fetch origin` through the restored connection, which refills
   `.git/objects` with everything reachable from the remote.
3. Check each prerequisite with `git cat-file -e`, then `git index-pack` the
   local-only packfile into `.git/objects`.
4. `git fsck --connectivity-only` and `git worktree repair`; rewrite absolute
   `gitdir` pointers in `.git` files and `worktrees/<name>/gitdir` entries if
   `VERITY_ROOT` moved. Only after `fsck` passes, put the original `config` and
   `hooks` back; they are user content, not restore input.

A repository whose rehydration fails, because the host is unreachable, the
connection is revoked, the repository was deleted or a prerequisite is missing,
stays in the suspended recovery state with a per-project "Code incomplete"
warning. Working files and the local-only packfile remain on disk, so nothing local is lost
and rehydration can be retried from the project screen after reconnecting the
code host. The restore summary lists rehydrated, pending and failed projects
separately and never counts a pending one as recovered.

### Later: selective profiles

Large original knowledge/library files are user data. Later per-project content
selections need size estimates and explicit omission warnings. Selective
database content needs a supported logical export/import with dependency
handling; do not remove rows from a dump. Metadata for omitted assets must be
restored as explicitly unavailable.

## Encryption and key ownership

Generate a cryptographically random 256-bit recovery key locally as the private
half of an asymmetric recipient pair (X25519 or an equivalent reviewed scheme,
`age`-style). Store only the public recipient key on the host. Objects and
manifests use independently generated random keys wrapped to that recipient.
Scheduled capture works with a sealed secret store. Historical decryption still
requires the private key; a compromised host can read current source data and
its local deduplication index. Verification requires a restore probe with the
private key. Rotation starts a new repository generation; retain older private
keys for older snapshots.

Recovery kit: key as text with checksum and as QR code, printable. Setup requires
a successful re-entry check. Restore accepts QR scan, clipboard paste and typed
entry with checksum validation. Recommend a password manager plus an independent
offline copy. A Uplink login authorizes downloading ciphertext; it never
substitutes for the key. Losing every copy makes the backups unrecoverable by us.

Do not offer master-password or separate passphrase decryption, password-derived
key envelopes or an account recovery bypass.

Inner secret encryption is separate from archive encryption and stays
untouched. The archive carries the database as it is: encrypted secret columns,
the stored scrypt salt and the password verifier. No derived secret key is
exported into the archive, and the self-update key export is not used as a
backup API. After restore the user unlocks the secret store with the master
password that was current at capture time, through the existing unlock route,
exactly as after a server restart. This needs no new rekeying capability, keeps
the password-strength concern out of the archive (the recovery key already
blocks offline guessing), and lets a sealed server produce a complete backup
because capture only copies ciphertext. The restore flow must say clearly that
stored credentials stay locked until the master password is entered, and that a
forgotten master password leaves those credentials unrecoverable even with a
valid archive and recovery key.

No keys in arguments, logs, diagnostics or hosted metadata. Stream encryption and
avoid plaintext archive staging; the database dump streams through the encryptor
rather than landing on disk.

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
restricted local index mapping content fingerprints to random opaque object IDs.
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
An export carries the same content as its snapshot. A remote-dependent code
project therefore still needs its code host after an export restore; the export
dialog offers "include pushed history", which adds that project's full
`.git/objects` to this export only and shows the size difference. The UI
distinguishes incremental repository backups from full portable downloads and
reports scanned bytes, new ciphertext bytes and total retained storage.

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

## Consistent capture

1. Inventory scope, data locations, capacity and uncovered storage before work;
   write the warnings into the manifest up front.
2. Acquire the lifecycle lock: refuse provision, deprovision, sleep, wake, mount
   changes and project deletion during local capture, not remote upload. Turns, edits and commits keep
   running. There is no global drain.
3. Take one transaction-consistent logical PostgreSQL snapshot (repeatable-read
   deterministically segmented logical export through the read-only backup role). Record its timestamp.
4. Copy worktrees and knowledge folders live, streaming through the encryptor,
   skipping `.git/objects` for repositories with a remote and writing their
   local-only packfile instead. Record the copy window and the turns active in it.
5. Release the lock on every exit path; never wake a sleeping project to copy
   its files. Commit the snapshot only after the destination has
   durably acknowledged every referenced object and the encrypted manifest.

Live copies are not atomic filesystem snapshots. Detect file changes before and
after capture, retry within bounds and flag unstable paths or incomplete projects.
Git validation cannot reconstruct missing objects or prove application-file
consistency; restore repairs what it can and reports what it cannot. Docker pause is not used. Cancellation, interrupted upload
and a full disk never replace the last good backup. Record omissions and failures
without leaking sensitive paths.

## Backup before server updates

The promoted Server runs forward-only schema migrations when it starts
(`packages/server/src/server-main.ts:361`), so the moment before activation is
the one point where a snapshot is the only rollback for data, not just for code.
The Updater already sequences an update through journaled phases
(`packages/server/src/self-update/update-journal.ts:10`) and talks to the Server
over the private control socket. The hook adds two requests to that sequence:

1. After `preflight`, before `creating-standby`: request a full incremental
   snapshot while the old Server serves normally. It transfers the delta since
   the last scheduled run and warms the destination.
2. After `quiescing-old`, before `handing-off-key`: request a final incremental
   snapshot. No turn writes anymore, so it captures the exact pre-migration state
   and transfers seconds of change. The Updater continues only after the
   destination has durably acknowledged this snapshot, not after local capture,
   because it is the rollback point. This extends the quiesced window by the
   upload of that delta; the warm pass keeps it short, and the update status
   shows the wait as its own phase.

Both snapshots use the ordinary capture path: incremental, encrypted to the
public recovery key, no secret needed for host-path and NAS destinations. For a
Drive destination the pass runs only if the secret store is unlocked; otherwise
the Updater records that the pre-update snapshot went to the local spool and the
update is treated as "backed up locally only". The final snapshot is tagged
`pre-update` with previous and target digest, and retention keeps at least the
last two pre-update snapshots regardless of the schedule's policy.

A snapshot that fails or exceeds its timeout aborts the update in a phase that
has not touched data. With no destination configured the update runs and the
update history (#1045) shows it ran without a backup; the administrator setting
"require a backup before updates" turns that into a refusal with a clear reason.
Only a snapshot durably committed at a configured destination satisfies that
setting; "backed up locally only" through the Drive spool does not, and the
refusal names the destination that blocked.
Rollback of a committed update that went wrong is the installer's restore path
fed with the pre-update snapshot; the Updater's own rollback phases stay the
first line because they only switch containers.

## Execution identity

First release: capture runs inside the server process with bounded memory and a
dedicated read-only PostgreSQL role. The server already holds the Docker socket
and can read every byte; a separate worker would add a trust boundary and a
coordination protocol without removing that. Keep the capture interface free of
server internals so it can move behind the Docker policy gateway later. Full
backup creation, download, deletion and policy changes are administrator-only,
enforced server-side on every request including resumed downloads.

## Destinations, delivery and retention

Server-side destinations are the default and the only path for scheduled
backups: a configured local path such as a mounted NAS, a user-controlled object
store, Google Drive, or Premium Uplink. Large archives are not pulled through a phone.

App download is the convenience path for manual exports on small instances:
temporary encrypted server copy, progress in the app, resumable ciphertext
download straight to a file, hand-off to the platform save/share flow,
administrator-authenticated and bound to one immutable archive. Show server-copy
expiry, offer deletion, and distinguish an on-server copy from an independent
off-host copy. A finished download proves neither a durable copy nor a restore.

Threat model for destinations: a ransomed or compromised host must not be able
to erase its own backup history. Premium enforces server-side minimum retention
and delete protection independent of any credential on the host; archives belong
to the account, so a fresh deployment under the same account can list and
download them without approval from the lost installation. For user-controlled
destinations, document that a host-writable share offers no such protection, and
support append-only or write-only credentials and target-side snapshots where
available.

Google Drive uses resumable object uploads in a dedicated administrator-owned
backup folder. Its integration token requires the live secret store to be
unlocked: sealed capture may queue encrypted objects locally, but Drive delivery
waits for unlock and must report pending status and spool capacity. Ordinary
Drive access provides no host-independent deletion protection. Fresh-host recovery
uses a separately downloaded portable bundle or a repository copied with all
referenced objects; it must not depend on credentials inside the lost database.
A NAS adapter uses an explicitly mounted path and checks destination identity
before writing, so an absent mount cannot silently become a local backup.

## Installer recovery

Provide "New installation" and "Restore encrypted backup" through both interactive
installer and CLI. Recovery from local media works without Uplink or a
subscription. Hosted download requires account authorization, then local
decryption with the recovery kit.

The manifest names the release and schema version (`SERVER_COMPAT`) the archive
came from. The installer pins that release, restores into staging volumes,
validates (archive authentication, safe paths and links, size limits, scope,
version compatibility, worktree repair), then moves forward through the normal
self-update path. Refuse archives the installer cannot run and unsupported
downgrades. On a host with an existing installation, staging doubles the
PostgreSQL and data volume footprint; check free space first and say so.
Retain the existing installation for rollback until acceptance.

The installer regenerates host-specific state instead of restoring it:
`/etc/verity` state and updater token, the host runtime under
`/var/lib/verity/host-runtime`, image pins and gVisor configuration from the
pinned release, TLS and pairing material, deployment identity. Only application
state travels in the archive. Use a fresh deployment identity and require device
pairing and Uplink re-enrollment. Preserve durable users, project roles and
integration credentials, but do not reactivate old device tokens, capability
generations, preview links, enrollment recovery records or runnable jobs.
Reconcile external revocations before enabling remote access. Report integration
credentials that need validation or reconnection, including the provider logins
lost with the gateway state volume.

Restore projects in a suspended recovery state with their recorded desired state.
After the master password unlocks the secret store, rehydrate remote-dependent
repositories from GitHub or Forgejo as described under "Git history and code
hosts"; projects whose rehydration failed stay suspended and flagged. Provision
containers fresh and only after compatibility, mounts, access and rehydration are
verified and the user resumes them. Sleeping and paused projects remain inactive.
Sessions and unsaved files survive; process memory, terminals and connections do
not. Mark turns that were active during capture as interrupted and never replay
queued work automatically. Same-identity migration is a later explicit mode that
must fence the old installation.

## Storage and delivery boundaries

Core owns capture, encryption, manifest, local destinations, restore and an open
resumable ciphertext upload/download contract. The Premium service owns storage,
authentication/entitlement, account ownership of archives, host-independent
retention, quotas and billing; it is outside this repository (`AGENTS.md`,
Product boundary). Recovery key ownership stays local.

Start with incremental repositories and self-contained portable exports. Prove
reference tracking, atomic publication, retention, index recovery and restore
before presenting the first release as reliable. Show
last completed backup, last restore verification, actual scope and actionable
failures in settings.

## Acceptance and implementation sequence

1. Inventory persistence; introduce the exclusion list, the Git local-only
   packfile, the versioned manifest and incremental repository export, the
   recovery kit with public recipient key, the lifecycle lock, the host-path and
   mounted-NAS destination, the schedule, and the pre-update hook in the
   Updater. The outcome of this step is an installation that backs itself up
   unattended and before every update.
2. Implement staging restore in the installer with release pinning, code host
   rehydration, worktree repair and the restore probe script; prove complete
   round trips on a fresh host, with and without a reachable code host, before
   presenting backups as reliable.
3. Add app download, Google Drive delivery with the unlock-dependent spool, and
   Premium ciphertext storage in its separate service using the same format and
   account ownership.
4. Add selective content profiles, export adapters for in-container services and
   additional database capture optimizations later.

Verification covers active/sleeping/paused projects, all worktrees and local-only
Git history rehydrated against GitHub and against Forgejo, repositories without
a remote restored offline, unreachable and revoked code hosts, deleted
repositories and rewritten history, knowledge originals/revisions, settings and
usable integration secrets after master-password unlock. For updates, prove that
the final snapshot is taken after quiescing and before the candidate migrates,
that a failed snapshot aborts before the key hand-off, that the default records
an unbacked update, and that "require backup" refuses an update whose snapshot
only reached the local spool. Verify fresh-host restore with archive, recovery
key and master password; wrong keys, tampering, truncation, malicious archive
paths, sealed secrets, full disk, interrupted capture/upload, unsupported
versions, revoked device access and repositories copied mid-write must fail
safely or be repaired and reported. The restore probe runs in CI on a fixture
archive and is schedulable on the host; a backup with no passing probe is shown
as unverified. Deliberately break each guard before trusting it. Never claim full
recovery for a partial archive or revive old authorization or runtime state.

Incremental acceptance additionally requires two snapshots after a small file
edit to share unchanged objects, efficient database row-change cases, insertion
without whole-file retransmission, old-snapshot restore after source deletion,
index-loss recovery, key rotation across generations, concurrent prune/upload,
missing objects, interrupted commit publication and retention of shared objects.
Measure transfer and retained storage, not just snapshot count. Destroy the local
index and original host in the fresh-host recovery test; only the destination,
private recovery key, subsequent master-password unlock and, for remote-dependent
code projects, the code host may be required.
