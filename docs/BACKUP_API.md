# Backup administration API

These administrator-only routes implement setup, status and restore probes
of [ADR 0025](adr/0025-encrypted-backup-and-installer-recovery.md). The recovery
acceptance gate is closed until the complete fresh-host round trip is verified.
A registered route does not imply that backups are available.

Every request requires a paired device and current installation administrator
authority. Project credentials and agent capabilities grant no access. Responses
use `Cache-Control: no-store`.

| Method and path | Request | Successful response |
| --- | --- | --- |
| `GET /api/backups/status` | None | Availability and, when available, configuration status |
| `POST /api/backups/setup` | None | `{ id, recoveryKey, expiresAt }` |
| `POST /api/backups/setup/confirm` | `{ id, recoveryKey }` | `{ ok: true }` |
| `POST /api/backups/setup/cancel` | None | `{ ok: true }` |
| `PATCH /api/backups/policy` | `{ paused: boolean }` | `{ ok: true }` |
| `POST /api/backups/probes` | `{ recoveryKey }` | `202` with a key-free job record |
| `GET /api/backups/probes/:id` | None | Current or most recent job record |
| `POST /api/backups/probes/:id/cancel` | None | Job record after requesting cancellation |

Status returns `{ available: false, reason: "recovery-validation-pending" }`
while the acceptance gate is closed. Once that gate opens, hosts without the
installer prerequisites return `reason: "installer-required"`. A runtime initialization
failure returns `reason: "runtime-unavailable"`; ordinary server operation continues. An available
installation returns `available: true`, `configured`, and `alerts`; a configured
installation also returns `paused`, `lastSuccess` (Unix milliseconds or null),
`lastProbe` and `probe`. `lastProbe` is null until a complete probe succeeds, then
contains the authenticated repository, sequence and completion time. It describes
that snapshot, not later backups. `probe` contains the current or most recent job,
or null. A `probe-overdue` alert appears 90 days after the last successful probe,
or 90 days after setup when no probe has succeeded.

Setup returns the recovery key once. The client must let the user save it and
require them to enter it again before confirmation. Do not persist it in client
settings, analytics, logs or navigation state. Setup expires after ten minutes;
starting again replaces the pending candidate. `expiresAt` uses Unix milliseconds.
Confirmation activates host-only backup state only after the key is verified and
the installer helper has supplied authenticated encrypted CA material. No
recovery key is stored in the host state or snapshots.

Confirmation and policy objects reject unknown fields. Mutating requests have a
16 KiB body limit. Invalid input returns 400, a non-administrator returns 403,
unavailable backup operations return 503, and operation conflicts or failures
return 409 with a generic error. The global authentication gate rejects missing
or revoked paired-device credentials before these handlers run. Clients must not
infer successful setup from a failed request; reload status before retrying.

This contract does not expose restore, device review or manual capture yet.
These operations require their complete server and installer adapters.

## Restore probe jobs

Start accepts only a recovery key and selects the newest committed snapshot of
this installation by repository number and then sequence. Names select a
candidate; its header, manifest and objects must authenticate. An invalid newest
candidate fails the job without silently falling back to an older snapshot.
A successful start returns `202` once the job metadata is durably recorded;
this is acceptance of work, not successful verification.

The job contains `id`, `installationId`, `status`, `phase`, `startedAt`,
`finishedAt`, `snapshot` and `error`, plus the record format version. Times use
Unix milliseconds. `snapshot` is null until selection completes. Phases are
`selecting`, `release`, `staging`, `identity`, `git`, `database`, `revocations` and
`cleanup`; they are milestones, not percentage estimates. Status is `running`,
`cancelling`, `succeeded`, `failed`, `cancelled` or `interrupted`. Errors contain
only `probe-failed`, `cleanup-failed`, `timed-out`, `interrupted` or null.
There is one bounded current/last record rather than an unbounded job history;
unknown or replaced IDs return 404, and malformed IDs return 400.

