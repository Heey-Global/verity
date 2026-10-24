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
support a scheduled incremental repository on a host path or mounted NAS, the
pre-update snapshot and installer restore; app download, Google Drive and hosted
storage follow after restore is proven.

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

No Git command the backup runs ever reads a sandbox-written `config` or
`hooks`. That is the primary protection, because `.git` is writable from the
sandbox and its `config` can name programs to run, and no denylist of keys is
complete (`core.alternateRefsCommand`, `core.askPass`, `include.path` and
`includeIf` are examples of what a list tends to miss). At capture, the backup
first freezes the repository: it copies the whole `.git`, objects included,
into the server-owned capture staging area
(`<VERITY_ROOT>/capture/<runId>/<projectId>/<repoKey>/`, where `repoKey` is a
hash of the Git directory's path relative to `VERITY_ROOT`, so it includes the
root (`workspaces/<repo>`, `sessions/<sessionId>` or `restore/<projectId>`) and
the directory name itself; a project with several repositories or submodules, a
workspace and a session checkout of the same subpath, and a live `.git` next to
a `.git.verity-pending-<snapshotId>` all get distinct keys; a sibling of
`workspaces` that
no sandbox bind mount contains; the sandbox sees only volume subpaths under
`workspaces/<repo>` and `secrets`; each run has its own directory and a lock, so
a scheduled run, the warm pre-update run and a restore in progress never share
a path, and the directory is removed on every exit path of the run because it
holds plaintext refs, index and user `config`; a SIGKILL or host crash bypasses
exit paths, so the server sweeps `capture/<runId>/` directories whose run lock
is no longer held at startup. "Orphaned" is defined by run lock ownership, never
by age, and the sweep never touches `restore/<projectId>/<repoKey>/`: that
directory is
durable pending-rehydration data, owned by project state, and is removed only
when the project has rehydrated or the user has reconciled it. This staging is the one documented exception to the rule against
plaintext staging: it stays on the host, in a server-owned directory, for the
duration of a run). The copy uses reflinks where the
filesystem offers them and a plain copy otherwise, never hardlinks, which would
still share the sandbox-writable inode. The copy never follows a symlink, and
it does not rely on a check that a running sandbox could race: traversal is
fd-relative from the project root using `openat2` with `RESOLVE_BENEATH` and
`RESOLVE_NO_SYMLINKS` and `O_NOFOLLOW`, every opened file is `fstat`ed and its
identity compared with the directory entry before `FICLONE` or read, and a
symlink anywhere under `.git` is recorded as a finding instead of being copied.
A path component swapped for a symlink between two syscalls therefore fails the
open rather than redirecting a server-identity read into another project's
`objects/pack`, `refs` or the `secrets` directory. The same traversal copies
working files in capture step 4, storing symlinks as links and never following
them. Before the copy, the `gitdir:` target of a `.git` file and the `gitdir`
and `commondir` entries under `worktrees/<name>` are resolved and must lie
inside the project's own workspace or session paths; anything else is recorded
and the repository is captured as plain files without running Git. In the copy,
`config` is replaced by a sanitized file holding only the repository-format
keys; the main and every per-worktree `config.worktree`, `hooks` and
`objects/info/alternates` are moved out of Git's reach into a sibling
`user-files/` directory of the staging copy, because they can execute or
redirect. `shallow`, `info/grafts` and `refs/replace/*` are data, not
configuration: they stay in the copy so the connectivity check below can pass
on a shallow or grafted repository, `GIT_NO_REPLACE_OBJECTS=1` keeps replace
refs from steering any walk, and their presence still classifies the repository
self-contained. All of these files are user content and go into the snapshot as
such. Every Git command then runs with `GIT_DIR`
set to that copy and reads nothing from the live repository, so there is no
window between a check
and the pack in which the sandbox can change what Git sees. The copy is what
the snapshot stores as the repository's metadata and, for self-contained
repositories, as its objects, so refs, objects and pack are read from one copy.
The copy itself is live and not atomic: a `git gc` running in the sandbox can
delete a pack after its refs were copied, so the frozen copy can name objects it
does not hold. Every frozen copy on which Git can safely run, self-contained
ones included, therefore gets `git fsck --connectivity-only` before it is
accepted; remote-dependent copies additionally get the tip `fsck`, `rev-list`
and `pack-objects`, which detect the same condition. Missing objects trigger a
re-freeze with bounded retries, and after the last attempt the repository is
captured from its latest copy as plain files with an `unstable` flag, never
silently without its local-only history. A repository already known to be
incomplete at the freeze, because its alternates file was dropped
(`alternates-dropped`) or it is copied without validation, skips the
connectivity check and the retry loop: its failure is expected, repeating the
copy under the lock would gain nothing, and the known flag wins over
`unstable`. Repositories that Git cannot safely
run on (unknown extensions, out-of-project pointers) go through the same
fd-relative freeze but are flagged "not validated", because nothing can check
their consistency. The freeze is not free: without reflinks (ext4) it is a
full byte copy of every `.git`, the lock is held for its duration, and the
capacity inventory in capture step 1 must include the staging size of every
repository's `.git` alongside the destination estimate; a run that cannot stage
fails before it starts, not mid-copy. Only working files are copied live. The linked worktrees' `HEAD`, index and
reflogs live under `.git/worktrees/<name>` and travel with the copy. Where
classification needs the original `config`, for example to detect a promisor
remote or a partial clone, it is read as data with
`git config --file <original> --no-includes`, which parses and executes nothing
and follows no include. At restore, step 1 below sets the user's `config`,
`config.worktree` and `hooks` aside before any command runs, for
self-contained and remote-dependent repositories alike. The lifecycle lock is
held while repositories are frozen and working files are copied, as capture
step 2 states, which on a filesystem without reflinks means the full copy of
every `.git`; verification and packing run on the frozen copy after it is
released. The lock therefore scales with history size, and the status shows its
duration per run.

