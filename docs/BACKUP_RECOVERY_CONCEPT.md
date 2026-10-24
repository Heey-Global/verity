# Encrypted backup and recovery concept

Status: supporting implementation proposal, not implemented. Architecture decisions
are recorded in [ADR 0025](adr/0025-encrypted-backup-and-installer-recovery.md);
where the two disagree, the ADR wins and this document is corrected.
Selected recovery policy: one recovery key per installation, held only by the
user. Scope: self-hosted Core backup and recovery to a host directory, with
Premium Uplink as the later off-site destination.

## Product behavior

Verity backs up a whole installation automatically: settings, projects,
sessions, knowledge and the code in every workspace. A backup runs every six
hours and right before every server update. Each run produces a snapshot in an
encrypted, incremental repository; after the first full run, a snapshot stores
only what changed.

Version one has one destination: a directory on the Verity host. Premium Uplink
follows as the managed off-site destination. Encryption happens on the host
before a byte is written; only the user's recovery key opens a snapshot, and
Verity keeps no copy of it.

The protection level is stated plainly, in the app and in this document:

- A backup on the host protects against a failed update, against mistakes such
  as a deleted project or an overwritten file, and against partial data loss.
- It does not protect against loss of the host disk or the whole machine.
- To survive that, the administrator copies the backup directory to another
  machine or medium, for example with `rsync` of the encrypted repository (see
  "Host-path destination"), or uses Premium Uplink once available.

Restore is a host operation: the installer restores a fresh host or rolls back
a failed update on the same host. The app offers the smaller operations: restore
a single project as a new project, download a single file, and test that a
backup can be restored.

TLS remains required in addition to backup encryption. Uplink never receives
plaintext data or recovery keys. Backups do not protect data a compromised host
can read at capture time.

## Current evidence

- Production requires PostgreSQL: `packages/server/src/server-main.ts:532`.
  The PGlite archives in `packages/store/src/knowledge-backup.test.ts` are test
  coverage, not a product backup implementation.
- Database state includes sessions, projects, settings, credentials and device
  tokens (`packages/store/src/schema.ts`: `SessionsTable` at `:25`,
  `ProjectsTable` at `:336`, `VeritySettingsTable` at `:522`,
  `SecretKeyMetaTable` at `:625`, `AuthTokenTable` at `:640`).
- Project clones and session worktrees live on the `verity-data` volume under
  `VERITY_ROOT/workspaces` and `VERITY_ROOT/sessions`
  (`packages/server/src/server-main.ts:844`, `:891`). Knowledge has its own
  filesystem state (`packages/server/src/knowledge-folder.ts:24`) mounted into
  sandboxes (`packages/server/src/knowledge-folder.ts:218`).
- Managed `node_modules` volumes are created per project
  (`packages/server/src/provisioner.ts:1014`); devcontainers can declare their
  own mounts.
- Secret columns have inner encryption; the derived key is held in memory only
  and exported solely for the self-update hand-off
  (`packages/store/src/crypto.ts:76`). The server offers init and unlock only
  (`packages/server/src/secret-lifecycle-routes.ts:67`); there is no password
  change or rekey.
- Code host credentials reach Git as an in-memory `http.extraheader`, never in
  `.git/config` (`packages/server/src/provisioner.ts:35`).
- The server holds the raw Docker socket (`deploy/docker-compose.yml`); ADR 0017
  plans the policy gateway.
- Installer state and deployment identity live under `/etc/verity`
  (`deploy/bin/verity-install:22`, `:24`), including the pairing identity key,
  the TLS key, certificate and CA. The server container mounts that directory
  read-only at `/run/verity-pairing` (`deploy/docker-compose.yml`, server
  `volumes`). Persistent volumes are declared at the end of
  `deploy/docker-compose.yml` (`verity-db`, `verity-data`,
  `verity-agent-gateway-state`, control-socket volumes).
- The promoted Server runs forward-only migrations on start
  (`packages/server/src/server-main.ts:361`). Update phases are journaled in
  `packages/server/src/self-update/update-journal.ts`, with `preflight`
  followed by `creating-standby`; see
  [ADR 0008](adr/0008-verity-server-self-update.md).
- Release and schema compatibility is expressed as `SERVER_COMPAT`
  (`packages/server/src/self-update/compat.ts`).
- Push delivery exists (`packages/server/src/push-sender.ts:314`).
- Enrollment recovery records explicitly do not support backup restore:
  `docs/protocols/uplink-enrollment-storage-v1.md:120`.
- Smoke-script pattern for a restore probe: `deploy/bin/verity-clean-install-smoke`.

## User journeys

The app screens are mocked up in [`docs/assets/backup/`](assets/backup/)
(`mockup.html` is the source; the PNG files are its renders). The user-facing
term is always "recovery key"; there is no separate "kit". The mockups show
the main path and are not complete: the recovery key entry and the
compromised-host note before a restore test (screen 10), the paired-device
review after a restore (before screen 12), including devices that must pair
again because they were paired after the snapshot, and the length of a real recovery key
(screen 2 shows a shortened sample) are specified here but not drawn yet.

### Set up

1. Settings, group "Server", row "Backup" (screen 0).
2. Explain: what is backed up, every six hours and before updates, encrypted,
   stored on this server, and that a broken disk needs a copy elsewhere
   (screen 1).
3. Recovery key, shown once (screen 2). Copy (to a password manager on the
   same phone), Save (to a file through the platform save dialog) and Print.
   "Show QR code for another device" is optional, for keeping the key on a
   second device. Verity keeps no copy.
4. Confirm: paste the key back once, so the saved copy is known to be correct
   (screen 3). Only then are backups turned on.
5. Success; the first full run starts and shows progress and an estimate
   (screen 4). The user can keep working.

An abandoned setup discards the generated keys; nothing has been encrypted to
them yet, so the next attempt starts over with a new key.

### Everyday use

- Status (screen 5): last backup, next backup, restore test, then "Back up now"
  and "Test restore", then snapshots and options.
- Snapshots (screen 6): grouped by day, showing the time; snapshots taken before
  an update show the version change.
- Per snapshot (screen 7): restore a project as a new project, get a single
  file, or delete the snapshot. Restore operations ask for the recovery key for
  that operation only.
- Problem (screen 8): a push notification and a status card with the reason and
  one primary action.
- Update waiting for a backup (screen 9): see "Backup before server updates".
- Test restore (screen 10): see "Restore probe".
- Options (screen 11): schedule, "Updates wait for a backup", "Replace recovery
  key", "Pause backups" (snapshots are kept), "Delete all backups".

"Back up now" starts a run outside the schedule; it does not shift the schedule.

### Lost or replaced recovery key

"Replace recovery key" generates a new key, shows it once and asks for the
confirmation paste, as in setup. It starts a new repository with a full first
run (see "Format and key lifecycle"). Snapshots in the old repository still need
the old key; the snapshot list shows which key each snapshot needs, and the old
repository expires under normal retention. Before it starts, the flow warns that
the old key is still needed for those snapshots, including the pre-update
snapshots a rollback would use, and names the date until which to keep it.

A user who has lost the key while the server still runs replaces it at once. The
old snapshots stay unreadable; they are not deleted early, in case the key turns
up again.