Only one backup/setup/probe operation holds the service's process and filesystem
operation lock at a time. A conflicting start returns 409. Cancellation is
cooperative and continues to hold the slot until resources have been removed;
once the final success commit begins, cancellation returns the current state.
Execution has a six-hour limit. Shutting down aborts active work and awaits
cleanup. Restart never resumes a probe: it cleans deterministic resources owned
by the validated installation/job IDs and marks unfinished work `interrupted`.
Failed cleanup prevents another start until cleanup succeeds.

The recovery key is passed only to active in-process decryption. It is never
written to the job record, snapshot, Docker environment or command, logs or
response. Request-body and execution references are released after dispatch and
completion; JavaScript strings do not offer guaranteed memory erasure. Clients
must apply the same memory-only handling used for setup confirmation.

`lastProbe` changes only after extraction/authentication, identity and Git
validation, disposable database import, revocation-journal inspection and
resource cleanup have all completed. Failures preserve the previous success.
Revocation findings remain findings: a successful probe never authorizes
restored devices or bypasses installer device review. All endpoints remain
behind the recovery acceptance gate until the complete fresh-host proof passes.

## Disposable migration worker

The server image exposes `backup-probe-migrate` as a separate one-shot command.
It reads `VERITY_BACKUP_PROBE_DATABASE_URL` and `VERITY_BACKUP_PROBE_SCHEMA`,
requires a `verity_probe_<32 lowercase hex characters>` database with no user
relations, and verifies the actual connected database name before migration.
The requested and resulting schema must exactly match the image's current
migration generation. It closes the connection and exits without starting the
control plane, scheduling work, or opening HTTP listeners.

The internal worker adapter selects the image digest and native architecture
from authenticated capture metadata. It mounts no live data, uses a read-only
root filesystem, and removes the worker on success, failure, timeout, or abort.
The internal database adapter provisions a separate throwaway PostgreSQL cluster
using the PostgreSQL pin bundled with the snapshot image. It requires a space
check on the Docker data filesystem before database allocation, generates separate random
credentials, waits for readiness, migrates through the pinned worker, and removes
the cluster and its anonymous volumes after import, including failed runs.
It publishes no database port and mounts no live volumes. The caller and worker
must share the configured private Docker network with the throwaway database.
The internal release-check adapter verifies a historical signed release envelope
with the official Sigstore release-workflow verifier. Its image digest, native
architecture, version and exact migration generation must match the authenticated
snapshot. Loading and verification have a bounded timeout and honor shutdown.
By default it loads the versioned `candidate-stable-v<version>-<architecture>`
artifact published alongside the release, rather than consulting the current
moving channel. Missing historical evidence fails closed; a republished tag that
names another image is rejected by the signed digest comparison. An envelope
loader may also be supplied for retained release evidence.
The production runtime composes these adapters for probe jobs. These adapters
alone do not satisfy the recovery acceptance gate.


The default capacity check runs a short container from the same pinned PostgreSQL
image with networking disabled. It reads available KiB on the image's data volume
using `df -Pk`, rounds the byte requirement up, and refuses insufficient or
unverifiable capacity. It uses no live mounts or database credentials and removes
the container and anonymous volumes on completion, failure, timeout, or shutdown.
The database estimate includes a 256 MiB reserve; staging space is checked
separately. This is a preflight estimate, not a reservation against other Docker
workloads consuming space concurrently.

## Full installer recovery

Full recovery is an installer operation, separate from these paired-device API
routes. See [Installer recovery](INSTALLER_RECOVERY.md) for explicit snapshot
selection, private key entry, restricted trial, device review, acceptance and
abort. The restricted runtime exposes only installer-local Unix-socket
administrator authentication and device inspection/review; it does not register
the normal application API or start background workers. Its short-lived recovery
session is consumed by completed device review and is never a paired-device
token. Ordinary server startup refuses a pending recovery marker.