On top of that, every command uses one hardened invocation as defense in depth:
the backup execution identity (in the first release the server process, which
has network, so the isolation is `protocol.allow=never` on every capture
command plus the absence of any credential in capture, not a network
namespace);
`GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_TERMINAL_PROMPT=0`,
`GIT_PAGER=cat`, `GIT_NO_REPLACE_OBJECTS=1`; and command-line overrides for the
keys known to execute or redirect in the commands used (`rev-list`,
`pack-objects`, `index-pack`, `fsck`, `worktree`, `for-each-ref`, `update-ref`,
`cat-file`, and `fetch` in the fresh repository): `core.hooksPath` to an empty
directory, `core.fsmonitor=false`, `core.sshCommand=/bin/false`,
`credential.helper=`, `core.askPass=/bin/false`, `core.alternateRefsCommand=`,
`protocol.allow=never`, `gc.auto=0`, `maintenance.auto=false`,
`core.commitGraph=false`, `core.multiPackIndex=false`, `pack.useBitmaps=false`
(and the freeze drops `objects/pack/*.bitmap`, which is regenerable, so neither
`rev-list --use-bitmap-index` nor `pack-objects --revs` can trust a forged
bitmap that marks local-only objects as reachable from the tip), and
`safe.directory` set
to the exact repository path. The command scope counts as protected
configuration for `safe.directory`, so the `-c` form is honored. `shallow`,
`info/grafts` and `refs/replace/*` found at the freeze classify the repository
self-contained, because each can hide commits behind a fake history boundary;
the frozen copy cannot gain them afterwards. The one
credentialed fetch does not use the restored repository at all; see restore
step 3. Classification and the remote URL come from the server's project record
in the database, never from `.git/config`, so the sandbox cannot choose the host
that receives the connection credential or confuse the qualification check with
a look-alike URL. The server and installer images check their Git version at
startup against the floor this design relies on: 2.39, the version Debian
bookworm ships and the server image inherits, which covers worktree-aware
`--all`, `--reflog` and `--indexed-objects` (2.15), `GIT_CONFIG_COUNT` (2.31,
below which the credential header would be silently ignored) and `-c
safe.directory` as protected configuration (2.38). Reftable repositories
(`extensions.refStorage`) and any other extension the floor does not know are
copied as files without running Git on them and flagged "not validated".

