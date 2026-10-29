# Backup and recovery acceptance evidence

This matrix assesses commit `4e4b0befb89752c116278a350d2f0e3da97765d5`
against [ADR 0025](adr/0025-encrypted-backup-and-installer-recovery.md) and the
[1a, 1b and 1c acceptance criteria](BACKUP_RECOVERY_CONCEPT.md#implementation-sequence-and-acceptance).
It records evidence, not permission to enable the feature.
`BACKUP_RECOVERY_ACCEPTED` remains `false` in
[routes.ts](../packages/server/src/backup/routes.ts).

## Evidence rules

- **Demonstrated**: the named scenario ran in the separate-daemon Docker acceptance harness.
- **Test-covered**: direct assertions cover the stated scope; this does not imply the complete product flow or every adversarial case.
- **Partial**: implementation or tests cover only part of the requirement.
- **Missing evidence**: the requirement needs a specific additional test, measurement or archived result; this does not establish an implementation defect.
- **Not implemented**: the required product path was absent from the inspected implementation.

The baseline [CI run 40685572219](https://github.com/Heey-Global/verity/actions/runs/40685572219)
completed successfully for the commit above, including all four test shards,
embedded tests, type checking, export checking, installer checks, image build,
and Compose and managed Docker acceptance. That result establishes only the
assertions actually present in those tests. This documentation change does not
rerun or broaden that baseline.

The Docker fixture uses a CI cryptographic release trust root, not the production
Sigstore service. Retained API-token authentication is not a native device TLS
reconnection or a new pairing handshake. An interrupted restore returning to its
previous installation is not the pre-update same-host snapshot rollback.

## Evidence index

Paths below are relative to the repository root; test names and scenario names
are the anchors, so a later line-number shift does not silently change scope.

| ID | Source and scope |
| --- | --- |
| E01 | [Docker fixture](../.github/scripts/backup-restore-docker.mjs): `capture`, `restore`, `assert-restored`, `assert-aborted`, `verify-api`; one active project, one linked worktree, one knowledge insight and one encrypted credential. |
| E02 | [Docker smoke](../deploy/bin/verity-backup-restore-smoke): original-host-free restore, wrong key, damaged snapshot/release, constrained space, unsupported recovery image, process interruption, acceptance, abort and new identity. |
| E03 | [Capture](../packages/server/src/backup/capture.test.ts), [inventory](../packages/server/src/backup/inventory.test.ts), [filesystem](../packages/server/src/backup/filesystem.test.ts), [lifecycle](../packages/server/src/backup/lifecycle.test.ts): content inventory, ownership, schema check, live copy and lifecycle leases. |
| E04 | [Database](../packages/server/src/backup/database.test.ts), [capture implementation](../packages/server/src/backup/capture.ts), [database implementation](../packages/server/src/backup/database.ts): consistent export/import, sequences and trigger behavior. |
| E05 | [Crypto](../packages/server/src/backup/crypto.test.ts), [format](../packages/server/src/backup/format.ts), [fixture](../packages/server/src/backup/fixture.test.ts): recovery keys, authenticated metadata, streaming frames, chunking and committed v1 compatibility fixture. |
| E06 | [Repository](../packages/server/src/backup/repository.test.ts): destination-only restore, ciphertext reuse, failed publication, sequence reservation, traversal/replay/conflicts and corrupt objects. |
| E07 | [Destination](../packages/server/src/backup/destination.test.ts): marker, capacity, replaced mount, symlinks/FIFO and full-destination reboot. |
| E08 | [Capture Git](../packages/server/src/backup/git.test.ts), [restore Git](../packages/server/src/backup/restore-git.test.ts): sanitized execution, pointers, alternates and bounded connectivity retries. |
| E09 | [Setup state](../packages/server/src/backup/state.test.ts), [service](../packages/server/src/backup/service.test.ts), [prerequisites](../packages/server/src/backup/prerequisites.test.ts), [identity requests](../packages/server/src/backup/identity-request.test.ts): confirmation, abandoned setup, non-decrypting state, helper recipient binding and prerequisite detection. |
| E10 | [Scheduler](../packages/server/src/backup/scheduler.test.ts), [staging](../packages/server/src/backup/capture-staging.test.ts), [priority](../packages/server/src/backup/priority.test.ts): catch-up, backoff, pause, timeout, killed lock-holder cleanup and worker priority. |
| E11 | [Retention](../packages/server/src/backup/retention.test.ts), [maintenance](../packages/server/src/backup/maintenance.test.ts), [generation maintenance](../packages/server/src/backup/generation-maintenance.test.ts): calendar selection, shared objects, ownership, reference authentication and generation retirement. |
| E12 | [Operational alerts](../packages/server/src/backup/operational-alerts.test.ts), [notifier](../packages/server/src/backup/alert-notifier.test.ts), [probe jobs](../packages/server/src/backup/probe-jobs.test.ts), E07/E09/E10: persisted sanitized episodes, per-device delivery retry, authority checks and probe age. |
| E13 | [Revocations](../packages/server/src/backup/revocations.test.ts), [device review](../packages/server/src/backup/device-review.test.ts), [final review](../packages/server/src/backup/restore-final-review.test.ts): outbox, signed sequence gaps/floors, explicit allowlist, expired sessions and final factor/revocation recheck. |
| E14 | [Restore identity](../packages/server/src/backup/restore-identity.test.ts), [restore host](../packages/server/src/backup/restore-host.test.ts): real OpenSSL CA/key matching and host identity handling. |
| E15 | [Restore staging](../packages/server/src/backup/restore-staging.test.ts), [preparation](../packages/server/src/backup/restore-preparation.test.ts), [installer entrypoint](../packages/server/src/backup/restore-installer-main.ts): authenticated selection, pinned release/capability, capacity and production composition. |
| E16 | [Restore database](../packages/server/src/backup/restore-database.test.ts), [sanitizer](../packages/server/src/backup/restore-database.ts): revocations, project suspension, interrupted work and ephemeral-state cleanup. |
| E17 | [Trial](../packages/server/src/backup/restore-trial.test.ts), [trial runtime](../packages/server/src/backup/restore-trial-runtime.test.ts), [startup](../packages/server/src/backup/restore-startup.test.ts): restricted Unix socket, password/review, isolation specification and normal-start guard. |
| E18 | [Promotion](../packages/server/src/backup/restore-promotion.test.ts), [lifecycle](../packages/server/src/backup/restore-lifecycle.test.ts), [previous runtime](../packages/server/src/backup/restore-previous-runtime.test.ts), [host state](../packages/server/src/backup/restore-host-state.test.ts): durable transitions, retries and restored container names before writers start. |
| E19 | [Accepted backup initialization](../packages/server/src/backup/restore-backup.test.ts): CA receipt before activation, partial activation retry, source repository preservation and unrelated-state refusal. |
| E20 | [Routes](../packages/server/src/backup/routes.test.ts), [probe jobs](../packages/server/src/backup/probe-jobs.test.ts), [probe worker](../packages/server/src/backup/probe-worker.test.ts): current administrator checks, safe errors, key-free durable jobs and isolated pinned workers. |
| E21 | [Update preparation](../packages/server/src/self-update/update-preparation.ts): current direct transition from successful preflight to `creating-standby`. |
| E22 | [Installer guidance](INSTALLER_RECOVERY.md), [API documentation](BACKUP_API.md), [installer](../deploy/bin/verity-install), [backup routes](../packages/server/src/backup/routes.ts): supported entrypoints and current public API. |

## Additional local security evidence

The security tests added after the CI baseline above are local evidence until
published CI covers them. They do not retroactively extend that baseline run.

- [Restore authenticity](../packages/server/src/backup/restore-authenticity.test.ts)
  constructs decryptable recipient-encrypted envelopes with no valid signature,
  a foreign signer and an authenticated future format; repository reads and the
  actual installer verifier reject them before release/extraction/database/host
  effects while preserving and restoring the last good snapshot.
- [Production capture round trip](../packages/server/src/backup/capture.test.ts)
  now preserves index-only blobs, stash and reflog-only commits, restores hostile
  main/linked-worktree configuration and hooks only after real Git validation,
  and scans owned fixture files for the encoded recovery key and private age
  identity at probe phase boundaries and after successful/failed probes.
- [GC and alternates](../packages/server/src/backup/git-gc.test.ts) synchronize an
  actual `git gc --prune=now` between a loose object's stat and read. The next
  freeze succeeds. A shared clone with borrowed-only objects is explicitly not
  validated after alternates are dropped. These tests exposed and corrected
  missing ENOENT retry classification and skipped connectivity checks for
  alternates-dropped repositories.
- [Database sanitization](../packages/server/src/backup/restore-database.test.ts)
  seeds preview shares/locks/removals, capabilities, grants/approvals, secret job
  frames, trusted output, linked messages, moves, Matrix outbound, meeting commands,
  dev-server runtime state and push receipts before resetting them; assertions
  use the seeded fixtures independently of the implementation's reset list.
  Every current reset-list member has a nonempty fixture; durable grant/server
  definitions survive, meetings become interrupted and the control-plane generation
  increments while losing its old holder. The migrated schema currently has no separate enrollment-recovery table; an
  assertion requires review when an enrollment/recovery-named table appears.
- [Route authorization](../packages/server/src/backup/routes.test.ts) repeats
  actor denials after availability opens. [Trial routes](../packages/server/src/backup/restore-trial.test.ts)
  reject actual project, turn and update endpoints even with a valid recovery
  session. The complete flat-router table is restricted to health and recovery
  routes, including routes registered before readiness; the accidental pairing
  route mutation was rerun against this allowlist and failed. The
  [runtime specification](../packages/server/src/backup/restore-trial-runtime.test.ts)
  restricts mounts/environment, ports, capabilities and entrypoint.
- [Probe jobs](../packages/server/src/backup/probe-jobs.test.ts) scan job files and
  captured console output across success, sensitive dependency failure,
  cancellation and reopen. [Installer transport](../packages/server/src/backup/installer-secrets.test.ts)
  executes the actual shell function and real jq with a fake worker, observes jq
  and Docker arguments, scans fixture files and captures output during failure,
  retry and abort. Credentials are checked in stdin, not saved by the worker.
  This is controlled boundary instrumentation, not a claim about every possible
  host log, crash dump or future partial-restore implementation.

Exact temporary changes, test arguments, source digests and observed failures
are recorded in the [security mutation ledger](backup-security-mutations.json).
The ledger covers these guards only; A41 remains open for the rest of ADR 0025.

## Local verification results

These results cover the local security changes on top of `4e4b0befb`; they are
separate from CI 40685572219 and do not open the recovery acceptance gate.

- `vitest run packages/server/src/backup --maxWorkers=1`, with disposable
  PostgreSQL 15, a 60-second test timeout and the teardown-only workaround below:
  **71 files and 186 tests passed**. The original run had 185 passing tests and
  one failure because `service.test.ts` expected a nearly-full real destination
  to become healthy on a filesystem with less than 10% free space. Its `statfs`
  fixture now normalizes the percentage only; available bytes, minimum reserve,
  marker, writable checks and explicit full/healthy transitions remain exercised.
  Real capacity handling is independently covered by `destination.test.ts`.
- Restored service/destination tests plus store testing and global-setup tests
  passed in the follow-up harness run. That extra run totaled **67 passing tests
  and one failing test**: the unchanged `scripts/test-postgres.test.ts` role test
  calls `os.userInfo()`, which fails with `uv_os_get_passwd`/`ENOENT` because this
  container has no `/etc/passwd`. The real PostgreSQL URL is supplied explicitly;
  this bootstrap portability check remains an environment limitation.
- The earlier affected authentication/deployment/diagnostics run passed **4 files,
  86 tests**; its exact scope is recorded in the mutation ledger.
- `tsc -b packages/server`, scoped ESLint, changed-file Prettier and
  `git diff --check` passed, including the stabilized service test.
- All **23 deliberately broken guard cases** failed as expected, including
  omission of the low-space alert after stabilizing the service fixture. Original
  source and test SHA-256 digests were checked after restoration. The restored
  service test passed again after its mutation.

### Teardown workaround and cleanup verification

The original PostgreSQL cleanup warning, `code.charCodeAt is not a function`,
was traced to Vite 8.3.5's `extractInlineSourceMap` while the store's
`backgroundOwner` reads `Error.stack` during pool acquisition. Calling the built
`dropRunDatabases` outside Vitest succeeded. This is a test-loader stack-formatting
failure, not evidence that the PostgreSQL deletion statement itself failed.
The default harness remains unchanged and can still emit that warning.

For the passing local run, a temporary configuration spread the repository's
Vitest configuration and replaced only `test.globalSetup` with a wrapper. The
wrapper called the original setup, recorded its minted namespace and used this
teardown body (no source-map workaround was active in test workers):

```typescript
const previous = Error.prepareStackTrace;
Error.prepareStackTrace = undefined;
try {
  await teardown(); // callback returned by the original global setup
} finally {
  Error.prepareStackTrace = previous;
}
```

After teardown, an independent PostgreSQL query enumerated the exact names from
`runDatabaseNames(namespace, 64)` and found **zero remaining databases**. The
follow-up guard run also used the wrapper. No production dependency, latency
instrumentation or repository-wide test configuration was changed. A fresh
Docker CI run, native device acceptance and a host-wide secret audit remain
outside these local results.

## Backend restore and identity follow-up

The preceding baseline remains historical. PR #2020 at `5d81be207` passed
[CI 40766249168](https://github.com/Heey-Global/verity/actions/runs/40766249168)
and CodeQL before being merged. The following additions extend the assertions;
their new separate-daemon and live rotation scenarios require a new CI result.
They must not inherit the earlier run's demonstrated status.

Local verification on the integrated main base used real PostgreSQL 15 and one
test worker: 269 tests in 80 affected backup/authentication/pairing and TLS/content
files passed. All 203 workflow tests passed in a separate rerun after a timeout
under concurrent verification. The repository metadata follow-up passed nine
repository/service/key-replacement tests and a detected/restored substitution
mutation. The separate root rotation suite passed 19 tests and the unchanged
pairing helper suite passed 12 tests. Coverage includes replaced container inventory,
stale invitations and updater restart ordering. Server build, changed-file ESLint,
formatting, script syntax and restored mutation-source/test digests passed.
PostgreSQL cleanup
used the documented teardown-only formatting workaround. Docker and native
execution are not provided by this local sandbox; dedicated Docker CI remains
required.

- **A05/A12/A19/A20:** [content fixtures](../scripts/backup-restore-content.mjs)
  cover active, sleeping, paused (visible/absent), and retained deprovisioned
  (archived/absent) projects, twelve Git repositories/worktrees, eight sessions
  and attachments, filesystem knowledge, eight document revisions and original
  binary bodies. Expected file digests, Git heads and database projections are
  saved independently before capture. PostgreSQL-backed
  [content tests](../scripts/backup-restore-content.test.ts) reject changed or
  missing linked files, revisions, originals and attachments. The Docker driver
  removes the original host/index and captures in a fresh sealed worker with no
  master password or recovery private key; this is not a normal-server reboot test.
- **A21/A22/A23/A24:** [TLS trust checks](../.github/scripts/backup-restore-device-trust.mjs)
  use normal hostname/CA verification plus the mobile P-256 point pin and a fresh
  Ed25519 pairing challenge. Preserved restore now keeps the TLS key while
  reissuing the leaf certificate, fixing a silent pin change. Local real TLS
  tests reject a wrong pin before HTTP dispatch and a changed identity proof.
  The Docker driver individually denies outbox-revoked, post-capture-revoked,
  late-revoked and unreviewed tokens, then proves new pairing after new identity.
  These backend checks do not establish native-device acceptance.
- **A06/A18:** [key replacement](BACKUP_KEY_REPLACEMENT.md) adds administrator
  confirmation, cancellation before confirmation, new repositories, durable
  publication retry, exposed-generation CA retirement and replay refusal.
  Revocations fan out to every catalogued key generation before acknowledgement.
  Route tests repeat administrator/member/agent denial for the new routes.
  Docker acceptance also creates a real helper-signed original receipt, retires
  that exact generation through the privileged helper, preserves an unrelated
  file and verifies the replacement receipt against the current CA.
- **A07/A24:** the root-only installer now implements `--rotate-identity` with
  exclusive installer/helper locks, durable checkpoints, disabled container
  restart policies during publication, certificate/key validation, transactional
  credential revocation and publication retry. [Installer tests](../deploy/bin/verity-rotate-identity.test.mjs)
  use actual OpenSSL with simulated Docker/root effects;
  [database tests](../packages/server/src/backup/identity-rotation-database.test.ts)
  execute the actual installer SQL against the migrated PostgreSQL schema.
  [Rotation history](../packages/server/src/backup/restore-identity-history.test.ts)
  rejects retired CAs and missing/corrupt history before preserved restore;
  explicit `--new-identity` remains available. Docker acceptance invokes the
  real privileged rotation, rejects the old pin/tokens, pairs again and rejects
  preserved restore of the retired snapshot. Offline pins and external copies
  are not invalidated remotely; native pin reset remains open.
- **A11/A40:** the committed public
  [v1 installation fixture](../packages/server/src/backup/fixtures/v1-installation.json)
  is unpacked without regeneration and passed through `probeSnapshot`, actual
  extraction, identity verification and PostgreSQL import. Format 1 is the only
  supported format. The historical fixture uses its fixed minimal schema and a
  test release-verification adapter; pinned release migration/provenance remain
  covered separately by existing production adapter tests and Docker acceptance.
- **A33/A34:** existing trial/router/runtime and populated sanitizer tests remain
  required; these additions do not turn their remaining activation/native gaps
  into completed evidence.

Additional detected mutations are archived in
[content](backup-content-mutations.json),
[key replacement](backup-key-replacement-mutations.json),
[identity rotation](backup-identity-rotation-mutations.json), and
[TLS/history](backup-device-trust-mutations.json) ledgers. Each retains restored
source/test digests. Full historical A41 coverage remains open.

## 1a: Capture, recovery and prerequisites

| ID | Requirement | Status | Evidence and remaining proof |
| --- | --- | --- | --- |
| A01 | Local host destination, marker before writes, capacity check and fail-safe replaced mount | Test-covered | E07; E02 also uses an actually constrained staging filesystem. Physical backup-disk exhaustion is not that staging-space test. |
| A02 | Installer installs paired mounts, helper, installation ID and read-only DB role; repairs existing hosts | Partial | E09 and [managed bootstrap tests](../packages/server/src/self-update/managed-bootstrap.test.ts) cover prerequisites/mount repair; E02 covers clean installation. Complete existing-host repair and destination relocation acceptance remains to map. |
| A03 | Product explains local-disk protection and coordinated off-host copying | Partial | ADR and E22 document copied-directory recovery. Phone setup/help does not yet expose the full explanation. |
| A04 | Recovery key checksum, paste-back confirmation, abandoned setup disposal; no master-password decryption alternative | Test-covered | E05/E09 exercise full-key confirmation, wrong keys, cancellation and non-decrypting host state. Copy/save/print UI remains absent. |
| A05 | Host stores recipient/signing/fingerprint state outside snapshots; sealed/unattended capture works | Partial | E03/E05/E09 cover state separation and capture without exporting a secret-store key. Add explicit end-to-end sealed restart capture assertion. |
| A06 | Replacing recovery key starts a new repository; exposed key immediately retires old CA material | Test-covered | Confirmed replacement, cancellation, failure/restart, separate generations, retirement ordering and replay refusal are covered by the backend follow-up above. Actual privileged-host deletion acceptance remains distinct from shell simulation. |
| A07 | `--rotate-identity` replaces live identity and revokes devices; historical identity requires explicit trust reset | Partial | Implemented with durable root checkpoints, transactional revocation, restart fencing and retired-snapshot guards. New real-host Docker assertions await their own CI result. External copies and offline saved trust cannot be invalidated remotely; native reset acceptance remains open. |
| A08 | Signed, encrypted manifest covers object IDs/digests/lengths, repository, sequence and format before use | Test-covered | E05/E06 verify authenticated parsing, replay/path rejection and metadata corruption. Dedicated encrypted-but-unsigned adversarial envelope remains A26. |
| A09 | Encrypted host-key bundle recoverable without local index; host keys cannot decrypt snapshots | Test-covered | E05 includes `restores host keys from the encrypted repository bundle without a local index`; E06 destination-only restore. |
| A10 | Streaming authenticated encryption detects missing/reordered data and bounds parsing | Test-covered | E05 truncates frames, reorders authenticated payload bytes and checks metadata bounds. This is not a semantic reordered-manifest fixture. |
| A11 | Every format has a committed fixture; unknown formats fail safely | Partial | E05 reads committed v1 fixture; format parser rejects other versions. The new local verifier test rejects an authenticated future format; the follow-up committed v1 installation fixture now runs through actual probe/extraction/import with a fixed historical schema. Full pinned release migration is a separate adapter/CI assertion. |
| A12 | Complete database, workspaces, sessions, knowledge, scope/release/schema/lifecycle metadata | Partial | E01/E03/E04 cover a real subset and inventory ownership including hidden/orphan data. The follow-up Docker fixture adds four project states, all linked worktrees and knowledge originals/revisions with independent PostgreSQL content tests; new Docker assertions require their own CI run. |
| A13 | Fixed exclusions with sizes; project sizes, >2 GB and unsupported-layer/mount/provider-state warnings | Partial | E03 checks dependency exclusions and filesystem inventory. Complete warning/size assertions and product presentation remain to verify. |
| A14 | Read-only per-table ordered COPY in repeatable-read transaction; preserve encrypted secret metadata | Partial | E04 and E16 test export/import and metadata preservation. Audit every production export/role invariant separately before treating the whole contract as demonstrated. |
| A15 | Content-defined incremental objects, fresh encryption, manifest-last publication and reserved sequence | Test-covered | E05/E06 cover chunk resynchronization, random ciphertext, failed-run nonpublication and sequence nonreuse. Small-edit byte measurements remain A35. |
| A16 | Lifecycle snapshot/freeze coordination, live change detection, no global drain or wakeup | Partial | E03 tests leases and changing-source retries. Large-installation freeze duration and explicit no-wakeup surface assertions remain. |
| A17 | Root helper encrypts CA to confirmed recipient; receipt authenticates CA and recipient | Test-covered | E09/E14 include receipt recipient substitution and actual OpenSSL key/certificate checks. Production policy-gateway restrictions are outside this raw-Docker-socket implementation. |
| A18 | Signed revocation journal, queued writes, sequence gaps and retirement floors survive retries | Test-covered | E13/E11 exercise unavailable destinations, missing/replayed entries and interrupted retirement. Full lost-off-host-history scenario still needs Docker evidence. |
| A19 | Original host/index absent: copied directory plus recovery key/master password restores content | Demonstrated | E01/E02 use a separate fresh daemon and reject original host data/index. That historical run covers one project, linked worktree, insight, setting and credential; the expanded fixture above requires a new demonstrated run. |
| A20 | Active, sleeping and paused projects; all worktrees and knowledge originals/revisions restore | Partial | E01 seeds one active project/linked worktree; E03 adds paused/active capture coverage. The expanded matrix is implemented and locally test-covered; its original-host-free Docker run is pending. |
| A21 | Preserved identity permits reviewed devices to reconnect without pairing | Partial | E01 `verify-api` unlocks secrets and accesses `/settings` with the original retained token. Native TLS/device reconnection is not exercised. |
| A22 | New identity rejects all old credentials and requires new pairing | Partial | E01/E02 assert zero retained device tokens and old-token HTTP 401. The follow-up driver now tests successful installer-code redemption and password-based device enrollment over pinned TLS; its Docker result is pending. |
| A23 | Revoked-after-snapshot devices remain revoked; unknown-history devices blocked until explicit keep | Partial | E13 verifies review rules and final journal/outbox recheck; E01 seeds post-capture revocations. Individual actual API denials, same-host rollback and copied-journal-loss matrix remain open. |
| A24 | Wrong CA private key/certificate or TLS leaf/key mismatch is refused | Test-covered | E14 real OpenSSL fixture rejects mismatches and does not leave a raw CA file. Separate-daemon negative case and pairing-key binding negative proof are not present. |
| A25 | Wrong key, damaged/truncated objects and unsafe paths fail without replacing last good snapshot | Test-covered | E05/E06/E07 and E02 cover these across distinct scopes. Preserve failure-specific coverage when adding new formats. |
| A26 | Valid recipient encryption without a valid manifest signature is rejected | Test-covered | The additional restore-authenticity test constructs decryptable unsigned and foreign-signed envelopes, rejects them in repository/installer verification and preserves the last good snapshot. Local evidence; not part of baseline CI. |
| A27 | Unsupported release/architecture/capability rejected before live mutation | Test-covered | E15 and E02 unsupported recovery image. This is not unknown backup format (A11), nor the same-host architecture acceptance (B09). |
| A28 | Hostile Git config, config.worktree and hooks never execute in main/linked repositories | Test-covered | Additional production capture/restore with real Git includes main and linked-worktree hostile configuration/hooks, an execution sentinel and a malformed included config. Sanitization-bypass mutation is detected. Scope is the fixture commands, not every Git command. |
| A29 | External gitdir/commondir/symlink pointers refused before Git; alternates flagged | Test-covered | E08 rejects external/symlink/unlisted restore pointers before invoking Git and flags and drops alternates; the additional shared-clone test explicitly detects missing borrowed-only history. |
| A30 | Staged-only blobs, stash and reflog survive self-contained restore | Test-covered | Additional actual capture/source-free restore reads an index-only blob after its working file was removed, stash content and a reset-away reflog commit; omission mutations detect lost index/stash/log content. |
| A31 | Concurrent sandbox `git gc` is detected and retried | Test-covered | Additional GC test synchronizes real repacking/removal after stat, observes two freezes and verifies the captured committed object. This covers that deterministic race, not every possible GC interleaving. |
| A32 | Only administrators may setup/run/restore/probe/delete; no agent/project authority | Partial | E20 checks every registered backup route, including actor denials after availability opens; local restore requires root plus recovery factors (E22/E17). Delete/partial-restore routes and full agent/project denial matrix are not implemented/proven. |
| A33 | Trial blocks ordinary APIs, pairing, work, updates, scheduler and helper | Partial | E17 isolates the Unix socket; strengthened runtime tests restrict authority-bearing mounts/environment and trial tests reject normal operations with a valid recovery token. E02 runs real trial. Explicit assertions for every forbidden runtime surface remain to map. |
| A34 | No preview/capability/enrollment recovery/queued work revival; secret store stays sealed | Partial | E16 sanitizes ephemeral state and E01 asserts no running work. Additional preview/capability/grant/job fixtures prove nonempty reset independently of the reset list; there is no separate enrollment-recovery table in the current migrated schema. Every current reset table is seeded, and generation/meeting resets are asserted; full activation-surface coverage and future schema semantics remain distinct limits. |
| A35 | Small edits share objects; transferred and retained bytes measured | Missing evidence | E06 repeats identical input and proves ciphertext reuse. It does not measure storage/transfer after a small edit. |
| A36 | Large-installation lifecycle lock duration measured without reflinks | Missing evidence | No recorded benchmark/harness located. Record dataset, filesystem, disabled-reflink method, lock duration, bytes and resource usage. |
| A37 | Two restored hosts use distinct repositories and never prune each other | Partial | E19 preserves source repository; E11 tests ownership refusal. No two-restored-host lifecycle/pruning acceptance found. |
| A38 | Isolated staging, durable trial/accept/abort, previous installation startable after failure | Demonstrated | E02 kills actual workers across preparation/publication/acceptance/abort, checks previous-volume sentinels and retries rollback; E18 covers collision/restart details. Scope excludes pre-update same-host rollback. |
| A39 | Acceptance publishes authenticated CA material before enabling new backup repository | Test-covered | E19 tests ordering, partial retry/idempotency, source preservation and unrelated-state refusal; E02 exercises bundled installer acceptance. |
| A40 | Probe verifies all objects, imports DB and checks Git without changing live installation | Partial | E20 plus [probe runtime tests](../packages/server/src/backup/probe-runtime.test.ts) cover isolated execution and verification state. The immutable format1 installation fixture now exercises probe/extraction/import. Pinned historical migration and app initiation remain separate evidence boundaries. |
| A41 | Each guard is deliberately broken before it is trusted | Partial | The local ledger archives 23 detected mutations for this security package, source digests and restoration checks. Historical guards still lack a complete per-guard ledger; see mutation evidence below. |

## Operations, 1b and 1c

| ID | Requirement | Status | Evidence and remaining proof |
| --- | --- | --- | --- |
| O01 | Six-hour default, hourly-to-daily policy, one catch-up, no overlap, bounded timeout and backoff | Test-covered | E10 tests reservation, restart backoff, pause races and six-hour abort; E20 validates policy inputs. Pre-update one-hour/initial-full-run behavior is B02. |
| O02 | Recover only owned stale staging; low CPU/IO priority without renicing the Server | Test-covered | E10 includes a killed kernel-lock holder and worker/subprocess priority assertions. Large-installation load measurement remains A36. |
| O03 | Retention: 48 hours, 7 daily, 4 weekly, 6 monthly and last two pre-update snapshots | Partial | E11 uses 240 days but checks selected membership and a loose count, not the exact expected six-month set. Add complete boundary/set assertions. |
| O04 | GC honors retained references, leases/grace; missing ownership/references fail closed | Test-covered | E11/E06 check reference corruption, shared objects, grace, concurrent publication, ownership and replaced-directory rejection. |
| O05 | Alert conditions fire/clear: stale snapshot, failures, destination, identity, old probe | Partial | E12/E07/E09/E10 test service conditions, sanitized persistence, clear/retry and administrator targeting. Full phone display and every condition end-to-end remain absent. |
| B01 | Snapshot after preflight and before creating-standby while old Server serves | Not implemented | E21 currently advances directly to `creating-standby`; no backup request in that transition. |
| B02 | Update waits by default; one-hour timeout except initial full backup; failure reason displayed | Not implemented | No corresponding update coordination/product flow located in E21/E22. |
| B03 | Explicit administrator “Update anyway” records unbacked update | Not implemented | No override/history contract located in inspected update flow. |
| B04 | Automatic updates never override backup gate | Not implemented | Requires B01–B03 plus automatic-path negative coverage. |
| B05 | No backups or paused backups permit update with durable history note | Not implemented | Requires explicit update-history semantics and tests. |
| B06 | Same-host rollback restores pre-update DB/data, identity/devices and pinned release | Not implemented | Current restore creates a new installation/repository (E19/E22). E02 abort rollback is a different operation. |
| B07 | Same-host rollback preserves installation ID and current keys/index/target/repository | Not implemented | Needs a distinct preservation path; fresh-host accepted initialization is not reusable unchanged. |
| B08 | Apply revocations and set automatic-update hold before starting same-host restore | Not implemented | Fresh-host revocation coverage E13 does not prove this missing same-host path. |
| B09 | Reject architecture/downgrade incompatible with current backup state/format/envelope before mutation | Partial | E15 rejects unsupported native recovery releases; no complete same-host preservation/format downgrade test exists. |
| B10 | Rollback prompt explains changes after snapshot are absent | Not implemented | Requires update/rollback UI; docs alone do not satisfy prompt acceptance. |
| C01 | Phone setup/status/probe, installer-required explanation and key-risk guidance | Not implemented | Backend E09/E20 exists; no corresponding backup screen located in `apps/mobile`. |
| C02 | Snapshot list with key generation, retention settings and persistent alerts | Not implemented | Partial backend retention/alerts exist (E11/E12); public UI and complete management API absent. |
| C03 | Confirmed single deletion; shared objects survive | Partial | E11 proves internal pruning preserves shared objects. No confirmed user deletion flow in E22. |
| C04 | Pause stops schedule/pre-update without deleting data | Partial | E10/E20 cover scheduler pause; pre-update integration B01–B05 is absent. |
| C05 | Typed delete-all removes only own repositories, CA files and journal entries | Not implemented | No complete public deletion flow located; internal generation retirement is not delete-all. |
| C06 | Restore project as new project and download a single file | Not implemented | E22 exposes setup/policy/probe, not partial restore. |
| C07 | Probe/partial-restore recovery key never reaches disk, arguments or logs | Partial | E20 checks key-free durable jobs and sanitized errors; installer uses bounded stdin. Additional local tests scan owned probe fixture/job files, captured console/installer output and installer jq/Docker arguments across phase boundaries, failure, retry, cancellation and reopen. Partial restore and unrestricted host-wide logs/crash dumps are outside that evidence. |
| C08 | Unverified until probe succeeds; remind after 90 days | Partial | E20 tests durable verification outcome and age threshold; phone status/display absent. |

## Mutation evidence and limits

The baseline development history reported deliberate failures for retry caps,
staging ownership, worker priority, alert deduplication, generation retention,
journal floors, full-destination startup, ancestor-directory checks,
per-deletion pause, PID-qualified directory synchronization, partial push
retry deduplication and rollback container-name ordering. These reports are
useful leads, but the inspected repository does not contain a complete archived
ledger tying every guard to an exact mutation, command, failing assertion and
restored passing revision. They are **reported, not independently archived
per-guard acceptance** in this matrix. Existing ordinary regression tests must
not be relabeled as mutation results.

To close A41, record the guard/test, baseline commit, exact temporary mutation,
command, expected failing assertion, observed result and restoration check for
each guard. The linked local ledger now records the guards added by this security package, not every historical guard. Keep secrets and production data out of the artifacts. Mutations
must be local and restored before further changes or publication.

## Remaining work in dependency order

1. Run the expanded source-free Docker content/TLS/pairing/rotation scenarios on
   the release candidate, complete native device/pin-reset acceptance and remaining
   trial activation-surface mapping; preserve the scoped mutation evidence.
2. Implement pre-update coordination and its default hold, administrator override,
   history and automatic-update restrictions (B01–B05).
3. Implement the distinct same-host snapshot rollback with backup-state preservation,
   revocations, update hold and downgrade/architecture preflight (B06–B10).
4. Add reproducible small-edit storage/transfer and no-reflink freeze measurements,
   exact retention-set tests and two-restored-host ownership acceptance.
5. Implement backup app/management and partial restore, including negative authority
   tests and disk/log secret instrumentation (C01–C08).
6. Reconcile every row and its mutation evidence on one release candidate, run the
   full acceptance suite, and only then assess opening the global gate.

This ordering describes remaining work; this evidence audit does not authorize
or implement those packages. Remote destinations, hosted Uplink functionality
and later optimization phases are outside this v1 matrix.