### Fresh-host restore

1. Copy the backup directory to the new host, or attach the medium holding it.
2. Install Verity on the new host and run
   `sudo verity-install --restore <directory>` over SSH (screen 13).
3. The installer offers the newest snapshot; Enter accepts it, `list` shows the
   others.
4. Paste the recovery key at the prompt.
5. The installer restores data and identity, starts the release the snapshot
   was taken with, and reports that devices reconnect by themselves.
6. The phone reconnects without pairing. The app shows "Server restored, still
   paired" and asks for the master password (screen 12), as after any restart.
7. Projects come back suspended; the user resumes them one by one.

### Same-host rollback

After an update that broke the installation, `sudo verity-install --rollback`
offers the newest pre-update snapshot, states that later changes are lost, asks
for the recovery key and restores (screen 14). Automatic updates stay paused
until the user resumes them in the app.

### Pause and delete

"Pause backups" stops the schedule and the pre-update snapshot and keeps every
snapshot. "Delete all backups" removes the repository after a typed
confirmation. See "Deletion and shutdown".

### Screen list

| # | Screen | Purpose |
| --- | --- | --- |
| 0 | Settings | Entry row "Backup" with last backup time |
| 1 | Explain | What is covered, what is not |
| 2 | Recovery key | Show once; copy, save, print, optional QR |
| 3 | Confirm | Paste once to prove the saved copy |
| 4 | Success | Backups on, first run in progress |
| 5 | Status | Last, next, restore test, actions |
| 6 | Snapshots | List by day, pre-update marked |
| 7 | Snapshot sheet | Restore project, get file, delete |
| 8 | Problem | Alert reason and one action |
| 9 | Update waiting | Retry backup or update anyway |
| 10 | Test restore | Result of the last probe |
| 11 | Options | Schedule, update gate, key, pause, delete |
| 12 | After restore | Still paired, master password unlock |
| 13 | Installer restore | Fresh host from a backup directory |
| 14 | Installer rollback | Back to the pre-update snapshot |

## Backup scope

Every snapshot includes:

- the complete application database: settings, projects, memberships, sessions,
  histories, permissions, attachments, knowledge revisions, device tokens,
  backup policy, and stored credentials in their encrypted form;