A code host counts as a source of pushed history only when it survives the loss
of the Verity host. GitHub always does. A Forgejo connection does only when the
administrator asserted at connection setup that the instance runs on a different
machine and failure domain; a Forgejo whose URL resolves to the Verity host
itself, to a container on it or to the same storage, including a Forgejo that
Verity runs for its own projects, is in the same failure domain and its
repositories are captured self-contained, with the Forgejo data itself reported
as an in-container service the backup does not cover. The dependency is shown
at connection setup and in the backup status per project, not only at restore.

Capture, per repository that the project record ties to such an independent
code host:

1. Exclude `objects/` (loose objects and packs) of the frozen copy from the
   snapshot. Keep the rest: `HEAD`, `refs`, `packed-refs`, `index`, `logs`,
   `info`, `worktrees/*` and the stash, plus the user's original `config`,
   `config.worktree` files and `hooks` from the frozen copy's `user-files/`
   directory as plain user files, so metadata and user files come from the same
   moment. Verity never writes a token
   into `config`; the provisioner passes credentials as an in-memory
   `http.extraheader` (`packages/server/src/provisioner.ts:37`). Users and
   agents can still put secrets there, so `config` is user content encrypted
   like `.env`, not a file the backup vouches for.
2. Write a packfile of the local-only objects, equivalent to
   `git rev-list --objects --all --reflog --indexed-objects --not <trusted-tip> | git pack-objects --local`,
   run once against the staging copy; since Git 2.15 `--all`, `--reflog` and
   `--indexed-objects` cover the `HEAD`, reflogs and index of every linked
   worktree. `--local` is defense in depth against alternates; the freeze has
   already moved the alternates file out of Git's reach, so the copy holds only
   the repository's own objects. `<trusted-tip>` is the default branch
   commit that Verity itself last saw on the code host, recorded in the
   database by the server-side clone, fetch and push paths that run outside the
   sandbox with the connection credential, including pushes brokered for the
   sandbox, and recorded only after the host has accepted the push or served the
   fetch; a push that bypasses them leaves the tip stale, which only makes the
   pack larger. It is deliberately not
   `refs/remotes/origin/HEAD`: everything under `.git` is writable from the
   sandbox, and a remote-tracking ref moved onto a local-only commit with
   `git update-ref` would silently drop that commit's history from the pack.
   The recorded tip cannot be moved from inside the sandbox; if it is missing or
   its commit does not exist locally, the repository is captured
   self-contained. The tip's OID is trusted, but the objects behind it are read
   from the sandbox-writable `.git/objects`, and Git does not verify a packed
   object's hash on an ordinary read. A planted object under a genuine OID with
   forged parents or trees that name local-only commits or blobs would make the
   `--not <trusted-tip>` walk mark them uninteresting and drop them from the
   pack. Capture therefore runs `git fsck --no-dangling --no-reflogs
   <trusted-tip>` on the frozen copy before the pack, which re-hashes every
   object reachable from the tip and fails on a mismatch; a failure classifies
   the repository self-contained and raises a warning. Because check and pack
   read the same frozen copy, nothing can be planted between them. This costs a
   full read of the pushed history per snapshot, outside the lifecycle lock,
   which is accepted: an incremental check cannot be made safe, because a
   planted object can sit anywhere in that history. Acceptance measures this
   duration on a large repository and the pre-update quiesced window with it. Only the default branch is excluded, not every remote
   branch: feature branches are routinely squash-merged and deleted on the host,
   so a stale tip for `<branch>` would exclude commits the host no longer has.
   Pushed but unmerged branches are therefore included; they are small. After a
   merge-commit merge they drop out of the pack on the next snapshot; after a
   squash merge the original commits are unreachable from the default branch
   and stay in the pack for as long as the local branch exists, which is the
   price of the safe boundary. `--reflog` and
   `--indexed-objects` are what make the restored `index` and `logs`
   consistent: staged blobs, older stash entries and commits reachable only from
   a reflog after reset, rebase or amend have no ref, and a plain `--all` pack
   would leave dangling pointers behind. Chunk and encrypt the pack like any
   other file.
