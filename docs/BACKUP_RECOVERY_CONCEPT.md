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
support manual local export and installer restore; scheduling, server-side
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

Default archive: complete application database plus everything under
`VERITY_ROOT/workspaces`, `VERITY_ROOT/sessions` and the knowledge folders, with
Git metadata, local commits, untracked files and ignored user files such as
`.env`. Include active, sleeping, paused and retained deprovisioned projects.
Record desired lifecycle state and the actual scope of each project.

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

### Worktree path dependency

Session worktrees reference their main repository through an absolute `gitdir`
pointer. Restore reinstates the same `VERITY_ROOT` or rewrites `.git` pointer
files and `worktrees/<name>/gitdir` entries, then validates with `git fsck` and
`git worktree repair`.

### Later: selective profiles

Large original knowledge/library files are user data. Later per-project content
selections need size estimates and explicit omission warnings. Selective
database content needs a supported logical export/import with dependency
handling; do not remove rows from a dump. Metadata for omitted assets must be
restored as explicitly unavailable.

## Encryption and key ownership

Generate a cryptographically random 256-bit recovery key locally as the private
half of an asymmetric recipient pair (X25519 or an equivalent reviewed scheme,
`age`-style). Store only the public recipient key on the host. Each archive gets
a fresh random data key wrapped to that public key. A maintained streaming
authenticated-encryption implementation protects content and manifest, with
explicit end-of-stream and ordering/completeness validation. Fix algorithm suite,
nonce discipline, format version and parser/resource limits during implementation
review; do not invent cryptography. Encrypt project names, filenames, secret
values and detailed metadata. The destination still observes ciphertext sizes,
times and storage usage.

What follows from the public-key design:

- Scheduled backups need no secret on the host and work while the secret store
  is sealed or after an unattended restart.
- A host compromise exposes current data but cannot open archives already stored
  at a destination.
- The host cannot verify an archive by decrypting it; verification is a restore
  probe performed with the private key.
- Key rotation creates a new pair. Old archives keep needing the old private
  key; the settings UI shows which key generation each retained archive needs.
  Rewrapping is optional and never overwrites the only usable envelope.

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

## Consistent capture

1. Inventory scope, data locations, capacity and uncovered storage before work;
   write the warnings into the manifest up front.
2. Acquire the lifecycle lock: refuse provision, deprovision, sleep, wake, mount
   changes and project deletion for the duration. Turns, edits and commits keep
   running. There is no global drain.
3. Take one transaction-consistent logical PostgreSQL snapshot (repeatable-read
   dump through the read-only backup role). Record its timestamp.
4. Copy worktrees and knowledge folders live, streaming through the encryptor.
   Record the copy window and the turns active in it.
5. Release the lock on every exit path; never wake a sleeping project to copy
   its files. Publish the archive as complete only after the destination has
   durably acknowledged the full ciphertext and manifest.

Git repositories tolerate a copy taken mid-write; restore repairs what it can and
reports what it cannot. Docker pause is not used. Cancellation, interrupted upload
and a full disk never replace the last good backup. Record omissions and failures
without leaking sensitive paths.

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
store, or Premium Uplink. Large archives are not pulled through a phone.

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
Provision containers fresh and only after compatibility, mounts and access are
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

Start with complete standalone archives. Add encrypted incremental chunks only
after key rotation, reference tracking, deletion and restore are proven. Show
last completed backup, last restore verification, actual scope and actionable
failures in settings.

## Acceptance and implementation sequence

1. Inventory persistence; introduce the exclusion list, the versioned manifest
   and complete export, the recovery kit with public recipient key, and the
   lifecycle lock.
2. Implement staging restore in the installer with release pinning, worktree
   repair and the restore probe script; prove complete local round trips on a
   fresh host before presenting backups as reliable.
3. Add scheduling, server-side destinations, and Premium ciphertext storage in
   its separate service using the same format and account ownership.
4. Add selective content profiles, export adapters for in-container services and
   incremental storage later.

Verification covers active/sleeping/paused projects, all worktrees and local Git
history, knowledge originals/revisions, settings and usable integration secrets
after master-password unlock. Verify fresh-host restore with archive, recovery
key and master password; wrong keys, tampering, truncation, malicious archive
paths, sealed secrets, full disk, interrupted capture/upload, unsupported
versions, revoked device access and repositories copied mid-write must fail
safely or be repaired and reported. The restore probe runs in CI on a fixture
archive and is schedulable on the host; a backup with no passing probe is shown
as unverified. Deliberately break each guard before trusting it. Never claim full
recovery for a partial archive or revive old authorization or runtime state.