- everything under `VERITY_ROOT/workspaces`, `VERITY_ROOT/sessions` and the
  knowledge folders: working files, untracked and ignored user files such as
  `.env`, and each Git repository complete with its objects (see "Git
  repositories");
- the deployment identity (see "Identity in snapshots"); the installation id
  is never part of it;
- the manifest: scope, per-project lifecycle state, the server release and
  schema version (`SERVER_COMPAT`), capture timestamps, excluded paths with
  counts and sizes, per-project captured size, and every warning below.

Active, sleeping, paused and retained deprovisioned projects are all included;
sleeping projects are not woken. Knowledge folders hold Sources and Documents
that exist nowhere else and are always included in full. Phone-only preferences
are outside a server backup.

### Exclusion list

Exclusions are one fixed, source-controlled list, reviewed like a schema change.
Initial entries:

- dependency and cache directories regenerated from included sources:
  `node_modules`, `.venv`, `target`, `.next/cache`, `__pycache__`, `.gradle`,
  `.turbo`, `.cache` under a workspace root (final list at implementation);
- managed dependency volumes created by the provisioner;
- Docker images, build caches and anonymous volumes;
- control sockets and the short-lived materialized files under
  `VERITY_ROOT/secrets`;
- Verity's own backup state (`VERITY_ROOT/backup-state`) and capture staging
  (`VERITY_ROOT/capture`).

Every skipped path appears in the manifest with its size. Nothing outside the
list is excluded, and version one has no user-defined exclusions. Rebuilding
dependencies may need credentials and network access; restore reports what it
could not rebuild.

### Not included, warned per project

- Writable container layers. ADR 0020 keeps them as reusable cache with a full
  provisioning fallback; restore always provisions fresh containers. Persistent
  state belongs in the worktree or the devcontainer definition.
- Services inside project containers (databases, queues) and custom mounts
  outside `VERITY_ROOT`. The manifest names project and mount; the status shows
  "Verity state complete, in-container services not covered" for that project.
- The agent gateway state volume with spilled provider tokens. Restore asks for
  a fresh Claude and Codex sign-in.

### Size visibility

The status shows the captured size per project and warns when a project
exceeds 2 GB, naming the largest directories, so a user can move generated
data out of the workspace or add it to the project's ignore rules and its build.
There is no per-project exclusion setting in version one.

## Encryption and key ownership

### Recovery key

At setup the server generates a random 256-bit private key of an asymmetric
recipient pair (X25519 in the style of `age`, or an equivalent reviewed scheme)
and a manifest signing pair (Ed25519). The recovery key the user receives is
one encoded string with a checksum that carries the private recipient key and
the public verification key. The server shows it once and then discards the
private recipient key.

What the host keeps, in `VERITY_ROOT/backup-state/`, readable only by the
server process and never part of a snapshot:

- the public recipient key, treated as confidential host state and never
  written into a repository, a manifest or hosted metadata;
- the private signing key;
- the fingerprint key and the local deduplication index.

If `backup-state/` is lost, for example on a damaged data volume, the server
cannot sign or encrypt new snapshots. It raises the "backup needs attention"
alert and offers two ways out: enter the recovery key once to recover the keys
from the repository, or replace the recovery key, which starts a new
repository.

None of these decrypts a snapshot. Scheduled capture therefore works with a
sealed secret store and after an unattended restart. A compromised host can
read current data and forge new snapshots, which is the accepted host-compromise
case. It cannot open snapshots already written as long as nobody enters the
recovery key on it. With the fingerprint key and the index it can, however,
test whether a known chunk of content is present in the repository; that is an
accepted risk of host-side deduplication.

The recovery key is entered on the host for explicit operations only: restore,
rollback, the restore probe and partial restore. The server holds it in memory
for that operation and never stores it, but a compromised host can capture it
at that moment and then decrypt every snapshot made with it, including
off-host copies. The app says so where it asks for the key.

After a suspected compromise, the host's own snapshots are not trustworthy: the
attacker held the signing key and could forge or delete manifests. Restore onto
a clean host from an off-host copy made before the compromise, with
`--new-identity`, so neither forged database state nor old device tokens come
back, and replace the recovery key there.

The recovery key protects more than snapshot contents. Snapshots carry device
tokens and the TLS identity, and the backup directory carries the CA key, so the
directory plus the key is enough to stand up a host that paired devices accept.
Setup says the key "opens your backups and can restore this server".

After a recovery key leaks, replacing it is not enough, because every existing
snapshot and the old CA key file still carry the live identity. The response
is:

1. "Replace recovery key" with the reason "the old key was exposed". This
   deletes the old generation's CA key file at once instead of at expiry.
2. `sudo verity-install --rotate-identity` on the live host: a new CA, TLS and
   pairing identity, all device tokens revoked, every device pairs again. The
   identity in old snapshots and in off-host copies is then worthless.
3. Use `--new-identity` for any later restore from a snapshot taken before the
   rotation.

Restore accepts the recovery key by clipboard paste, QR scan in the app, or
typed entry with checksum validation; paste over SSH is the installer path.
Recommend a password manager plus an independent offline copy. A Uplink login
authorizes downloading ciphertext; it never substitutes for the key. Losing
every copy makes the backups unrecoverable by anyone.

Do not offer master-password or separate passphrase decryption, password-derived
key envelopes or an account recovery bypass.

### Encryption and signatures

Use a maintained, reviewed authenticated streaming-encryption construction for
objects and manifests, with per-chunk ordering, an explicit end-of-stream marker
and completeness checks, so truncation, reordering and splicing are detected
before any byte is acted on. Each object and manifest gets a fresh random data
key wrapped to the public recipient. Encrypt project names, file names and
detailed metadata, not only content; the directory still reveals sizes, counts
and timing.

Recipient encryption alone does not authenticate the writer: anyone with the
public recipient key could mint objects that decrypt cleanly. Every manifest is
therefore signed. The signature covers the entire manifest, every object
reference with its opaque ID, ciphertext digest and length, the repository
identity, the format version and the snapshot sequence number, and it is
verified before any manifest field is used. Restore refuses an unsigned or
wrongly signed manifest.

A copy of the private signing key, encrypted to the recipient, is stored in the
repository. A restore holds the private recovery key at that moment, so it
recovers the signing key, checks that its public half equals the verification
key inside the recovery key, derives the public recipient key, and installs
both on the restored host. The restored host then keeps writing snapshots that
the same recovery key opens and verifies. A signing key that fails the check is
reported; the restored host then generates fresh keys and asks the user to
replace the recovery key.

Bound the resources every parser may consume (manifest size, path count and
length, link depth, object count) and validate every path against the staging
root before writing. Symlinks are restored as links with their recorded target,
whatever it is, and restore never follows a link while writing, so a link
cannot redirect a write; nothing is dropped for pointing outside the tree. No keys in arguments, logs, diagnostics or hosted
metadata. Stream encryption; the database export streams through the encryptor
rather than landing on disk.

### Inner secret store unchanged

Inner secret encryption stays as it is. A snapshot carries the database with its
encrypted secret columns, the stored scrypt salt and the password verifier. No
derived secret key is exported, and the self-update key export is not used. After
restore the user unlocks the secret store with the master password that was
current at capture time, through the existing unlock route, as after a restart.

This needs no new rekeying capability and lets a sealed server produce a
complete backup, because capture only copies ciphertext. The restore flow says
that stored credentials stay locked until the master password is entered, and
that a forgotten master password leaves them unrecoverable even with a valid
snapshot and recovery key.

### Format and key lifecycle

- Every manifest carries a format version. Every format version gets a fixture
  repository in the test suite, and restore keeps reading every format it ever
  wrote.
- A repository is never rewritten in place. A new format version or a replaced
  recovery key starts a new repository with a full first run. The old repository
  receives no new snapshots and expires under the normal retention rules; it is
  removed when its last snapshot expires.
- The snapshot list shows which recovery key generation a snapshot needs, so a
  user who replaced the key knows how long to keep the old one.
- One recovery key per installation, issued once at setup or replacement. The
  envelope format allows more than one recipient, so several keys per
  installation can follow later without a format change.

## Repository format

### Incremental repository

Incremental transfer and storage are first-release requirements. The first
snapshot writes all included content; later snapshots reuse unchanged encrypted
objects and write only new objects and a manifest. Each snapshot describes its
complete logical state and references objects directly, without replaying
earlier snapshots.

Use content-defined chunking so an insertion does not shift every later chunk
boundary. Deduplicate before encryption, within one repository only. Never use
plaintext hashes as object names, derive keys from content, or use deterministic
encryption. The host-local index maps keyed fingerprints (HMAC under a random
per-repository key) to random opaque object IDs. A copy of the fingerprint key,
encrypted to the recipient, is stored in the repository so the index can be
rebuilt.

The index is a cache, not restore authority. After index loss the next run
either rebuilds it, which needs the recovery key entered for that purpose, or
starts a new repository with a full first run; the private key is never kept on
the host for unattended deduplication.

### Installation-owned repositories

Each installation writes only to its own repository. An installation id is a
random value the installer writes to `/etc/verity/installation-id` on every
fresh install and every fresh-host restore; it is never restored from a backup.
Two counters are kept apart. The key generation counts recovery keys of an
installation and changes only when the key is replaced. The repository number
counts repositories of an installation and changes with every new repository,
whether caused by a key replacement, a format change or an index rebuilt by a
full first run. The repository directory is named `<installationId>-r<n>`, and
its signed header records installation id, repository number, key generation
and format version.

An installation publishes into and prunes only repositories that carry its own
installation id. A host restored on new hardware gets a new installation id and
opens a new repository beside the old one. It reads the old repository for the
restore and never writes or prunes it; the old repository ages out only if the
original host, still running, prunes it, or when an administrator deletes it.
Two hosts restored from the same backup therefore never damage each other's
history; at worst they both use storage. A same-host rollback keeps the
installation id and continues the installation's current repository.

The next sequence number comes from a high-water mark file in the repository,
advanced under the repository lock before each publish and never lowered, so a
deleted snapshot's number is never reused. It is never taken from host state
that a restore or rollback could have reset.

### Publication, retention and garbage collection

Write immutable objects first and the immutable snapshot commit last, after
every referenced object is durably written and fsynced. Verify stored ciphertext
lengths and digests. A partial run never replaces a committed snapshot; missing
or corrupt objects make a snapshot incomplete and trigger re-upload when the
source is available.

Retention (see "Operations") removes snapshots first. Garbage collection removes
an object only when no retained snapshot references it, no running capture,
restore or probe holds a lease on it, and a grace period has passed. Publication
and pruning are serialized by an `flock` on the repository lock file. Garbage
collection removes an object's index entry under that lock before it deletes the
object, and a run re-checks under the lock, before publishing, that every
object its manifest references still exists, so a published snapshot never
references a deleted object. Reference tracking and deletion must survive
crashes.

The host cannot decrypt manifests, so it cannot read references back from them.
At publish time the server records each snapshot's set of object IDs in
`VERITY_ROOT/backup-state/`, fsynced before the manifest is published. Garbage
collection works from those sets, which live only in `backup-state/` and never
in the database, so a rollback keeps them. It fails closed per repository: if
the set of any retained snapshot in a repository is missing or incomplete, it
deletes no object of that repository and raises the "backup needs attention"
status naming it. A retired repository with lost sets is not collected object by
object; it is removed whole when its last snapshot expires, without an alert. Rebuilding the sets needs the recovery key, entered
for that purpose, or a new repository with a full first run.

## Consistent capture

### Run steps

1. Inventory scope, data locations and capacity: the expected new bytes in the
   repository plus the local staging size of every repository's `.git`. Write
   the warnings into the manifest up front. A run that cannot fit fails before
   it starts.
2. Acquire the lifecycle lock. It refuses provision, deprovision, sleep, wake,
   mount changes and project deletion. Turns, edits and commits keep running;
   there is no global drain.
3. Under the lock, open the repeatable-read database transaction (see "Database
   export") and run its first statement, which is when PostgreSQL takes the
   snapshot; record its timestamp. Then freeze every Git repository (see "Git
   repositories"). Database state and frozen `.git` copies therefore see the
   same set of projects and mounts.
4. Release the lock. The lock is held only for steps 2 and 3, not while the
   export streams or files are copied, chunked or written. Stream the database
   export from the open transaction and commit it as soon as the export is
   written, before any file work, so the transaction never stays open for the
   rest of the run and holds back vacuum. Then copy working files and knowledge
   folders live, through the encryptor, with the no-follow traversal described
   under "Git capture", storing symlinks as links. `.git` directories are
   skipped here; they come only from the frozen copies. A project being copied
   holds a per-project lease, so its deletion waits for that copy.
5. Chunk, encrypt and write the frozen Git copies, then publish the manifest.
6. Release leases and remove capture staging on every exit path.

Record the database time, the file-copy window and every turn active in it.
Restore marks those turns interrupted and never replays them. Live copies are
not atomic filesystem snapshots: detect changes before and after each file,
retry within bounds and flag unstable paths. Docker pause is not used.
Cancellation, a timeout and a full disk never replace the last good snapshot.

### Database export

The server exports the database through its existing PostgreSQL client (`pg`),
not `pg_dump`, which the server image does not ship. One repeatable-read,
read-only transaction exports every table with `COPY ... TO STDOUT` in a fixed
table order and primary-key order, together with schema and migration metadata
and sequence state. Encodings for binary values, nulls and types are fixed and
versioned; tables without a stable key need an explicit ordering. The export is
chunked like any file, so unchanged leading rows deduplicate; there is no
promise beyond that in version one.

The export runs under a dedicated read-only role whose credential is provisioned
like the server's own `DATABASE_URL`, outside the secret store, so a sealed
server can capture. Restore imports through a supported transactional import
path into an empty database of the snapshot's schema version.

### Git repositories

In version one every repository is captured self-contained: its `.git`
complete with all objects, together with the working files. Nothing depends on
a code host at restore time. The cost is size: `git gc` rewrites packs, so a
large history is re-written after a repack even when nothing was committed. The
size per project is visible (see "Size visibility"); the optimization that
leaves pushed history on the code host is described under "Later:
remote-dependent repositories".

#### Git capture

No Git command the backup runs ever reads a sandbox-written `config` or
`hooks`. `.git` is writable from the sandbox, its `config` can name programs to
run, and no denylist of keys is complete (`core.alternateRefsCommand`,
`core.askPass`, `include.path` and `includeIf` are examples a list tends to
miss). Capture therefore first freezes each repository: it copies the whole
`.git`, objects included, into server-owned capture staging at
`VERITY_ROOT/capture/<runId>/<projectId>/<repoKey>/`, a directory no sandbox
mount contains.

`repoKey` is a random identifier Verity assigns the first time it sees a Git
directory and records in project state together with its path relative to
`VERITY_ROOT`. Identity comes from that bookkeeping, never from a marker file or
inode inside the sandbox-writable tree. Several repositories or submodules in
one project therefore never share staging. Each run has its own directory with
its own lock; the server sweeps, at startup, every run directory whose lock is
no longer held, and only those.

The freeze uses reflinks where the filesystem offers them and a plain copy
otherwise, never hardlinks. Traversal is fd-relative from the project root with
`openat2` and `RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS` (Linux 5.6 or newer; the
fallback is a per-component `openat(O_NOFOLLOW | O_DIRECTORY)` walk with an
`fstat` identity check). Every opened file is `fstat`ed and compared with its
directory entry before it is read. A symlink under `.git` is recorded as a
finding, not followed and not stored, so no snapshot can carry a link inside
`.git`; restore refuses any `.git` that contains one and takes the "not
validated" path without running Git. The `gitdir:` target of a `.git` file and the
`gitdir` and `commondir` entries under `worktrees/<name>` must resolve inside
the project's own workspace or session paths; otherwise the repository is
captured as plain files without running Git and flagged "not validated".

In the frozen copy:

- `config` is replaced by a sanitized file holding only
  `core.repositoryformatversion`, `core.bare`, `extensions.objectFormat` and
  `extensions.worktreeConfig`;
- the original `config`, every `config.worktree`, `hooks` and
  `objects/info/alternates` move to a sibling `user-files/` directory, out of
  Git's reach, and are stored in the snapshot as user content (encrypted like
  `.env`);
- `objects/pack/*.bitmap` is dropped; it is regenerable.

Every command then runs with `GIT_DIR` set to the frozen copy and reads nothing
from the live repository. The copy is live and not atomic: a `git gc` in the
sandbox can delete a pack after its refs were copied. Each frozen copy therefore
gets `git fsck --connectivity-only` before it is accepted, except one flagged
`alternates-dropped`, whose failure is expected and which skips the check and
the retry loop. Missing objects
trigger a re-freeze with bounded retries; after the last attempt the latest copy
is stored as plain files with an `unstable` flag. Repositories with unknown
extensions (for example `extensions.refStorage`) or out-of-project pointers are
stored as plain files and flagged "not validated".

An `objects/info/alternates` file is never honored; the provisioner does not
create shared clones. The repository is captured from its own objects and
flagged `alternates-dropped`, because the borrowed objects are missing. The
manifest records that the file existed.

Without reflinks (ext4) the freeze is a full byte copy of every `.git` under the
lifecycle lock; the status shows the lock duration per run, and acceptance
measures it on a large installation.

#### Git restore

1. Before any Git command, validate every `gitdir:` target and every
   `worktrees/<name>/gitdir` and `commondir` entry against the project's own
   restore paths, rewrite them for a moved `VERITY_ROOT`, and refuse any that
   point elsewhere. Validation resolves with `RESOLVE_NO_SYMLINKS` and requires
   every path component to be a real directory, so a restored symlink in the
   working tree cannot redirect a Git command that runs later.
2. Restore `.git` with its objects and the working files. Keep the user's
   `config`, every `config.worktree` and `hooks` in server-owned restore staging
   (`VERITY_ROOT/restore/<projectId>/<repoKey>/`), and write the sanitized
   `config` from capture.
3. Immediately before the first Git command, validate the pointers of step 1
   again on the restored tree, and refuse a working-tree `.git` entry that is a
   symlink. Then run `git fsck --connectivity-only` and `git worktree repair`.
   A failure is
   recorded and the project is marked "Code incomplete"; for an
   `alternates-dropped` repository it is the expected outcome.
4. After the last Git command of the restore, put the user's `config`,
   `config.worktree` files and `hooks` back from staging and remove the staging
   copy. Nothing in the restore executes them afterwards.

Repositories stored as "not validated" are restored as plain files without any
Git command; path and link validation still applies.

#### Git command hardening

Every Git command the backup or restore runs uses one hardened invocation as
defense in depth, in addition to the frozen copy:

- `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`,
  `GIT_TERMINAL_PROMPT=0`, `GIT_PAGER=cat`, `GIT_NO_REPLACE_OBJECTS=1`;
- command-line overrides `core.hooksPath` (empty directory),
  `core.fsmonitor=false`, `core.sshCommand=/bin/false`, `credential.helper=`,
  `core.askPass=/bin/false`, `core.alternateRefsCommand=`,
  `protocol.allow=never`, `gc.auto=0`, `maintenance.auto=false`,
  `core.commitGraph=false`, `core.multiPackIndex=false`,
  `pack.useBitmaps=false`;
- `safe.directory` set to the exact repository path, which Git 2.38 and newer
  honors from the command line.

Capture and restore hold no code host credential, and no command fetches. The
restore logic ships in the server image and the installer runs it inside the
pinned release's server image, so one Git version applies. The server image
checks at startup that its Git is at least 2.39, the version Debian bookworm
ships, which covers worktree-aware connectivity checks and `-c safe.directory`.

## Host-path destination

The destination is a host directory managed by the installer. The default is
`/var/lib/verity/backups`; `verity-install --backup-dir <path>` sets another one
at install time and changes it later. The installer bind-mounts it read-write
into the server container. The sealed deployment spec fixes the Server's mounts
today (`packages/server/src/self-update/deployment-spec.ts`), so admitting this
mount, and the writable request directory of the identity host helper below,
are deployment-spec changes in step 1a. The path is set on the host, not
from the phone; the app shows it read-only.

A directory that is a mount point of an external disk or a network share is
allowed; Verity treats it as a host path and does not manage the mount. At setup
the server writes a marker file `.verity-backup-target` holding a random target
id, recorded in backup state. Every run checks the marker before writing; a
missing or different marker, for example an unmounted disk under the same path,
fails the run instead of filling the host disk.

Every run checks free space against the inventory estimate and fails early with
the reason. The directory layout:

```text
<backup dir>/
  .verity-backup-target
  repositories/
    <installationId>-r<n>/
      header            signed repository header
      lock              flock target for publish and prune
      objects/          immutable encrypted objects
      snapshots/        immutable encrypted, signed manifests, named
                        <sequence>-<kind>, kind scheduled, manual or pre-update
      keys/             signing and fingerprint keys, encrypted to the recipient
  identity/             CA key per key generation, written by the host helper
  revocations/          signed device revocation entries
```

### Copying the directory off-host

Copying the directory to another machine is the supported way to survive a disk
loss in version one, for example a nightly `rsync -a` of the backup directory.
Objects and manifests are immutable and a manifest is written after its
objects, so a copy taken during a run at worst misses the newest snapshot or
contains objects no snapshot references yet. If `rsync` passed `objects/` before
a run wrote new objects and `snapshots/` after it, the copy holds a manifest
whose objects are missing; restore detects that and offers the newest complete
snapshot instead.

A copy with `--delete` mirrors pruning and, on a ransomed host, a deletion of
the history. Recommend a target that keeps its own snapshots, or a copy without
`--delete` with its own cleanup.

## Identity in snapshots

Devices stay paired across a restore because the installation's identity is
backed up. Two writers are needed, because the files under `/etc/verity` have
different owners (`deploy/bin/verity-pairing-material:95`, `:96`):

- Each run reads the files the server can read from its read-only mount of
  `/etc/verity`: `deployment-id`, `pairing-identity.pem`, `tls-key.pem`,
  `tls-cert.pem` and `tls-ca-cert.pem`. It stores them as a separate, encrypted
  manifest section of the snapshot.
- `tls-ca-key.pem` is root-only by design and stays unreadable to the server.
  The installer installs a host helper in the pattern of `verity-host-runtime`
  (a systemd path unit answering requests from a root-owned directory, ADR 0008
  Amendment 2). When backups are set up or the recovery key is replaced, the
  server writes the public recipient key into that request directory, which
  stays on the host. The helper encrypts the CA key to it and writes the result
  to `<backup dir>/identity/<installationId>-ca-key-k<keyGeneration>`; it does
  the same whenever the CA key changes. During setup and key replacement the
  server hands the recipient key to the helper only after the confirmation
  paste, so an abandoned replacement leaves no file behind.

  The server chooses the recipient key, so a compromised server could submit
  its own key and receive the CA key. That does not widen today's compromise
  case: the server holds the raw Docker socket, which is host-root-equivalent
  (`deploy/docker-compose.yml`, ADR 0017), so it can read the CA key anyway.
  When the Docker policy gateway removes that equivalence, the helper must stop
  trusting the server's choice and accept only a recipient key registered by
  root through the installer.

Nothing else from `/etc/verity` enters a backup; the updater token and the
PostgreSQL password stay host-specific. The encrypted CA key is not signed, because the
helper holds no signing key. Restore authenticates it instead by checking that
it matches the CA certificate in the signed snapshot. Each run checks that the
CA key file for the current generation exists. A run that cannot read an
identity file, or finds no CA key file, still completes and raises the
"identity missing" alert, because a restore from it would need pairing again.

A fresh-host restore always reinstates the identity, together with the device
tokens in the database, so devices reconnect without pairing. The flow asks no
question about it. `verity-install --restore <dir> --new-identity` is the
documented exception for a compromised source host: it generates a new
identity, revokes all device tokens locally, and requires pairing again. These
revocations are never written to the revocation journal, because the token ids
are shared with the source installation. Use it as well
for a trial restore while the original host keeps running, so two hosts never
answer with one identity.

Restore never revives preview links, capability generations, enrollment
recovery records or queued jobs. Whether a Uplink enrollment continues after
restore is verified in the Premium step; until then the restore summary notes
that Uplink may need re-enrollment.

### Device revocations across restore

Reinstating device tokens must not reauthorize a device that was revoked after
the snapshot, for example a lost phone. Every device revocation is therefore
also written, at the moment it happens, into `<backup dir>/revocations/`,
outside any snapshot. An entry names the installation id, the key generation,
a per-installation sequence number and the revoked token id, is encrypted to the
current recipient and signed with the current signing key; the sequence makes a
deleted entry visible as a gap.

A revocation that cannot be written, because the directory is unwritable,
unmarked or full, or backups are paused, stays queued in the database and is
retried; every backup run also writes any database revocation missing from the
journal. A queued revocation raises the "backup needs attention" status only
while backups are active. Without configured backups nothing is queued, because
there is no backup that could bring the token back. Each snapshot manifest also
records, signed, the highest journal sequence written so far, so restore
detects entries deleted before that snapshot.

Fresh-host restore and same-host rollback read every entry the entered recovery
key can open and verify, from every installation in the directory, and apply
them before the restored server starts; a token id unknown to the restored
database is a no-op, so applying a sibling installation's revocation is safe
and wanted. Entries written under a later key generation cannot be opened with
an older key; restore therefore accepts the newer recovery keys as well, for
reading the journal only, and asks for them when it finds such entries. Restore
reports entries it could not read and gaps in any installation's sequence.

A backup directory copy older than a revocation cannot know it either, and a
host-writable directory can lose entries. Every restore therefore ends with a
mandatory review: the first app screen lists all paired devices with a "Revoke"
action, and devices paired after the snapshot are reported as needing to pair
again. When the journal had unreadable entries or gaps, every device whose
revocation status cannot be proven is marked "unverified" and stays blocked
until the administrator keeps it explicitly. This review is the control for
entries deleted after the newest snapshot, which nothing else can detect.

## Operations

| Setting | Default |
| --- | --- |
| Schedule | Every 6 hours; configurable from hourly to daily |
| Retention | Every snapshot of the last 48 hours, then 7 daily, 4 weekly and 6 monthly |
| Pre-update retention | The last two pre-update snapshots, in addition |
| Run timeout | 6 hours |
| Garbage collection grace period | 24 hours |
| Priority | Low CPU and IO priority (`nice`, `ionice` class idle where available) |

- Catch-up: after downtime that skipped a scheduled run, one run starts shortly
  after the server is up, not one per missed slot.
- No overlapping runs. A scheduled run that is due while one is active is
  skipped and logged. The pre-update request cancels a running scheduled run
  and starts its own, with a one-hour timeout instead of the run timeout, so an
  update never waits for hours. The first full run is never cancelled: a
  pre-update request during it holds the update with "first backup still
  running".
- Objects written by a failed, cancelled or timed-out run stay in the index and
  are reused by the next run, so a large first run makes progress across
  attempts instead of starting over; garbage collection removes them only after
  the grace period if no snapshot ever references them.
- When the directory is unwritable, missing its marker or full, the run fails
  with the reason and retries with backoff (15 minutes, doubling up to the
  schedule interval). Failed runs never replace the last good snapshot.
- The lifecycle lock is held only while the database snapshot is opened and
  `.git` directories are frozen.
- The first full run shows progress and a time estimate in the app.
- The pair of repository number and sequence number is authoritative for
  order, for "newest" and for retention across all repositories of an
  installation; the sequence alone orders snapshots within one repository.
  The signed capture timestamp places snapshots into the daily, weekly and
  monthly retention buckets but never decides order. The installer selects
  snapshots as `<installationId>-r<n>/<sequence>` and warns about a snapshot timestamp in the future and about
  gaps in a repository's sequence.

## Alerting

Alerts use the existing push sender and also appear as a persistent status
entry on the backup screen until resolved:

- no committed snapshot for twice the schedule interval, or for 48 hours,
  whichever is reached first; not raised while backups are paused;
- two consecutive failed runs;
- destination unwritable, marker missing, or less free space than the next run
  needs;
- identity files unreadable;
- restore probe older than 90 days, or never run.

Each alert names the reason and one action, for example "Server disk is full.
Free some space or delete old snapshots."

## Backup before server updates

The promoted Server runs forward-only migrations when it starts, so the moment
before an update is the one point where only a backup can undo damage to data.
The Updater requests one snapshot over the Server-Updater control channel after
`preflight` and before `creating-standby`, while the old Server still serves
normally. The snapshot uses the ordinary capture path and works with a sealed
secret store. It is tagged `pre-update` with the previous and target release
and kept by the separate pre-update retention.

The gate:

- With backups configured, "Updates wait for a backup" is on by default. A
  failed or timed-out snapshot holds the update and the app shows the reason
  (screen 9).
- The administrator may choose "Update anyway". The update then runs and is
  recorded as unbacked in the update history. The administrator can also turn
  the setting off.
- Automatic updates never override the gate. A held automatic update waits and
  raises an alert.
- Without configured backups, or with backups paused, the update runs and the
  update history notes that no backup was taken.

The snapshot is taken while the old Server still serves, so changes made
between the snapshot and the switch to the new release are not in it. A
rollback loses them; the rollback prompt says so with the snapshot time. The
quiesced final snapshot that closes this window is a later hardening step (see
"Later: quiesced pre-update snapshot").

Rolling back an update uses the pre-update snapshot through the installer's
same-host rollback. The Updater's own rollback phases stay the first line,
because they switch containers without touching data.

## Restore

### Installer: fresh host

`verity-install --restore <directory>` restores an installation from a backup
directory on local media. It needs no Uplink account and no subscription.

1. Read the repositories in the directory. Manifests are encrypted, so before
   the key is entered the installer orders snapshots by the sequence number and
   kind in their file names and shows file modification times; after the key is
   entered it shows the signed values. With one repository, offer its newest
   snapshot; with several, list them and ask.
2. Read the snapshot's release from the signed manifest after the recovery key
   is entered, and check that the release has an image for this host's
   architecture. Abort before touching anything if it has none.
3. Verify signatures, then decrypt and authenticate every referenced object.
4. Restore into staging volumes: the database through the import path, the data
   volume with the Git restore steps above, and the identity.
5. Validate: paths and links, size limits, scope, version compatibility,
   worktree repair. Then write the new host state into a staging copy of
   `/etc/verity` and start the restored installation from staging, with the
   staging copy mounted where the server expects `/etc/verity`, so it boots
   with the restored identity and the new installation id. Once the
   administrator accepts it, the staging copy replaces the live directory in
   one rename and staging is promoted; until then the existing installation
   stays intact and can be started again. The new host state is a new
   installation id and regenerated host-specific state (updater token, PostgreSQL password, host
   runtime under `/var/lib/verity/host-runtime`, image pins and gVisor
   configuration), reinstate the CA key from `identity/` after checking it
   against the snapshot's CA certificate, apply the revocation journal, install
   the recovered backup keys, and start the snapshot's release. The installer
   runs as root and holds the recovery key at this point, so it also writes the
   CA key file for the new installation id into `identity/`; the restored host
   therefore never starts with "identity missing".

Refuse snapshots the installer cannot run and unsupported downgrades. On a host
with an existing installation, staging roughly doubles the database and data
footprint; check free space first and keep the existing installation until the
restore is accepted.

After the start, the secret store is sealed until the master password is
entered. Projects are restored suspended with their recorded lifecycle state;
containers are provisioned fresh only when the user resumes a project. Sessions
and files survive; process memory, terminals and connections do not. Turns that
were active during capture are marked interrupted, and queued work is never
replayed automatically. The restore summary lists integration credentials that
need reconnection, including the provider sign-ins lost with the gateway state.

Backups on the restored host are active and write into a new repository under
its new installation id, with the same recovery key, into the backup directory
configured for this host (`--backup-dir`, default `/var/lib/verity/backups`).
The installer adopts that directory's marker or writes a new one and records
the target id in the fresh `backup-state/`. When the restore source is
the host's own backup directory, the predecessor's repository stays beside the
new one and is never pruned automatically; the restore summary shows its size,
and `verity-install --delete-repository <installationId>` removes it after a
typed confirmation.

### Installer: same-host rollback

`verity-install --rollback` restores the database and the data volume from the
newest pre-update snapshot into the existing installation; `--rollback
--snapshot <installationId>-r<n>/<sequence>` selects another one. It finds pre-update snapshots by
the kind in their file names, asks for confirmation, stating the snapshot time
and that later changes are lost, then for the recovery key, and verifies the
signed manifest before it touches anything.

The installation id, the identity and the host-specific state stay as they are,
so everything stays paired, except devices paired after the snapshot, whose
tokens it does not contain; those pair again. The recovery key asked for is the one of the
snapshot's key generation; if the key was replaced since, the prompt names that
generation. `VERITY_ROOT/backup-state/` is not in the snapshot
and is carried over unchanged from the current data volume into staging, so the
host keeps its backup keys, index and target id. The installer runs the same
architecture check as above, restores into staging, applies the revocation
journal (see "Device revocations across restore") and every revocation recorded
in the live database it replaces, which covers entries written under a newer
key generation than the one entered. If that database cannot be read, the
rollback continues with the journal alone and the mandatory device review. It
then writes the automatic
update hold into the restored database before the swap, because the snapshot's
own settings predate it. Before touching anything it aborts any update the
Updater has journaled, so the restored release does not resume a failing
update. Everything that survives a rollback is host-side and not in the
snapshot: `/etc/verity` with the installation id, `VERITY_ROOT/backup-state/`
(keys, index, target id, catalog and per-snapshot object references), and the
backup directory itself. It then swaps staging in, pins the snapshot's release
and starts it. Automatic updates stay held until the administrator resumes them
in the app. Backups continue in the installation's current repository, the one
`backup-state/` belongs to, which may be newer than the snapshot's own if the
key or format changed since; snapshots taken after the pre-update snapshot
remain listed and restorable.

### Partial restore in the app

From a snapshot (screen 7):

- Restore a project as a new project. The new project receives the snapshot's
  workspace, session worktrees and knowledge folders of that project, and its
  project settings. Session histories are not copied into the new project in
  version one. The current project is not touched.
- Get a single file. The server decrypts that file and the app downloads it
  through the platform save dialog.

Both ask for the recovery key for that operation. The server holds it in memory
only for the duration of the operation and never writes it to disk, logs or the
database. Both are administrator-only.

### Snapshot list without the key

The server cannot decrypt manifests, so the app's snapshot list, status and
size figures come from a host-local catalog in `VERITY_ROOT/backup-state/` that
the server records whenever it publishes or deletes a snapshot: sequence, kind,
time, releases for pre-update snapshots, key generation and per-project sizes.
The catalog is a cache, never restore authority; when it is missing it is
rebuilt from the file names (sequence and kind) and modification times. The
repository, sequence and kind are also signed manifest fields; restore refuses
a snapshot whose file name or repository directory disagrees with them, so a
renamed or copied file cannot pass as newer or as `pre-update`. The
plaintext file names reveal snapshot count, kind and order to anyone who can
read the directory, which the size and timing of the files reveal anyway.

### Restore probe

A backup counts as verified only after a restore probe has passed. The app
starts it ("Test restore", screen 10); the user enters the recovery key for that
run, and the server holds it in memory only. The probe reads the newest
snapshot, verifies every signature, decrypts and authenticates every referenced
object, imports the database into a throwaway PostgreSQL container, restores Git
repositories into temporary staging for `git fsck --connectivity-only`, and
compares paths and sizes with the manifest. It changes nothing on the
installation and removes its staging on every exit path.

CI runs the same probe against a fixture repository for every format version,
in the pattern of `deploy/bin/verity-clean-install-smoke`. The status shows the
time of the last passed probe; a backup without one is shown as unverified, and
the alerting reminds after 90 days.

## Deletion and shutdown

- Delete a single snapshot from the snapshot sheet, after confirmation. Its
  objects are removed by garbage collection when no other snapshot needs them.
- "Pause backups" stops the schedule and the pre-update snapshot and keeps every
  snapshot: retention and garbage collection pause as well, so no snapshot
  expires while paused. The update gate does not hold updates while paused.
- "Delete all backups" removes this installation's repositories, its CA key
  files under `identity/` and its entries under `revocations/` after a typed
  confirmation, and turns backups off. Repositories and files of other
  installations in the same directory are left alone.
- A CA key file of an older key generation is removed together with the last
  repository of that generation, so a retired recovery key stops yielding the
  CA key once its snapshots have expired. Revocation entries of a generation
  are removed the same way.
- There is no per-file purge from existing snapshots in version one; a file
  removed from the workspace leaves snapshots under normal retention.
- Premium minimum retention, which can refuse a deletion, is defined in the
  Premium step.

## Authorization and execution identity

Setup, manual runs, restore operations, the probe, deletion and policy changes
require installation administrator authorization, enforced server-side on every
request. Project-level access is insufficient. Agents and project containers
receive no backup authority.

Capture runs inside the server process (the `node` user of the server
container) with streaming and bounded memory, and the database export uses the
dedicated read-only role. The server already holds the Docker socket and can
read every byte, so a separate worker would add a trust boundary and a
coordination protocol without removing that. Keep the capture interface free of
server internals so it can move behind the Docker policy gateway later.

## Core and Premium boundary

Core owns capture, encryption, manifests, the host-path destination, restore,
the probe and an open resumable ciphertext upload and download contract. The
Premium service owns storage, authentication and entitlement, account ownership
of repositories, host-independent minimum retention, quotas and billing; it is
outside this repository (`AGENTS.md`, Product boundary). Recovery key ownership
stays with the user.

## Implementation sequence and acceptance

### 1a: Backup that can be restored

Self-contained capture of everything in scope, the exclusion list, the database
export through the read-only role, the repository format with publication,
retention and garbage collection, the disk-full alert, the host-path destination with marker and free-space check,
the schedule with the operations defaults, recovery key setup with the
confirmation paste, identity in snapshots, a minimal installer fresh-host
restore and the restore probe in the app and in CI. Existing hosts receive the
new mount, the identity helper, the installation id and the read-only database
role only through the installer, so they re-run it once, in the pattern of ADR
0008 Amendment 2; until then the app shows that backups need the installer.

Acceptance:

- A fresh host restores from only the copied directory, the recovery key and the
  master password, with the original host and its local index destroyed:
  settings, usable integration credentials after unlock, knowledge originals
  and revisions, all worktrees, active, sleeping and paused projects, and
  devices reconnecting without pairing.
- `--new-identity` requires pairing and revokes old device tokens. A device
  revoked after the snapshot stays revoked after fresh-host restore and after
  rollback. A CA key file that does not match the snapshot's certificate is
  refused.
- Wrong keys, tampered, truncated or reordered objects, an unsigned manifest
  encrypted to the recipient, malicious paths and links, a full disk, a missing
  marker, an interrupted run and an unsupported format version fail safely and
  never replace the last good snapshot.
- Git: a session worktree with staged-only blobs, stash and reflog entries
  restores intact; a malicious `config`, `config.worktree` or hook in the main
  and in a linked worktree never executes during capture or restore; a symlink
  or `gitdir` or `commondir` entry pointing outside the project is refused at
  freeze and before `worktree repair`; a `git gc` in the sandbox during the
  freeze is detected and retried; a repository with alternates is flagged.
- Two snapshots after a small file edit share unchanged objects; transfer and
  retained bytes are measured, not only snapshot counts. The lock duration is
  measured on a large installation without reflinks.
- Two hosts restored from the same directory write separate repositories and
  never prune each other's.
- A sealed server captures completely. Project users and agents are refused.
- Each guard is deliberately broken once to prove the test catches it.

### 1b: Backup before updates

The pre-update snapshot after `preflight`, the update gate with its default,
"Update anyway", the held automatic update, the unbacked record in the update
history, pre-update retention, and the installer's same-host rollback with the
architecture check, so the snapshot the gate waits for can be used.

Acceptance: the snapshot is taken before `creating-standby`; a failed snapshot
holds the update with the reason; "Update anyway" records an unbacked update;
an automatic update never overrides the gate; without backups the update runs
with the note; rollback restores the pre-update state, keeps the devices the
snapshot knows paired, pins the release and holds automatic updates; a rollback
whose release has no image for the host aborts before touching anything.

### 1c: Everyday operations

Alerting, the retention settings and snapshot list in the app, single snapshot deletion,
pause and delete all, and partial restore of a project and of a single file.

Acceptance: each alert fires on its condition and clears; retention keeps
exactly the defined set across a simulated six months; a shared object survives
deletion of one snapshot; the recovery key used for a partial restore or probe
never reaches disk or logs.

### 2: Premium Uplink

Upload to Uplink through the open ciphertext contract, account-based download
in the installer followed by local decryption, host-independent minimum
retention, and Uplink enrollment continuity after restore.

### 3: Optimizations and advanced modes

Remote-dependent Git repositories, takeover of another installation's
repository, the quiesced pre-update snapshot, database segmentation, several
recovery keys per installation, and per-project exclusions. Each is described
below.

## Later

### Further destinations

Google Drive, a user-controlled object store, a managed NAS or SMB adapter and
an app download of a portable export are possible later destinations. They are
not in scope; the host path plus an administrator copy covers the same need in
version one.

### Later: remote-dependent repositories

Enable this only when measured sizes justify it: when self-contained `.git`
directories make up most of the repository's retained bytes on real
installations, or a repack regularly re-writes more than the schedule's other
changes. Until then the simpler self-contained capture stays.

The idea: pushed history already lives on an independent code host, so a
snapshot keeps only the local-only objects and restore fetches the rest. A code
host qualifies only when it survives the loss of the Verity host. GitHub
always does; a Forgejo connection does only when the administrator asserted at
connection setup that it runs in a different failure domain. A Forgejo on the
Verity host itself stays self-contained.

Capture for a qualifying repository:

1. Exclude `objects/` of the frozen copy; keep the metadata and `user-files/`.
2. Write a pack of the local-only objects, equivalent to
   `git rev-list --objects --all --reflog --indexed-objects --not <trusted-tip> | git pack-objects --local`,
   on the frozen copy. `--reflog` and `--indexed-objects` keep staged blobs,
   stash entries and commits reachable only from a reflog.
3. Record remote URL, connection id, trusted tip and branch, the ref list and
   the class `remote-dependent`.

The trusted tip is the default-branch commit that Verity last saw on the code
host, recorded by the server-side clone, fetch and brokered-push paths from the
transport result itself (the `ls-remote` answer or the push status report),
never from a ref read from `.git`. Those paths must adopt the hardened
invocation against a Verity-written configuration first; nothing records the
tip today. It is deliberately not `refs/remotes/origin/HEAD`, which the sandbox
can move onto a local-only commit. Only the default branch is used, because
feature branches are often squash-merged and deleted on the host.

The tip's OID is trusted, but the objects behind it come from the
sandbox-writable object store, and Git does not re-hash a packed object on an
ordinary read. A planted object under a genuine OID with forged parents could
hide local-only commits behind the tip. Capture therefore runs `git fsck` on the
frozen copy before packing. `fsck` verifies every object in the object store,
not only those reachable from the tip, so its cost is a full read of the
repository's objects on every run. A failure classifies the repository
self-contained.

A repository falls back to self-contained when it has no remote, an `origin`
that is not the connected host, no recorded tip, a tip whose commit is missing
locally, a failed `fsck`, a shallow or partial clone, grafts, replace refs, or
submodules.

Restore of a remote-dependent repository runs after the master password has
unlocked the secret store, because it needs the code host credential:

1. Validate pointers and restore the object-less `.git` and working files as in
   "Git restore". Keep the local-only pack in restore staging, not yet imported.
2. Fetch into a fresh bare repository in staging with a Verity-written
   allowlisted configuration: remote URL from the project record, the standard
   refspec, `http.followRedirects=false`, `fetch.unpackLimit=1`, one allowed
   scheme from the connection record, and the credential as an in-memory
   `http.extraheader` passed through `GIT_CONFIG_COUNT` environment entries.
   A repository renamed on the host is reported, not followed.
3. Only after the fetch succeeded, move the fetched packs and the local-only
   pack into the restored `.git/objects`, rewrite `refs/remotes/origin/*` from
   the staging repository in one `update-ref --stdin` transaction, and check the
   prerequisite with `git cat-file -e`.
4. Continue with `fsck`, `worktree repair` and reinstating user files as in
   "Git restore".

Importing the local-only pack only in step 3 keeps a repository whose fetch
failed in one defined state: object-less `.git`, pack in staging, project
suspended with "Code incomplete". That pending state is itself backed up under
the class `pending-rehydration`, carrying the staging directory and the
recorded tip. The user can retry after reconnecting the code host, or resume
the project with working files only, which renames `.git` to
`.git.verity-incomplete` and keeps the pack in staging. Renames are performed by
Verity with a persisted intent so `repoKey` bookkeeping survives a crash.

The status shows, per remote-dependent project, the age of the trusted tip. A
default branch force-rewritten after the last fetch is the one case that loses
history; restore detects it through the prerequisite and reports it.

Acceptance adds: rehydration against GitHub and Forgejo, offline restore of
repositories without a remote, unreachable and revoked hosts, deleted
repositories, rewritten history, a renamed default branch, a remote-tracking
ref moved onto a local-only commit, a planted object under the tip's OID, a
sandbox-written commit-graph, bitmap, replace ref, graft or shallow file, and a
server restart during pending rehydration.

### Later: takeover of another installation's repository

A restored host could continue the source installation's repository instead of
opening a new one, so the history stays in one place and objects are shared. It
needs a fence: the restored host writes a signed record naming the repository
it took over, and the original host, if still alive, stops publishing and
pruning when it finds a fence it did not write. That requires list and read
access on every destination and an explicit administrator confirmation; any
restore without it keeps today's installation-owned behavior. Object reuse
across repositories would race a prune by the old host, so a takeover copies
the objects its first snapshot needs rather than referencing them.

### Later: quiesced pre-update snapshot

A second, final snapshot after `quiescing-old` and before `handing-off-key`
would capture the exact pre-migration state. It needs two Updater changes:
quiescing must leave the old Server's control socket and database connection
usable for the request, and a failed snapshot must return the old Server to
serving through a new rollback path from `quiescing-old`. The quiesced window
would be bounded by the freeze of every `.git` and the database export, which
acceptance must measure before the step is enabled.

### Later: database segmentation

Deterministic, bounded segments with stable boundaries per table and key range
would let a small row change re-write one segment instead of the rest of the
table's export. Acceptance must then measure a large database after a row edit,
insertion and deletion. Physical base backups with WAL are a separate option
with different privileges and version coupling.

### Later: several recovery keys and per-project exclusions

The envelope format already allows several recipients; issuing a second key, for
example for a second administrator, needs the setup and replacement flows to
manage a set. Per-project exclusions need size estimates, explicit omission
warnings in the manifest and at restore, and must never let a partial backup
look complete.