3. Record in the manifest: remote URL, the code host connection id, the trusted
   tip and its branch name as the prerequisite, the local ref list, and the
   project as `remote-dependent`.

Repositories that do not qualify are copied completely, including
`.git/objects`, and marked `self-contained`: no remote, an `origin` that is not
the connected code host, no recorded trusted tip, a failed tip verification, a
shallow or partial clone with a promisor remote, a `shallow` file, grafts or
replace refs, or submodules under `.git/modules`, whose object sets cannot be
reasoned about locally. Submodule `config` files are set aside at
restore like the main one. Alternates are never honored: the provisioner does
not create shared clones, so an `objects/info/alternates` file is either a
user's `clone --shared` or an attempt to pull another server-readable
repository into this project's backup. The freeze removes the alternates file
from the copy, so the copy holds only the repository's own objects and no
command follows a host path into another project; the repository is captured
self-contained as a file copy of those objects and flagged `alternates-dropped`,
a capture-time flag distinct from the restore-time "Code incomplete" state,
because the borrowed objects are missing. The manifest records that the file
existed. Today's local projects, which
still start from an empty initial commit, fall under this; after the "project
files without a repository" concept lands they have no Git at all and nothing
changes here.

No fetch runs during capture: capture holds no code host credential and every
capture command carries `protocol.allow=never`, so even a config key that
survived sanitizing could not reach the network through Git. A
default branch tip that is behind the real remote only makes the packfile larger.
A default branch that was force-rewritten after the last fetch is the one case
that loses history; restore detects it through the recorded prerequisite and
reports it. Self-contained repositories keep their whole `.git/objects` and
re-upload it after every `git gc`, so the size saving applies to remote-dependent
repositories only.

Restore, per repository. Steps 1 and 4 apply to every repository, including
self-contained ones; steps 2 and 3 apply to remote-dependent and
pending-rehydration repositories only and run after the master password has
unlocked the secret store so the code host connection credentials are usable:

1. Before any Git command, validate every `gitdir:` file target and every
   `worktrees/<name>/gitdir` and `commondir` entry in the snapshot against the
   project's own restore paths, rewriting them for a moved `VERITY_ROOT` and
   refusing any that point elsewhere, so a hostile snapshot cannot make the
   server write outside the restore root. Then restore `.git` (without objects
   for remote-dependent repositories) and the working files from the snapshot.
   Move the restored `config`, the main worktree's `config.worktree`, every
   `worktrees/<name>/config.worktree` and `hooks` into the server-owned restore
   staging area outside the sandbox-writable tree
   (`<VERITY_ROOT>/restore/<projectId>/<repoKey>/git-user-config/`, keyed per
   repository like capture staging), where they persist
   across failed attempts and retries and nothing in the sandbox can alter them,
   and write a sanitized `config` that contains the repository-format keys
   copied from the original, `core.repositoryformatversion`, `core.bare` and an
   explicit list of extensions, `extensions.objectFormat` and
   `extensions.worktreeConfig`, without which `index-pack` and `fsck` misbehave
   on SHA-256 or worktree-config repositories. Other `extensions.*` keys are not
   copied; `partialClone` in particular would make the restored repository
   lazy-fetch, and a repository that had it was classified self-contained
   anyway; `refStorage` repositories were copied as files without validation. Then the remote URL from
   the project record and the standard
   refspec `remote.origin.fetch = +refs/heads/*:refs/remotes/origin/*`. Every
   command in this list uses the hardened invocation described above. Users and
   agents can edit `config`, `config.worktree` and `hooks`; `core.sshCommand`,
   `core.fsmonitor`, `credential.helper`, `url.*.insteadOf`, `http.proxy`,
   `http.sslVerify` or a `reference-transaction` hook would otherwise execute
   during restore or redirect the fetch credential.
2. `git index-pack` the local-only packfile into `.git/objects` first; it has
   no prerequisites of its own.
3. Fetch into a fresh repository, not into the restored one. The restore creates
   a temporary bare repository in the staging area with `git init --bare` and an
   allowlisted configuration written by Verity, nothing else: the object format
   from step 1, the remote URL from the project record, the standard refspec,
   `http.followRedirects=false`, `protocol.allow=never` and the single allowed
   scheme taken from the connection record: `protocol.https.allow=always`, or
   `protocol.http.allow=always` only when the administrator configured that
   Forgejo connection over plain HTTP, as some LAN installations are; the
   restore never upgrades or downgrades the scheme on its own. The code host
   credential is an in-memory
   `http.extraheader`, as the provisioner uses today, handed to this single
   `git fetch origin` through the `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n`/
   `GIT_CONFIG_VALUE_n` environment of that one child process rather than `-c`,
   so it never appears in argv or `/proc/*/cmdline`; it is still readable in
   `/proc/<pid>/environ` by the same uid inside the server container. Sandboxes
   are sibling containers with their own pid namespace and never share the
   server's `/proc`, and nothing a sandbox can reach runs in the server
   container, which is what makes this acceptable. No sanitized denylist is
   relied on for the credentialed command: the fresh repository has no
   sandbox-written file at all, so no `include.path`, `config.worktree`,
   alternates or replace ref can reach it. The allowlist also sets
   `fetch.unpackLimit=1`, so every received object arrives as a pack and none is
   exploded into loose files; the resulting packs are moved into the restored
   `.git/objects`. No second fetch follows: the objects are already
   present, so the restored `refs/remotes/origin/*` are rewritten from the
   staging repository with `git for-each-ref refs/remotes/origin` piped into
   `git update-ref --stdin` as one transaction, which needs no protocol and no
   negotiation. Then check the prerequisite with `git cat-file -e`. A
   repository without a trusted tip at capture time was already classified
   self-contained and does not reach this step. Remote-tracking refs restored
   from the snapshot are untrusted and are overwritten here.
4. `shallow`, `info/grafts` and `refs/replace/*` are already in the restored
   `.git`, because capture left them in the frozen copy; nothing reinstates
   them, and `GIT_NO_REPLACE_OBJECTS=1` in the hardened invocation keeps replace
   refs from steering traversal. `git fsck --connectivity-only` and
   `git worktree repair`, the latter on
   the pointers already validated in step 1. What `fsck` decides depends on the
   class. For a remote-dependent or pending-rehydration repository a failure
   means rehydration failed and the project stays pending. For a self-contained
   repository a failure is recorded and the project is marked "Code incomplete";
   for one flagged `alternates-dropped` that failure is the expected terminal
   outcome, not something a retry can change. For a repository whose restore completed, a validated or
   known-incomplete self-contained one or a successfully rehydrated one, the
   user's `config`, the main and every per-worktree `config.worktree` and
   `hooks` are put back from staging once the last Git command of the restore
   has run, because nothing in the restore executes them afterwards and they are
   user content, not restore input; the staging copy is removed only then. A
   repository whose rehydration failed keeps its staging copy untouched, since
   the pending state depends on it. A default branch renamed on the
   host since capture needs no handling: the rename keeps the commit, the fetch
   brings it under its new name, and the prerequisite check is by OID.

A user who gives up on rehydration can resume the project in a "working files
only" state. That state is defined, not implied: the restored `.git` is renamed
to `.git.verity-incomplete` so no tool mistakes it for a usable repository, the
working files stay in place, the local-only packfile and the set-aside user
config stay in the server-owned `<VERITY_ROOT>/restore/<projectId>/<repoKey>/`
where the
sandbox cannot reach them, and the project screen shows that Code has no history
until the code host is reconnected and rehydration is retried. Nothing local is
discarded by that choice; it is not a self-contained repository.

Pending state is itself backed up, under its own manifest class. A project that
a restore left in "Code incomplete" or "working files only" state is captured as
`pending-rehydration`, not as self-contained: the snapshot carries its working
files, its Git directory in whatever state the restore left it (an object-less
`.git` for "Code incomplete", the renamed `.git.verity-incomplete` for
"working files only"; classification is driven by the project's recorded
restore state, never by the directory name, so neither is frozen, connectivity
checked or retried), its
`<VERITY_ROOT>/restore/<projectId>/<repoKey>/` staging directories with the
unimported
local-only packfile and the set-aside user config, and, copied forward
unchanged from the original manifest, the remote URL, connection id, trusted
tip and branch. A later restore treats a `pending-rehydration` project like a
remote-dependent one whose rehydration has not happened yet, with two
differences spelled out. It renames `.git.verity-incomplete` back to `.git`
before step 1, and step 1 then runs in full on that directory: the project may
have been resumed in "working files only" state, so everything inside it is
sandbox-written and is stripped and staged like any other restored `.git`, and
a fresh sanitized `config` is written. If a `.git` already exists because a user
or agent ran `git init` in the resumed project, nothing is overwritten: the new
repository stays `.git` and is restored by the normal rules for its own class,
and the pending directory is restored as `.git.verity-pending-<snapshotId>`
beside it for the user to reconcile. Capture of a project that holds both
classifies the live `.git` by the ordinary rules and the pending directory, by
project state, as `pending-rehydration` data, so neither is lost. The user `config`, `config.worktree`
files and `hooks` carried forward from the first restore's staging directory
are the authoritative copies that step 4 reinstates; the versions stripped from
the renamed directory are kept beside them for the user and are never
reinstated automatically. The local-only commits therefore stay
recoverable through the new installation's own unattended backups for as long
as they are retained there. No pin on the source
snapshot is attempted: it could not be enforced when the new installation
starts a fresh repository, when the source was a portable bundle, or when the
old host is still alive and running its own retention against the same
destination.

That last case also decides how a restored host writes. It never continues the
original generation: it opens a new repository generation at the destination,
with its own sequence space and its own index, under the same recipient and the
recovered signing key, and its garbage collection only ever considers objects of
generations it owns. Before publishing the first snapshot it writes a signed
fence record naming the generation it was restored from; a host that finds a
fence it did not write for its own generation stops publishing and pruning and
reports that another installation has taken over. Two writers with one signing
key and diverging indexes therefore never prune each other's objects, and the
sequence number stays monotonic within every generation.

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

Do not invent cryptography: use a maintained, reviewed authenticated
streaming-encryption construction for objects and manifests, with per-chunk
ordering, an explicit end-of-stream marker and completeness checks, so
truncation, reordering and splicing are detected before any byte is acted on.
Encrypt project names, file names, secret values and detailed metadata, not
only content; a destination still observes sizes, counts and timing.

Recipient encryption alone does not authenticate the writer: anyone holding the
public recipient key can mint objects and manifests that decrypt cleanly, and a
forged manifest would feed `index-pack`, path restore and the remote URL of the
credentialed fetch. Two measures close that. The public recipient key is treated
as confidential host state, never written to a destination, a manifest or hosted
metadata. And every manifest is signed with a host-local signing key (Ed25519)
kept in the same restricted storage as the fingerprint key; its verification key
is part of the recovery kit and the restore refuses a manifest whose signature
does not verify against the kit. A compromised host can forge signatures, which
is already the accepted host-compromise case; a destination or an attacker who
only obtained the public recipient key cannot. Bound the
resources every parser may consume (manifest size, path count and length, link
depth, object count) and validate archive paths and links against the staging
root before writing, so a malicious manifest cannot exhaust memory or escape
the restore directory. Version the format and keep cross-version fixtures.

Recovery kit: one encoded string, printed as text with checksum and as QR code,
that carries both the private recovery key and the manifest verification key;
the user handles one artifact, and "the recovery key" in the user interface
means that string. The verification key is public, but without it a restore
cannot accept any manifest, so it is never issued separately. The signing key pair is generated at
setup together with the recipient pair; the private signing key lives in
restricted host-local storage, is never part of a snapshot, and a copy encrypted
to the recipient is stored in the repository, so a restore, which holds the
private recovery key at that moment, recovers it, checks that its public half
equals the kit's verification key or is reachable through the signed rotation
chain, and only then installs it on the new host; a planted key object that
fails that check is reported and the restored host generates a fresh signing
key, signs it with nothing, and tells the user that the kit must be reissued.
The recovered key signs only the new generation the restored host opens; see
"Git history and code hosts" for the fence that keeps a still-living old host
from writing beside it. Later snapshots from the restored host therefore still verify against the
same kit, which `pending-rehydration` restores depend on. Rotating the signing
key is done by signing the new verification key with the old one and recording
the chain in the manifest; the kit's verification key remains the root. Setup
requires a successful re-entry check of the recovery key. Restore accepts QR scan, clipboard paste and typed
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
Fingerprints are keyed, an HMAC under a random per-repository key, not plain
hashes. Capture must be able to run with a sealed secret store, so that key lives in the
same restricted host-local storage as the index and the public recipient key,
readable by the backup execution identity only; a copy is stored in the
repository encrypted to the recipient so an index rebuild can recover it. The
keying protects against an index that leaks without the host, for example a
copy that reached a destination or a backup of the host filesystem; it does not
protect against a compromised host, which reads the files directly anyway. That
index contains sensitive information and must not be uploaded unencrypted.
Destination observers can still infer sizes, timing and reuse patterns.

Each new object receives an independent random data key, authenticated encryption
and an envelope to the public recovery recipient. Encrypt manifests the same way.
Manifests carry ordered object references, envelopes, integrity information,
file metadata and the repository/key-generation identity. Bind those identities,
object type and format version into authentication, and into the manifest
signature as well, together with a monotonically increasing snapshot sequence
number and a signed timestamp: a destination can otherwise replay an older,
validly signed manifest or one from another generation. Restore shows sequence
and timestamp of the newest manifest it found and warns when a later sequence
is known from the host's own records or from the user. Reusing an object reuses its
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

1. Inventory scope, data locations, capacity (destination estimate plus the
   local staging size of every repository's `.git`) and uncovered storage before
   work; write the warnings into the manifest up front.
2. Acquire the lifecycle lock: refuse provision, deprovision, sleep, wake, mount
   changes, project deletion, and rehydration retries or resumption of a pending
   project while repositories are frozen and working files copied, not during
   verification, packing or upload, so a snapshot never sees a half-moved
   pending state. Turns, edits and commits
   keep running. There is no global drain.
3. Take one transaction-consistent logical PostgreSQL snapshot (repeatable-read
   deterministically segmented logical export through the read-only backup role,
   whose credential is provisioned by compose like the server's own
   `DATABASE_URL` and lives outside the secret store, so a sealed server can
   still capture). Record its timestamp.
4. Copy worktrees and knowledge folders live, streaming through the encryptor,
   with the same fd-relative no-follow traversal as the freeze, storing symlinks
   as links; skip `.git/objects` only for repositories that qualify as
   remote-dependent under "Git history and code hosts" and write their
   local-only packfile instead; every other repository keeps its objects, and
   projects in a pending restore state include their restore staging
   directory. Record the copy window and the turns active in it.
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
   snapshot. No turn writes anymore, so it captures the exact pre-migration
   state. The delta it transfers is small, but the quiesced window is bounded by
   the freeze of every `.git` (a full copy without reflinks), the tip `fsck` of
   every remote-dependent repository and the database export, not by the delta;
   the warm pass shortens only the upload. Acceptance measures this window on a
   large installation and the status shows it. The Updater continues only after the
   snapshot is durable in the sense of the three-case rule below, normally the
   destination's acknowledgement and, for a sealed server whose only
   destinations need the unlocked store, the local spool, not after bare local
   capture, because it is the rollback point. This extends the quiesced window by the
   upload of that delta; the warm pass keeps it short, and the update status
   shows the wait as its own phase. Two requirements on the Updater follow:
   quiescing must leave the old Server's control socket and database connection
   usable for this request, and a failed or timed-out snapshot must return the
   old Server to serving through a rollback path from `quiescing-old`, so the
   abort is a normal rolled-back update, not a stuck one. Both are new Updater
   work; the journal has no such rollback from that phase today. The Updater's
   request also preempts a scheduled capture that happens to be running: the
   scheduled run is cancelled (it never replaced the last good backup anyway)
   before the final snapshot starts, so lock contention cannot eat the timeout.

Both snapshots use the ordinary capture path: incremental, encrypted to the
public recovery key, no secret needed for host-path and NAS destinations. Capture
always runs; for a Drive destination only delivery waits for an unlocked secret
store. One rule, in three cases, decides whether the Updater continues. With no
destination configured, no snapshot is attempted; the update runs and is
recorded as unbacked. With at least one destination, the final snapshot must be
durably committed at one of them. If every configured destination needs the
unlocked store and the store is sealed, a snapshot durably in the local spool
suffices and the update is recorded as "backed up locally only"; a sealed server
at this point is possible, because an update may run sealed and the promoted
Server then starts sealed as well. Everything else, a failed or timed-out final
snapshot or a full spool, aborts. The warm snapshot never aborts an update by
itself; its failure is logged and the final snapshot decides. The final snapshot is tagged
`pre-update` with previous and target digest, and retention keeps at least the
last two pre-update snapshots regardless of the schedule's policy.

A snapshot that fails or exceeds its timeout aborts the update in a phase that
has not touched data. With no destination configured the update runs and the
update history (#1045) shows it ran without a backup; the administrator setting
"require a backup before updates" turns that into a refusal with a clear reason.
Only a snapshot durably committed at a configured destination satisfies that
setting; "backed up locally only" through the Drive spool does not, and the
refusal names the destination that blocked. Without the setting the spool-only
case proceeds, as stated above.
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

Start with incremental repositories; self-contained portable exports follow in
step 3. Prove
reference tracking, atomic publication, retention, index recovery and restore
before presenting the first release as reliable. Show last completed backup,
last restore verification, actual scope, actionable failures and, per code
project, the age of the trusted tip (time since Verity last saw the default
branch on the code host) in settings; a stale tip means the pack carries more
than necessary and the residual force-rewrite window is larger. A missing backup
destination is a persistent settings warning and an entry in the update history,
not a degraded health state.

## Acceptance and implementation sequence

1. Inventory persistence; introduce the exclusion list, trusted-tip recording
   in the server-side clone, fetch and brokered-push paths (new work; nothing
   records that tip today), the Git local-only packfile, the versioned
   manifest and incremental repository export, the two Updater changes (a
   control request the old Server still answers after `quiescing-old`, and a
   rollback from that phase back to serving when the request fails; both are
   new Updater work, not existing behavior), the
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
usable integration secrets after master-password unlock. Cover a session worktree
with staged-only blobs, a branch deleted on the host after a squash merge, a
missing trusted tip, a remote-tracking ref moved onto a local-only commit from
inside the sandbox, a symlink under `.git` pointing at another project, a
`gitdir` or `commondir` entry pointing outside the project before freeze and
before `worktree repair`, a planted object under the trusted tip's OID with forged
parents, a renamed default branch, a repository renamed or transferred on the
host so that the recorded URL now redirects (the restore reports the redirect
instead of following it, showing the `Location` target only when an
unauthenticated probe without the credential can read it, and asks the
administrator to update the project
record), a `git gc` in the sandbox during the freeze, a forged manifest encrypted
to the recipient key but unsigned, a server restart while a project is pending
rehydration (the staging directory must survive), a malicious `config.worktree` in
the main and in a linked worktree, a sandbox-written commit-graph, reachability
bitmap, replace ref,
graft or shallow file added between classification and pack, a repository with
alternates or submodules, and a fetch into a repository whose refs still dangle. For
updates, prove that
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
