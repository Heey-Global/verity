# ADR 0008 — Managed Verity Server Self-Update

**Status:** Accepted · **Date:** 2026-07-13

> The first shipped implementation deliberately narrows D4 and D12, and reaches
> D7's quiesced standby and D8 by a different route than the one described below.
> See
> [Addendum — promoted-container update path](#addendum--promoted-container-update-path-2026-08-10)
> for what it does instead and what that costs.

## Context

Verity can detect newer Sandbox images and recreate project containers, but it
cannot update its own Server from the mobile app. The reference Compose
deployment currently gives the `verity` container both the public host port and
the stable internal DNS name used by Sandboxes. It also publishes a
version-matched `verity-agent-seed` directly into a live host directory before
the Server starts.

Replacing that container from inside itself is not a reliable transaction:

- once stopped, it cannot finish or roll back the operation;
- Docker port bindings cannot be transferred to a preflight container;
- cloning `docker inspect` is not a declarative deployment model and can lose
  host bind IPs, mounts, group membership, restart policy, or network aliases;
- a normal candidate runs migrations before listening, while `/healthz` proves
  only process liveness and version;
- `docker compose up` remains a competing desired-state owner;
- Server startup seals the secret store, temporarily breaking signing and
  GitHub-token brokerage even if project Runners continue;
- updating the live agent-seed directory in place can change executable bytes
  underneath running Sandboxes.

[ADR 0006](0006-runner-in-sandbox-extraction.md) is the prerequisite that will
make project agents survive a Server process replacement. This ADR defines the
deployment transaction that uses that capability while preserving app
connectivity, broker identity, and a tested rollback path.

## Scope

Self-update is one two-phase transaction. It first promotes the managed Server,
then moves the stable Gateway, Agent Gateway, Updater, agent seed, and managed
Control Plane Runner onto the same immutable image. The target-image Updater is
the process that marks the journal complete; a promoted Server with stale
companions remains an in-progress, crash-resumable operation.

Self-update is available only in an explicit **managed deployment**. Custom
images, custom orchestrators, and operator-pinned Server references remain
operator-managed and report self-update as unsupported rather than silently
overriding desired state.

Moving an existing direct-Compose installation into managed mode is a one-time
host-side GitOps migration. It installs the Gateway/Updater topology, writes the
initial deployment spec, records a unique managed-deployment ID, and adopts the
current official Server digest. Until that marker, a compatible Gateway and
Updater, and an updater-owned spec all exist, the API reports `unsupported`.
Operator policy pins disable update availability; internal managed specs remain
digest-pinned for reproducibility.

## Decision

### D1 — A stable Gateway owns external identity

Add an unprivileged `verity-gateway` service as the stable front door:

- it owns the configured host binding for public port 8082;
- it owns the `verity` network alias used by Sandboxes;
- it exposes the internal broker listener on 8083 without publishing it to the
  host;
- it proxies WebSocket upgrades and normal HTTP to exactly one active Server;
- public and internal listeners remain distinct so `/internal/*` cannot become
  reachable through the public port;
- it has no Docker socket, registry credentials, database credentials, or
  secret-store key.

Project networks attach to the stable Gateway rather than the replaceable Server.
The Updater performs those network operations on request from the authenticated
control plane. A Server replacement therefore does not change Sandbox DNS or
broker URLs.

The Gateway switches both public 8082 and broker 8083 routes as one backend
generation from an authenticated local control channel. Before switching it
enters maintenance: new mutations are rejected, existing WebSockets receive a
retryable close and are drained with a bounded timeout, and in-flight broker
requests finish or fail transiently. A backend pointer affects only new
connections, so this drain is mandatory. Existing app state is retained and
clients reconnect through the same URL.

### D2 — The Updater is the sole managed-Server owner

Add a long-lived `verity-updater` sidecar. In managed mode, Compose starts the
Gateway, Updater, PostgreSQL, and supporting services; the Updater reconciles the
active Server container from a versioned, persistent `ServerDeploymentSpec`.
Compose and the Updater do not both own the same Server container.

**Amended by D14.** "Compose starts … PostgreSQL" was read for two years as a
statement about ownership, and it is not: Compose starts the database once and
then never runs again on an installed host, so nothing ever moved its image.
D14 gives the Updater that one component, for digest bumps inside a major only.

The deployment spec is explicit and allowlisted. It covers the Server image
digest, environment overrides, mounts, user/group configuration, restart policy,
control network, architecture, and security options. The Updater never attempts
to reconstruct desired state by blindly cloning `docker inspect` output.

The host-side managed-mode migration creates the spec in the updater volume. It
is schema-versioned, checksum-protected, atomically replaced, and writable only
by the Updater principal. Secrets are external credential/mount references, not
literal environment values stored in the spec. Disaster recovery reconstructs
the same spec from the GitOps source plus its selected digest.

The Updater is host-root-equivalent because it controls Docker. Treat it as a
small trusted computing base:

- no public or Sandbox-reachable HTTP API;
- commands arrive through an authenticated Unix socket on a private shared
  volume;
- operations are hard-coded to the managed Compose project, labels, and
  allowlisted resources;
- no generic image, container, exec, mount, or network operation is exposed to
  the app or Server;
- registry credentials and secret material never enter logs or the journal.

**Superseded — dynamic project networking.** This decision originally added one
narrow RPC on top of the list above: attach or detach the expected Gateway to a
network carrying the matching `verity.project-id` label and canonical alias,
validated against deployment ID, project ID, network labels, Gateway identity and
active generation, and reconciled on Updater startup. It was written on
2026-07-13 and never implemented, because two weeks later the project relay
removed the reason it existed. `feat(relay)!: require project relay isolation`
and `feat(relay)!: remove legacy project transport paths` made per-project
network isolation unconditional and deleted the shared-network transport: a
Sandbox is attached only to its own project network, its relay is attached to
that same single network, and everything it needs from Verity arrives over Unix
sockets the relay exposes — including Claude egress, which addresses the relay's
own container name rather than any shared origin. Nothing inside a project
network resolves the Gateway, so there is nothing for an attachment to enable.

Building it now would also reverse a decision taken deliberately elsewhere:
`docs/TEMPORARY_PUBLIC_PREVIEWS_IMPLEMENTATION_SPIKE.md` rejects "one shared
gateway attached to all project networks" for the high-security default, because
a single gateway compromise becomes a cross-project pivot once that container
belongs to every project network. The Gateway here would be the worse version of
that container: updater-owned, and the Updater is host-root-equivalent.

The refusal is therefore structural rather than merely absent, in three places
that each fail closed on their own — the deployment spec pins the container
network to `verity-net` and rejects any other value, the Updater control socket
exposes no network route, and the Docker client implements no connect or
disconnect verb at all. `self-update/project-network-refusal.test.ts` holds all
three together, so widening any one of them fails a test that says why.

Project-network creation remains a Server/provisioner concern, as it always was.

### D3 — The update journal survives the Server

The Updater owns a separate persistent volume containing an append-only or
atomic-replace journal. Every record has an update ID, monotonic generation,
target digest, previous digest, current phase, timestamps, and the immutable
labels of created resources.

Journal writes are synced before the corresponding destructive Docker action.
On Updater restart, reconciliation compares the journal with Docker reality and
continues or rolls back. It covers crashes after every stop, pause, create,
start, route switch, seed switch, and cleanup boundary.

The journal contains no bearer tokens, registry credentials, decrypted keys, or
master-password material.

The journal and private Updater protocol are the sole authority for the global
update lock and idempotency mapping across old and new Servers. Server DB/API
state is a projection of the journal, not a competing lock authority.

### D4 — Only verified official images are eligible

The Server resolves the official release reference once to an immutable digest.
The Updater independently verifies before pull/start:

- the registry/repository is the hard-coded official Verity Server repository;
- the manifest matches the host architecture;
- the image signature is valid;
- provenance binds the artifact to the expected Verity repository and release
  workflow identity;
- OCI version and revision labels match the requested release;
- the version is not a downgrade unless a separately authenticated recovery
  operation explicitly allows it;
- DB, Runner, Gateway, and Updater compatibility ranges include the running
  deployment.

The release workflow must publish signatures and provenance before the app
offers self-update. Digest pinning alone identifies bytes but does not prove who
published them. The app can select only an availability record returned by the
Server; it never submits an arbitrary image reference.

**Implementation.** The `publish-server` job in `.github/workflows/release.yml`
renders the channel document *inside the image it describes*
(`main.js release-channel-metadata`), so the advertised compatibility window is
`SERVER_COMPAT` from the shipped build rather than a copy maintained in YAML,
and the image refuses to emit a document it would not itself accept. The
document is signed keyless with cosign — no signing key exists to leak — and
published as an OCI artifact tagged `channel-stable-<arch>` on the Server's own
public ghcr package. The Verity repository is private, so release assets and raw
files would both need a credential the deployment does not have; that package is
already read anonymously for the sibling images.

The Server reads it back through `release-channel-artifact.ts` and verifies it in
`release-channel-verify.ts` against a compiled-in identity: issuer
`https://token.actions.githubusercontent.com`, SAN
`…/Verity/.github/workflows/release.yml@refs/heads/main`, plus the Fulcio
extensions for source repository URI, the immutable numeric repository id (which
a repository taking over the name does not inherit), the ref, and the built
commit. The commit binding is what stops a valid signature over one release from
being replayed onto another. The signature covers the exact published payload
bytes, carried through the envelope as base64, because verifying a
re-serialization would make the check depend on this process agreeing with the
publisher about key order and escaping.

The channel is consulted only by a deployment the Updater owns
(`VERITY_MANAGED_DEPLOYMENT_ID`, forwarded exclusively into the managed Server);
a legacy Compose deployment reports `unsupported` and never contacts it. The
release workflow builds `linux/amd64` only, so `channel-stable-amd64` is the one
published channel; any other host reports `unsupported` naming its architecture
rather than chasing a tag that does not exist.

### D5 — Preflight is a separate read-only entrypoint

The target image provides a preflight command distinct from normal Server
startup. It:

- parses and validates the deployment spec;
- verifies required mounts and filesystem permissions;
- performs read-only database connectivity and schema-compatibility checks;
- validates Runner, Gateway, Updater, and agent-seed protocol ranges;
- checks both public and internal listener configuration on private candidate
  ports;
- performs no migration, scheduler start, queued-turn recovery, Runner lease,
  token mint, or externally visible container action.

Starting the normal Server in a candidate mode is rejected: accidental startup
hooks or migrations would turn a validation step into a second active control
plane.

Managed mode therefore separates migration ownership from Server startup. The
normal managed Server and standby entrypoints never call `migrateToLatest()`;
the Updater invokes a dedicated migrator command from the verified target image.
Legacy/custom deployments may retain migrate-on-start until they adopt the
managed topology.

### D6 — Readiness is stronger than liveness

Public `/healthz` remains a cheap liveness and version probe. Cutover uses a
private, capability-protected readiness contract that verifies:

- the expected image digest, version, revision, and operation ID;
- database connectivity and compatible schema generation;
- public and internal listeners;
- leadership state and scheduler role;
- successful reattach or compatibility validation for every active project
  Runner;
- signing/token-broker readiness, including secret-key handoff state;
- a sustained healthy observation window rather than one successful request.

The Updater also checks the actual Docker image ID; it never trusts an HTTP
version string alone.

### D7 — One active Server, standby before activation

The new Server starts under a unique immutable update ID in **standby** state. A
standby may initialize non-mutating dependencies and serve private readiness,
but it cannot:

- accept public traffic;
- run schedulers or migrations;
- recover queued work;
- acquire Runner controller leases;
- mint credentials or perform project lifecycle actions.

Before activation, new Verity-self turns are blocked and any existing
Verity-self turn must become idle. Project turns continue under their Sandbox
Runners.

Activation is fenced by a durable control-plane generation. Only the active
generation can run schedulers or control Runners. Candidate inspection never
claims that generation.

The generation lives in PostgreSQL and is acquired with compare-and-swap only
after the prior Server has acknowledged `quiesced`. Every mutating endpoint,
scheduler, project action, and Runner attach is generation-fenced. Losing the
generation stops new mutations and releases subordinate Runner leases. The
Updater never writes this PostgreSQL row.

Rollback never restores an old generation number. The failed Server is first
paused/fenced; the previous Server resumes in standby, reinitializes its DB and
runtime dependencies, and CAS-acquires a **newer** generation. It then obtains
higher Runner lease epochs and passes readiness before the Gateway routes back.

### D8 — Intentional updates preserve the in-memory secret key

Runner survival alone does not preserve signing or GitHub-token brokerage: the
new Server would normally start sealed. For an intentional update, the standby
Server creates an ephemeral key pair and proves its operation ID, verified image
digest, and private-channel identity. The active Server encrypts its already
unlocked data key to that ephemeral public key.

The decrypted key exists only in an activation-gated memory slot in the old and
new Server. Possession while standby does not authorize secret use: decryption,
minting, and signing additionally require the current control-plane generation.
The handoff is bound to operation ID, ephemeral key, private-channel identity,
and the Updater-attested container digest. The Gateway and Updater never receive
the key, and it is never written to journal or disk. If the old Server is sealed,
the update waits durably for operator unlock.

A standby restart discards the ephemeral key and invalidates the handoff; it
must be repeated before switching. Journal recovery never treats key presence as
durable or recoverable state.

At cutover the old Server is paused, not destroyed, so its memory remains
available for rollback. After the new Server passes the success window the old
container is removed. An uncontrolled crash without a live handoff retains the
existing safe behavior: the replacement starts sealed and the operator unlocks
it.

Sandbox broker wrappers retry bounded transient connection failures with jitter
during the route switch. Authentication, permission, or policy failures are not
retried as transport failures.

### D9 — Database changes preserve N−1 rollback

Every image declares minimum, current, and maximum compatible schema generations.
The Updater blocks cutover before running target code when compatibility does not
include both the new and rollback Server.

Server migrations follow expand/contract:

- release N may add nullable/additive structures understood by N−1;
- destructive contraction occurs only after the rollback window has moved past
  N−1;
- CI starts N against an N−1 database, exercises writes, then starts N−1 against
  the resulting database and exercises the rollback contract;
- migration completion alone never proves rollback safety.

An update requiring a non-compatible migration is not eligible for unattended
self-update. It must use a separately designed maintenance/backup workflow.

For an eligible update, the Gateway first enters maintenance and the old Server
acknowledges `quiesced`: it has stopped schedulers and new requests, released
Runner/control-plane leases, drained work, and closed DB pools without cancelling
remote project turns. The Updater then journals `migrating` and runs exactly one
idempotent target-image migrator under a PostgreSQL advisory lock. Only additive
N/N−1-compatible migrations may run. After migration, isolated old-image and
target-image probes must pass their declared schema/read/write compatibility
contracts before activation; the quiesced old Server does not resume mutations.
A failed or interrupted migration aborts cutover; journal recovery reconciles
migration history and schema compatibility before retry or old-Server resume.

### D10 — Agent-seed publication is immutable and atomic

Managed mode removes the current one-shot in-place seed writer. The Updater is
the sole seed owner and publishes the target seed into a digest-addressed
directory in a dedicated volume/host layout. It verifies the manifest and
permissions, but staging never advances the active pointer. Each new Sandbox
resolves and records a concrete digest directory at creation; existing Sandboxes
keep the immutable seed path they started with.

The target seed remains staged but inactive throughout `stabilizing`; lifecycle
mutations are fenced, so no new Sandbox is created against the old pointer by
Server N. During `switching-seed` the Updater advances and verifies the pointer
while mutations remain fenced. That switch is reversible until the journal
records `succeeded`; a failure restores seed N−1 before rollback. `succeeded`
closes the Server rollback window and only then admits new Sandboxes against seed
N. This prevents creating a Runner N that rollback Server N−1 may not understand.

Garbage collection removes a digest directory only after no live Sandbox,
Runner, or container mount references it. Copying directly into the live
`/opt/agent-seed` tree is rejected because it exposes partial copies, retains
obsolete files, and changes executables under running agents.

### D11 — App/API state is server-authoritative and idempotent

The authenticated API exposes availability plus the Updater's durable operation:

```text
GET  /server/updates
POST /server/updates
```

`POST` accepts the selected availability generation/digest and an idempotency
key, not an arbitrary OCI reference. A persistent global update lock guarantees:

- same key + same target → same operation ID;
- competing target or stale current generation → `409 Conflict`;
- cancellation is allowed only before the switching phase;
- actor token/device identity is recorded in the audit event.

All device tokens may read availability/status. Starting an update additionally
requires fresh master-password verification, which mints a short-lived,
single-use update capability bound to device token ID, target digest, current
generation, and expiry. A UI confirmation alone is not fresh authorization.
`POST /server/updates` accepts the device token only from `Authorization` and the
update capability from a dedicated header; neither credential is accepted from
the URL. WebSocket query-token fallback is never valid for update routes. The
capability is consumed idempotently with operation creation.

Before this API ships, the global query-token fallback is narrowed to the actual
WebSocket stream upgrade path; ordinary HTTP routes never authenticate from a
query parameter.

The mobile app renders a fixed banner outside the scrolling project list. It
retains last-good state during switching, reconnects WebSockets with exponential
backoff and jitter, polls liveness through the stable Gateway, then reloads the
durable operation, projects, sessions, and secret status. Device bearer tokens
survive the Server replacement; secret-store unlock is a separate state.

### D12 — Cutover and rollback transaction

The Updater executes:

```text
requested
→ pulling
→ verifying-image
→ staging-seed
→ preflight
→ standby
→ ready
→ waiting-for-unlock | waiting-for-server-local-idle
→ draining
→ quiesced
→ migrating
→ post-migration-ready
→ switching
→ verifying
→ stabilizing
→ switching-seed
→ succeeded

quiesced/migrating/switching/verifying/stabilizing/switching-seed
→ rolling-back
→ rolled-back
```

Preparation and switching are:

1. verify every active project Runner is attachable by the target;
2. enter a durable non-error waiting state until the active Server is unlocked
   and every Server-local turn is idle;
3. perform the operation-bound in-memory key handoff;
4. journal switching intent and put both Gateway listeners into maintenance;
5. reject new mutations, retryably close and drain old WebSockets/broker calls,
   and obtain the old Server's `quiesced` acknowledgement;
6. release old Runner/scheduler leadership without cancelling project turns and
   close the old Server's DB/runtime services;
7. journal and run the exclusive compatible migrator, then run isolated old- and
   target-image schema compatibility probes;
8. pause the old Server, preserving its memory for rollback;
9. CAS-acquire a new control-plane generation, initialize the new Server's active
   services, and attach project Runners with higher lease epochs;
10. atomically route both public and broker listeners to the new generation;
11. verify sustained readiness and expected Docker image ID, then remain in a
    `stabilizing` rollback window;
12. journal and atomically advance the pointer to seed N, then verify the
    selected digest;
13. mark `succeeded`; only after the rollback/reference window may Server N−1
    and unreferenced seed directories be removed.

During `verifying`, `stabilizing`, and `switching-seed`, reads, stream recovery,
and already-running project turns continue, but project/Sandbox lifecycle
mutations return a retryable maintenance response. They are admitted only after
the matching seed pointer is committed and the operation reaches `succeeded`.

Rollback is also forward-fenced; it never decrements a generation:

1. return both Gateway listeners to maintenance and pause/fence the failed new
   Server;
2. restore the previous seed pointer if it had advanced;
3. unpause the old Server into standby, reinitialize dependencies, and recheck
   compatibility with the migrated schema;
4. CAS-acquire a newer control-plane generation and obtain higher Runner lease
   epochs;
5. pass sustained old-Server readiness, then atomically route both Gateway
   listeners back;
6. quarantine/remove the failed target only after old service is restored.

### D14 — The Updater keeps PostgreSQL patched, and only within a major

Nothing updated PostgreSQL. D2 says Compose starts it and the Updater owns the
Server, and that division left a third-party image with no owner at all: every
managed companion is reconciled to the Server digest the journal names because
every managed companion _is_ the Server image, and the database is not. Its pin
lives in `deploy/docker-compose.yml`, `verity-install` is explicitly one-shot,
and the Server never shells out to Compose — so on a stock host the digest the
first `managed-up` pulled is the digest that host runs forever. Renovate bumps
that pin, and the bump reaches an installation exactly once, at bootstrap. An
installed Verity had no path to a PostgreSQL security update at all.

The Updater takes it on. Deliberately only half of it:

|          | digest bump within a major                                       | major upgrade                    |
| -------- | ---------------------------------------------------------------- | -------------------------------- |
| data     | `PGDATA` untouched — PostgreSQL's documented minor-release contract | needs `pg_upgrade` or dump/restore |
| rollback | put the old digest back; a true rollback                          | restore from backup              |
| backup   | not required                                                      | hard prerequisite                |
| owner    | the Updater                                                       | the operator, explicitly         |

The CVE exposure lives entirely in the left column, which is also the column
that is safe unattended. A major-version difference is **refused**, reported,
and left to the operator; it stays blocked on Verity shipping a backup facility,
which does not exist and is not being invented inside a maintenance window.

**Distribution reuses the channel that already ships.** The pin travels as an OCI
label, `org.verity.postgres-image`, baked into the Server image by the release
workflow straight from the compose file Renovate bumps. It is the same idea as
`VERITY_BUNDLED_PROJECT_RELAY_IMAGE` — a non-Server digest carried by the image
rather than by the sealed spec — and deliberately not the same mechanism: D2's
spec/image comparison treats that variable as its ONLY exemption, and a second
one re-opens the disagreement that once stopped an Updater from starting its
Server. A label is read off the pulled target image and never enters any
container's environment, so it cannot take part in that comparison.

**Placement is the safety argument.** The swap happens in the cutover's existing
quiesce window — D12's `handing-off-key`, after the old Server has closed its
pools and released its control-plane session and before the candidate, which
waits on the activation gate before it opens any connection, has claimed
anything. In that window no process in the deployment holds a PostgreSQL
connection, so a Server misreading a restarting database and exiting is not
mitigated here, it is unreachable. It also costs no downtime that is not already
being spent: measured on a 1.0 GB `verity-db`, a graceful recreate is 1.1–1.6s,
and even a SIGKILL with 350 MB of unreplayed WAL is 7.3–9.1s, against a phase
budget in tens of seconds.

**Gates.** The image is pulled during preparation, never inside the window; an
image that is not already on the daemon means the swap is skipped rather than a
registry round-trip in a maintenance window. The major of the running server —
its own `server_version_num`, not a tag — must equal the major the target image
bakes as `PG_MAJOR`, in both directions, since an accidental downgrade destroys a
cluster as thoroughly as an unprepared upgrade. After the recreate the database
must accept a connection AND answer a query, which `pg_isready` does not prove;
on failure the previous digest goes back and is proven the same way, and because
the volume was never touched that is a rollback rather than a recovery. Every
outcome short of a database that cannot be proven to answer leaves the cutover
running: a Server update has no reason to roll back over a component it did not
change.

The delta between the running digest and the bundled pin is reported by the
Updater's control boundary at all times, not only during an update — the hosts
that most need to know they are behind are exactly the ones that are not
updating.

## Addendum — promoted-container update path (2026-08-10)

The decisions above describe a zero-downtime blue-green transaction. The first
implementation promotes an immutable generation-qualified container and switches
the Gateway to it. It originally stopped the old process before activation; the
old process now quiesces instead and stays alive, so the remaining gaps are D4's
narrower verification and D12's shorter phase list rather than a maintenance
window with nothing behind it.

The reason for the staging was sequencing, not disagreement. D7's standby
promotion needs the Gateway to be told which backend to route to; D12 assumes it.
Each is a component of its own. Waiting for all of them means a managed
deployment that can be updated only by hand, which is the condition this ADR
exists to remove. D8 turned out not to need the live quiesced process at all —
see below — and shipped before it.

### What is unchanged

D1 (Gateway owns identity), D2 (Updater is the sole managed-Server owner),
D3 (durable journal), D5 (separate read-only preflight entrypoint), and
D6 (readiness is stronger than liveness) are implemented as written, minus D2's
dynamic project-network RPC, which is superseded rather than outstanding — see
D2 above. So is the
crash model D12 rests on: every external action is preceded by its journalled
intent under a single-writer lease, each action is idempotent, and a SIGKILL at
any point re-runs at most one action. The sealed deployment spec remains the
authority — create-only, with a single supported mutation that advances the
image — so what survives a reboot is the spec, not the journal.

### D7 — container promotion and durable Gateway switch

Preparation creates `verity-managed-server-g<n>` from the complete sealed spec.
It starts immediately but first waits for a private, root-owned activation marker
on the Updater control volume. The Updater creates that operation-bound marker
only after durable `activating-candidate` intent and old-Server shutdown. The
candidate then waits on PostgreSQL's exclusive activation lock before migrations,
schedulers, recovery, or listeners. A PostgreSQL or host restart therefore cannot
promote a merely prepared candidate. The Gateway admits only the
unsuffixed bootstrap identity and canonical `-g<n>` identities.

Cutover enters maintenance, drains, and takes the control plane away from the old
Server — by directive where the old Server can follow one, by stopping its
container where it cannot. PostgreSQL releases
all of its shared mutation locks; the candidate then acquires exclusive authority,
CAS-advances the durable generation, downgrades to shared, and starts serving.
After private readiness the Updater switches the Gateway and leaves maintenance.
The selected backend is atomically persisted on the Gateway control volume, so a
Gateway restart cannot forget a completed route switch.

Consequences:

- Maintenance covers candidate activation and readiness. Old shutdown no longer
  contributes to it where the old Server quiesces (see below); where it does not,
  the interval is what it always was.
- The old container is retained throughout `observing-candidate` — running a
  quiesced process, or stopped. Rollback stops the candidate, brings the old
  generation back (by directive, or by starting the exact old container), lets it
  acquire a newer generation, verifies it directly, and durably switches the
  Gateway back. Success removes the old container only after the observation
  probe passes.
- The Updater has `network_mode: none`, so it cannot ask the new Server whether
  it came up. The verdict is obtained by starting the target image's own
  `readiness-probe` entrypoint as a throwaway container on the managed network
  and reading its exit code. `observing-candidate` repeats the probe after a
  quiet window, so a generation that boots and then dies still rolls back.

### D7 — the old Server quiesces instead of stopping

D7 asks for a live quiesced old process. It now exists, on the same channel D8
uses, and for the same reason: the Updater holds the Docker socket and runs with
`network_mode: none`, so it can never call into a Server. It **publishes** a
directive on its control socket and each Server polls for it — every 2 s while it
serves, every 250 ms once it is a standby.

The directive is derived from the journal phase on every read, which makes it
crash-safe for free: an Updater that dies mid-cutover comes back publishing the
same directive its phase implies. There is exactly one exception. `quiescing-old`
is journalled *before* the Gateway drains, and draining is the point — it is what
lets requests already in flight finish against a Server that is still listening.
So within that phase the cutover asks explicitly, once it has drained; every
later phase is journal-derived. That request lives only in the Updater's RAM, and
losing it is safe in the only direction that matters: the phase alone reads as
`serving`, so the standby resumes and the resumed cutover drains and asks again.

A Server that follows the directive gives up its serving stack in the ordered-stop
order — internal listener, embedded server, generation, keeper lock last, because
the successor can only take the exclusive lock once every shared hold is gone —
and keeps its process, its memory, and its unlocked key. Resuming is not undoing:
it builds a **new** serving stack and CAS-acquires a **newer** generation, as D7
requires, carrying its own key across the gap so a rollback does not end at a
master-password prompt.

Everything is a fallback. A Server from an image that predates the directive never
answers one, so the cutover waits a bounded window (15 s) and then stops the
container exactly as before; a rollback then starts that container again. The
readiness probe is unchanged and still decides, because "answered a directive" is
a weaker claim than "is serving" — a standby that answered but does not serve
fails the probe, is stopped, and leaves the next recovery attempt the cold start
it would have done anyway. The candidate ignores a directive naming its own
`VERITY_UPDATE_ID`, so a promoted Server cannot quiesce itself on the directive
written about the Server it replaced.

Consequences:

- Maintenance no longer contains a process stop, a container start, or a boot.
  What remains inside it is candidate activation and readiness.
- A rollback returns to a process that never lost its memory or its key, rather
  than to a container that has to boot and re-adopt one.
- The old process outlives the cutover only until `retireOld`, which removes the
  container; a quiesced standby holds nothing but a poll timer until then.

### D8 — the key is handed over before the old process is stopped

D8 ships, but not on the channel the decision describes. It assumed the handoff
happens *at* cutover, between a quiesced old process and its successor. With a
stopped old process that channel does not exist — and inventing a durable
side-channel for a key that is deliberately never at rest would trade away the
property D8 exists to protect.

What exists instead is a channel the two Servers already share: the Updater's
control socket. It gains a **mailbox** — RAM-only, owned by the listener, holding
at most one sender identity, one offer, and one envelope for one operation. The
Updater cannot call in (it holds the Docker socket and runs with
`network_mode: none`), so both Servers poll: the outgoing one every 5 s while
nothing is happening, every 500 ms once an update has a candidate; the standby
every 250 ms while it waits behind the activation gate.

The exchange itself is the one D8 specifies. The standby generates an X25519 key
pair that exists only in its own memory and publishes the public half. The
outgoing Server derives a shared secret (HKDF-SHA256), encrypts its unlocked data
key with AES-256-GCM, and signs the result with a per-operation Ed25519 identity.
Both halves are bound to the same AAD — operation ID, verified target digest, the
Updater-created container ID, and the offer nonce — and the Updater derives that
binding from its own journal, never from what a peer claims. An offer is
single-use, enforced where it can be — in the receiver, which consumes the
private half on `accept`, and in the sender, which answers a given nonce once.
Fetching the envelope from the mailbox deliberately does not consume it: both
Servers authenticate to that socket with the same token, so a destructive read
would let either of them leave the successor sealed just by asking first, and
would protect nothing, since the envelope opens for no one else. What retires an
envelope is a new offer or a new binding. A standby restart makes every envelope
sealed to it worthless anyway, because the private half is gone.

Two things about the shipped path differ from the decision above, and both are
deliberate:

- **The handoff runs while the outgoing Server is still fully serving**, during
  preparation, rather than at cutover. Nothing about it requires a quiesced
  process: the key is the same key before and after, and sealing it early means
  the promoted Server can adopt it the moment it wins the generation. Every
  property the decision asks for still holds — the key is never written down, an
  Updater doing its job relays only ciphertext, and *using* it still requires
  holding the current control-plane generation, because the promoted process
  claims the key only after the activation gate and the CAS. What the standby
  does while it waits is check the envelope, not open it: the sender's signature
  covers the offer it answers, so whether an envelope is worth opening is settled
  early — while a replacement can still be asked for — and the decrypted key
  comes into existence only on the far side of the gate, in the memory slot the
  decision puts it in.
- **The Updater is in the trust base, and a compromised one can read the key.**
  The outgoing Server seals to whatever offer the mailbox shows; it has no way to
  authenticate that public key as the candidate's, so an Updater that publishes
  an offer of its own gets the key. No primitive available here changes that —
  the Updater creates the candidate container, so every channel to that container
  is a channel it controls. Nor is it a boundary this handoff gives up: an Updater
  holding the Docker socket can already exec into the running Server, mount its
  volumes, or ship an image that captures the master password on entry. What the
  exchange does buy is confidentiality against everyone else — the Gateway, other
  containers on the network, and anything that later reads disk — plus protection
  of the *standby*, which pins the sender identity before it offers, so a
  substituted key fails the stored verifier and the new Server merely starts
  sealed.

Consequences:

- The promoted generation comes up **unlocked**, so signing and GitHub-token
  brokerage survive an update the operator asked for once.
- The handoff never blocks, delays, or fails a cutover. Every failure — no
  mailbox, an unreachable Updater, an untrusted sender, a refused envelope, an
  outgoing Server that is itself sealed — degrades to the previous behaviour: the
  new Server starts sealed and the operator unlocks it. The decision's "the update
  waits durably for operator unlock" is therefore not implemented; waiting would
  make an optimisation able to stall an update.
- A key that arrives is applied where an operator unlock applies one — after the
  Server is built, through the same callback — and given up again if that work
  fails. So the handoff can only ever reach code an interactive boot reaches, and
  a promoted Server that cannot put the key to use starts sealed instead of
  failing to start. The retry is the operator's unlock, which runs the same work.
- **The upgrade that first delivers D8 still lands sealed.** The Server being
  replaced is the one that would have to seal, and a release without the
  responder never answers the mailbox — so the promoted generation waits out its
  grace window and asks for the master password, exactly as it did before. Every
  update from that generation onwards hands the key over. This is the same
  degradation as any other missing counterpart, and it is why the exchange starts
  from the standby's offer rather than assuming anything about who is on the
  other side.
- **Rollback still lands sealed.** Restoring the old generation restarts the exact
  old container, and a restart has nothing to adopt. This is the same property
  under a different name: the key was never durable, so nothing can bring it back.
- An uncontrolled crash retains the existing safe behaviour, for the same reason.

The live smoke (`deploy/bin/verity-self-update-live-smoke`) covers both
directions against a real daemon: it sets a master password on the running
generation, asserts the store comes back **sealed** after a rollback, and asserts
`verity-managed-server-g2` reports **unlocked** after a committed cutover — with
the real `startUpdaterStatusServer` relaying between two containers, and no
password ever presented to the promoted one. Both generations there are the same
build, so what it proves is that the two sides of the exchange agree; the
skew case above — an outgoing Server that predates the responder — is covered by
the degradation path, not by the smoke.

### D4 — the Updater's own check is narrower

Full signature and provenance verification happens **Server-side**, before the
request is made: the Server fetches the signed channel document and verifies the
cosign bundle against the compiled-in identity, exactly as D4 describes. The
Updater cannot repeat it — it has no network, precisely because it holds the
Docker socket — so its independent check is what it can do offline:

- the target must be a content-addressed digest on the hard-coded official
  Server repository, so a compromised Server can name only an image ghcr serves
  under Verity's own package;
- the pull is by digest, so the daemon binds the bytes to it;
- the pulled image must declare a released `VERITY_SERVER_VERSION`.

The residual gap — an official digest the channel does not currently advertise,
such as an older one — is closed by D5: preflight runs *in the target image* and
refuses a build that cannot operate the live schema generation.

### D12 — companion completion is part of the transaction

The journal keeps D12's vocabulary and CAS discipline and adds two terminal
markers: `reconciling-companions` and `completed`. The Server cutover commits
first; the old Updater then moves both Gateways and starts a helper from the
exact target digest. That helper stages the bundled seed beside the active
release, validates its provenance, required files, types and executable modes,
atomically advances one `.current` symlink, verifies the selected digest, and
only then replaces the Updater itself. The successor Updater reconciles the
managed Runner before it alone advances the journal to `completed`. There are
no separate `staging-seed` or `switching-seed` phases in the narrowed lifecycle:
the immutable staging tree and atomic pointer are an idempotent sub-transaction
inside `reconciling-companions`, whose durable phase is entered before the helper
starts. A crash leaves either the previous complete pointer or the target
complete pointer and resumes the same sub-transaction. There is still no
migrator phase.
`handing-off-key` remains an explicit no-op even though D8 now ships: the handoff
completed before `quiescing-old` stopped the process that held the key, so by
this phase there is no one left to ask. It survives as the durable marker that
the window has closed. Container identity is operation-bound and every Gateway
instruction is idempotent against its persisted backend, so restart recovery can
resume on either side of a route switch.

The Compose seed one-shot remains the installation and standalone/non-managed
upgrade path, using the same immutable layout. Once managed identity exists it
is bootstrap-only, not a second publisher: managed publication and recovery
belong to the target-image handoff helper resuming the durable journal. Sandboxes mount the concrete directory
resolved by `.current`; existing mounts retain their old immutable inode and new
mounts see the newly selected complete tree. No sandbox observes an incremental
copy or a mixed wrapper set. The Server's stamp comparison remains a convergence
assertion: the transaction is not complete until the stamp names the target
digest and version.

Adjacent-release migration is explicit. A host whose previous Compose one-shot
left a flat tree may establish its first pointer only after that complete tree and
stamp validate; existing root-mounted sandboxes keep those flat bytes. The brief
intermediate implementation shipped root-level wrapper symlinks that all traverse
one `.current`; those existing sandboxes receive the target set safely because the
single pointer rename changes every lookup together. After this cutover all newly
created sandboxes mount the concrete selected directory and no longer depend on
that transitional root.

### Path back to the full decision

The Gateway control channel, generation fence, generation-qualified promotion,
durable route selection, forward-fenced rollback, the D8 key handoff, and the
quiesced standby they were all meant to serve are now in place. What remains of
the narrowing is D4's own image check and D12's shorter phase list, both below.

The Updater reaches maintenance, backend selection, and drain over the private
`verity-managed-gateway-control` socket. The allowlist remains structural rather
than open-ended: one bootstrap name plus a canonical positive PostgreSQL-integer
generation in `verity-managed-server-g<n>`.

The running Server now holds a database-scoped PostgreSQL advisory lock on one
dedicated session plus the durable control-plane generation. It acquires the
session lock and claims a generation before the embedded server is built — so
before any scheduler or recovery pass runs. A second live Server cannot acquire
the session lock at all. PostgreSQL releases it atomically on a process, socket,
or database failure; the successor then forward-fences any stale active row.
Every physical serving-pool connection takes the shared form of the same lock
and checks the expected generation when `pg.Pool` creates it. A reused connection
retains that session lock across checkouts; a replacement is verified anew.
Activation holds the exclusive form, so it cannot overlap any old mutation
connection; after CAS the new Server atomically downgrades its keeper to shared.
Ordered shutdown first stops all serving work and closes that pool, then quiesces
the generation and releases the keeper's shared lock last.

Two consequences of the CAS design surfaced when it was first wired to a process
lifecycle, and both are settled here rather than left to the promotion step:

- A holder id alone is not proof of process ownership. The session advisory lock
  is: PostgreSQL admits one holder and releases it when that connection dies.
- Once it holds that lock, a successor may safely quiesce and CAS-forward a row
  left active by a hard kill or interrupted shutdown; the previous process
  cannot still possess the database-scoped process authority.

There is deliberately no lease expiry or heartbeat-based handover. The shared
locks cover the complete database mutation surface, while the generation remains
the durable, monotonic activation record used by promotion and rollback.

## Required compatibility contracts

- Server N supports Runner N and N−1.
- Gateway and Updater protocols support the current and next Server protocol.
- Updater journal readers tolerate records from the previous Updater version.
- Control-plane and Runner lease generations are monotonic across rollback; they
  are never restored to an old number.
- Schema generation remains read/write compatible with Server N−1 throughout
  the rollback window.
- Existing Runner/seed bytes are immutable until no live process references them.

Gateway and Updater self-update is out of scope for the first implementation.
Changing those components continues through a signed GitOps/Compose update.

## Failure matrix and acceptance gates

Automated end-to-end tests cover at least:

- two devices submit the same and competing update requests;
- unsigned, wrong-repository, wrong-revision, downgraded, and wrong-architecture
  images;
- Updater crash after every journaled Docker/route/seed boundary;
- existing long-lived WebSockets and in-flight broker requests during Gateway
  drain, including forced close at the timeout;
- migrator crash before/after each migration with the old Server remaining
  compatible and recoverable from quiesced state;
- Server `SIGKILL` during standby, activation, route switch, and verification;
- database unavailable and schema incompatible before and after activation;
- old/new controller race and Runner completion while the Server is unavailable;
- steer and permission ACK loss during cutover;
- WebSocket disconnect/catch-up without event duplication;
- secret store initially sealed, successful live key handoff, and crash fallback
  requiring manual unlock;
- new Server fails readiness/stabilization and old Server is restored with the
  original route, leadership, broker capability, and still-active N−1 seed;
- rollback after generation acquisition uses a higher generation and rejects all
  stale mutations/Runner commands from the failed Server;
- managed-mode bootstrap, spec checksum/secret references, and refusal of
  custom/policy-pinned deployments — including the refusal of a container network
  other than `verity-net`, which is what remains of project-network
  reconciliation now that D2 has retired it;
- a later managed-deployment restart preserves the selected Server digest rather
  than reverting to the Compose file's former value;
- no Runner N is created before `succeeded`; a crash during `switching-seed`
  keeps lifecycle mutations fenced and either resumes verification or restores
  seed N−1 before rollback.

Self-update remained disabled until the ADR 0006 process-kill tests and this
failure matrix passed on a real Docker host. **Both halves of that condition are
now met.**

The ADR 0006 half is items 1, 2 and 5 of its acceptance list — a Server `SIGKILL`
mid-turn with the agent continuing, the crash windows either side of the database
commit, and a turn finishing while the Server is offline — which that ADR's
2026-07-20 fault-matrix audit records as covered by the managed-container live
smoke against real containers. Its one open row, item 11, is Sandbox recreate
continuity for ACP; that is a recreate gate rather than a process-kill one and is
not part of this condition.

This ADR's half is the table below, gate by gate. Its live tier runs once for
every backend release candidate, after release-please has identified the exact
commit that may ship. It is deliberately not path-filtered: the Server startup
path, Gateway and Compose topology can all break a cutover, whatever file caused
the release. Ordinary main commits that produce no backend release do not run
the ninety-minute live matrix.

Producing a verdict is not the same as acting on it, and this ADR calls the live
tier a release condition, so the two are wired together: `release.yml` calls
`.github/workflows/self-update.yml` as a reusable workflow with the exact release
SHA, and every backend publisher depends on that call. There is no separate
polling job and no workflow-run lookup whose result could be replaced by an
unrelated manual attempt. A failed or cancelled run
therefore publishes nothing rather than merely being visible next to something
already published — which matters because the deployments that install the
result do so unattended, and a broken cutover is the one defect that also breaks
the channel its own fix would arrive on. Concurrency is keyed by trigger kind
and candidate SHA, so duplicate calls or duplicate manual attempts supersede
their own kind without a manual recovery cancelling the verdict a release caller
awaits. Manual dispatch remains the recovery and ad-hoc validation path.

What the condition gates is now open, and it is not a flag — there never was one.
"Enabling" means migrating a deployment into managed mode: the topology lives
behind the `managed` Compose profile plus the ownership overlay, and
`deploy/bin/verity-compose managed-up` is the single guarded path into it
(`deploy/README.md`, "Migrate to managed Server updates"). A deployment that has
not run that command is host-managed and reports Server self-update as
unsupported, whatever this matrix says.

The condition explicitly covers an old managed topology moving to a newer target:
the live smoke starts Server, Gateways and Updater on the previous published image,
then requires the target digest on every managed companion, a target-stamped seed,
a ready Runner identity and the durable `completed` journal phase. Custom
orchestrators outside the managed topology remain outside this release condition.

### Where each gate is covered

The condition above is a claim about coverage, so the matrix is only usable if it
says, gate by gate, where that coverage actually sits — and where it does not.
Three tiers carry it:

- **unit** — the Vitest suite (`npm test`), sharded in CI;
- **PostgreSQL** — suites gated on `VERITY_TEST_POSTGRES_URL`, which CI supplies
  to one job running against a real database;
- **live** — `deploy/bin/verity-self-update-live-smoke`, twelve generations of a
  real managed deployment against a Docker-in-Docker daemon in
  `.github/workflows/self-update.yml`. Stage names below are its argv stages in
  `packages/server/src/self-update-live-smoke.ts`, except the drift stage, which
  is driven from the shell script alone because both of its Updaters are real
  containers started from the two releases' own images.

| Gate                                          | Covered by                                                                                                                                                                                       | State                            |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------- |
| Same and competing update requests            | unit: `self-update/updater-status.test.ts`, `self-update/update-journal.test.ts`                                                                                                                   | met                              |
| Unsigned/wrong-repo/-revision/-arch, downgrade | unit: `self-update/release-channel-verify.test.ts`, `release-channel.test.ts`, `update-runner.test.ts`, `compat.test.ts`                                                                            | met                              |
| Updater crash after each journaled boundary   | live: `cutover-halts-at` at all four phases (`handing-off-key`, `activating-candidate`, `switching-gateway`, `observing-candidate`), each resumed by the next stage; unit: `update-cutover.test.ts` | met for the phases §D12 keeps    |
| WebSockets and broker calls during drain      | live: `cutover-releases-the-drain`, `cutover-forces-the-drain` with real clients holding streams, public requests and a broker call through maintenance                                              | met — see (a)                    |
| Migrator crash before/after each migration    | —                                                                                                                                                                                                  | out of scope — no migrator phase |
| Server `SIGKILL` in standby/activation/switch/verify | live: the four `cutover-halts-at` stages, killed by the driver from outside the update, plus `cutover-survives-activation-kill`, `cutover-rolls-back-after-kill`, `cutover-standby-fails-to-resume`  | met                              |
| Database unavailable, schema incompatible     | live: `preflight-fails` against an unmigrated database, `preflight-fails-unreachable` against an address nothing serves, `cutover-loses-the-database` after the handoff, plus the store taken away from the committed deployment; unit: `self-update/preflight.test.ts` | met — see (b)                    |
| Old/new controller race, Runner completion    | PostgreSQL: `packages/session/src/two-server-cutover-postgres.test.ts`                                                                                                                              | met                              |
| Steer and permission ACK loss                 | live: `cutover-releases-the-drain` with the `catchup` client (delivery half); PostgreSQL: `two-server-cutover-postgres.test.ts` (decision half, which needs a runner)                                | met                              |
| WebSocket disconnect/catch-up, no duplication | live: `cutover-releases-the-drain` with the `catchup` client, reconnecting to the new generation on its own cursor                                                                                  | met                              |
| Sealed store, live handoff, crash fallback    | live: every generation asserts `sealed`/`unlocked`; `cutover`, `cutover-recovers-rollback`, `cutover-commits-without-the-standby`; unit: `self-update/secret-key-handoff*.test.ts`                   | met                              |
| Readiness failure restores the old Server     | live: `cutover-rolls-back`, `cutover-rolls-back-onto-standby`, `cutover-standby-fails-to-resume`, `cutover-recovers-rollback`                                                                        | met for route and leadership     |
| Rollback fences stale mutations               | unit: `self-update/control-plane-generation.test.ts`; PostgreSQL: `control-plane-generation-postgres.test.ts`                                                                                        | met — see (c)                    |
| Managed bootstrap, spec checksum, refusals    | unit: `self-update/managed-bootstrap.test.ts`, `deployment-spec.test.ts`, `managed-deployment.test.ts`, `managed-topology-deployment.test.ts`, `project-network-refusal.test.ts`; live: `updater-restarts`                              | met — see (d)                    |
| A restart preserves the selected digest       | live: `updater-restarts` — stop/restart, remove/rebuild, and a bootstrap on the stale ref that must refuse                                                                                          | met                              |
| Seed validation, atomic selection, crash resume, adjacent-release cutover | unit: `self-update/managed-companion-reconcile.test.ts`; live: seed assertions in `deploy/bin/verity-self-update-live-smoke` | met in companion sub-transaction |
| An upstream Compose change reaches sealed hosts | live: the drift stage in `deploy/bin/verity-self-update-live-smoke` — the previous release's image seals the deployment from `git show <previous tag>:deploy/docker-compose.yml` and builds the Server it describes, then the candidate's `managed-updater` inherits it against the current checkout's rendered environment and must start, bind its control boundary and reconcile without exiting; unit: `self-update/managed-topology-deployment.test.ts` | met                              |

The migrator gate remains unmet by design because this narrowing has no migrator
phase. The seed gate is met by the journalled companion sub-transaction above:
D10's immutable staging and atomic selection guarantees are implemented without
adding two public operation phases.

No remaining row is an open gap. Four were, and (a) through (d) record what each
one turned out to be and how it was closed — three by building the coverage that
was missing, and one by finding that the behaviour it asked for had been decided
against in the meantime:

**(a) In-flight broker requests during drain.** The drain stages hold real
WebSockets and real HTTP through maintenance, and assert that an in-flight
request comes back whole while a new one is refused with the Gateway's own 503.
For as long as all of that traffic was the operator's, a drain that waited only
for the public listener would have looked identical — and been wrong, because the
Gateway carries `/internal/*` on a second listener that the same cutover has to
switch in step. The client now holds one of its half-written requests there for
the same window, so the Gateway's `activeRequests` counts the sandbox-facing
channel when the drain starts, and the three assertions above are made about it
too: the in-flight broker call is answered by the Server it was routed to, a new
one during maintenance is refused by the Gateway itself, and the internal route
reaches a Server again once the switch is done.

What it does not do is sign. `POST /internal/git/sign` binds its capability to
the project identity the *connection* proved, which only a project-bound Unix
socket carries, and this deployment provisions no project — so the call is
refused with the route's own 401 before it reads settings or touches the store.
That refusal is what makes it a usable probe (a definite Server-authored answer,
told apart from the Gateway's 503 by more than a status), and it is also the
limit: the cutover now covers the broker *channel*, while brokering a signature
itself stays covered by `git-sign-route.test.ts` and `internal-listener.test.ts`,
outside a cutover.

**(b) Losing the database after activation.** Before activation this was already
live in both of its shapes: preflight runs in the target image against a
deliberately unmigrated database, and against a live host with nothing listening
on the port. The two stages assert different reports — the unmigrated one must
pass the `database` check and fail only on `schema`, the unreachable one must
fail the connection itself — so neither can decay into the other. What was
missing was the same failure arriving after the point preflight can refuse at,
where the update has already fenced and quiesced the generation it would go back
to.

`cutover-loses-the-database` is that window. The store is taken away between the
key handoff and the candidate's first connection, which is the only placement
with a single outcome — cutting it after the candidate is up races its boot,
because `/healthz` never touches the database and a Server that got its
connection first answers for as long as it lives. What follows is forced from
both ends: the candidate cannot claim a generation, so it never becomes ready,
and the quiesced standby the rollback returns to cannot reclaim one either, so
the cold start behind the fallback fails as well. The cutover reports both, and
the operation is left parked in `rollback-activating-old` with its authority
already back on the old digest and the Gateway never switched — durable intent
rather than a verdict, which the ordinary `cutover-recovers-rollback` then
finishes from the same container once the database is back.

The other half is the deployment that is not updating at all. At the end of the
run, after the Updater has rebuilt the Server from the sealed spec and it
therefore carries the production restart policy, the store is taken away from it
too. A Server whose PostgreSQL session lock is gone can no longer prove it is the
only writer, so it must exit rather than serve on the assumption that it still
is: the smoke asserts it named the lost process lock, that the policy restarted
it, that it does not serve `/healthz` while the database is away, and that it
comes back by itself on the digest the update selected — sealed, because the key
went with the process, which is the one cost.

What stays outside this is the update that has already committed onto a healthy
Server when the store goes away later. That deployment is exactly as broken as
the database being down leaves any deployment, and the recovery is the one the
paragraph above proves; there is no rollback to want, because the generation is
committed and the update is over.

**(c) The PostgreSQL generation fence ran nowhere until it was listed.**
`control-plane-generation-postgres.test.ts` is gated on
`VERITY_TEST_POSTGRES_URL`, and for as long as the CI job that supplies that
variable named only `runner-frames-postgres.test.ts` and
`two-server-cutover-postgres.test.ts`, the file was skipped in every job that did
run — so the part that depends on real PostgreSQL session-lock semantics (quiesce
held behind an admitted mutation, no successor admitted until the incumbent lock
is released, activation blocked while a serving-pool connection survives) was
written but never executed, while the in-memory
`control-plane-generation.test.ts` kept the row-level half green. The
`runner-postgres-race` job now names it. Because both halves of that failure were
silent — a skipped `describe` is green, and a file missing from an explicit list
is invisible — `scripts/ci-workflow.test.ts` derives the required list from the
gate itself and fails when the job falls behind, rather than leaving the next
gated suite to the same fate.

**(d) Project-network reconciliation was superseded before it was built.** This
row read `partial` for as long as the gate was measured against D2 as originally
written: the Updater was to attach and detach the Gateway on project networks by
label and alias and reconcile them on startup, and no such route exists — not in
`self-update/updater-status.ts`, not anywhere under
`packages/server/src/self-update/`, and not in the Docker client, whose only
network call is the `POST /networks/create` that D2 leaves with the provisioner.

What the missing code turned out to mean is the whole of the finding. Between D2
being written and being read again, the project relay landed as two breaking
changes and took away the topology the RPC was for: a Sandbox is now attached
only to its own project network, unconditionally rather than behind the
`VERITY_PER_PROJECT_NETWORK` flag the July security review still describes; its
relay sits on that same single network; and what it needs from Verity arrives
over Unix sockets, down to Claude egress addressing the relay's own container
name. No name inside a project network resolves to the Gateway, so attaching it
would enable nothing that is currently blocked — while making the one container
that fronts both the public and internal listeners a member of every project
network, which is the cross-project pivot the preview spike rejected by name.

So the gate is met, but not by the mechanism it was written for: what a managed
deployment must do about project networks is refuse to be on one. That refusal is
already load-bearing in three independent places — `deployment-spec.ts` pins the
container network to `verity-net` and rejects any other value before a spec is
accepted, `updater-status.ts` answers an explicit list of eight method/path pairs
across five paths and closes over it, so a network verb is a 404 before the
bearer token is read,
and the Docker client implements neither connect nor disconnect — and
`self-update/project-network-refusal.test.ts` now names all three together, so
none of them can be relaxed as an apparent simplification without failing a test
that explains what it was holding. D2 records the retirement.

## Consequences

**Positive:** updates become an app-initiated, journaled transaction; project
agents keep running; ports and Sandbox DNS remain stable; signing and GitHub
brokerage survive intentional updates; rollback keeps the old process and memory
available; supply-chain identity is verified before host-privileged execution.

**Negative:** Gateway and Updater become new long-lived components; managed
deployments use a different ownership model from custom Compose/orchestrator
deployments; release CI must enforce signatures, provenance, schema, and protocol
compatibility; the Updater is a small but highly privileged TCB.

## Rejected alternatives

- **Server replaces itself:** cannot reliably finish or roll back after stopping.
- **Promote the preflight container:** Docker cannot add the production host-port
  binding after creation, and preflight must not be an active Server.
- **Clone the old container from inspect:** loses declarative intent and can copy
  stale image defaults or broaden network exposure.
- **Direct old/new port swapping without a Gateway:** requires fragile name,
  network, alias, and host-binding surgery and still interrupts the stable broker
  endpoint.
- **Use `/healthz` as readiness:** proves only that one handler responds.
- **Restart sealed and ask later:** project agents may continue computing but
  signing/token-dependent work fails, contradicting transparent update semantics.
- **Overwrite the live agent-seed:** changes executable bytes under running agents
  and is not atomic.
- **Trust digest alone:** identifies content but not the publisher or build
  provenance.

## Related

- [ADR 0003](0003-runner-image-and-deployable-packaging.md) — current reference
  deployment and image boundary.
- [ADR 0004](0004-agent-cli-tooling-distribution-and-updates.md) — build-time
  tooling updates and agent-seed distribution.
- [ADR 0006](0006-runner-in-sandbox-extraction.md) — restart-surviving project
  Runners and reconnect-safe control.
- `deploy/docker-compose.yml` — current direct-port and agent-seed topology to be
  migrated by the managed-deployment implementation.

## Amendment — D2: an environment mismatch is not a reason to stop existing (2026-08-18)

D2 makes the Updater the sole owner of the managed Server and has it reconcile
that container against the sealed spec on every start. It did not say what to do
when the two disagree, and the implementation answered that with one verdict and
one action: throw. `recoverManagedUpdater` rethrows whenever no operation is in
flight, so the Updater exited, its restart policy brought it back, it reached the
same verdict, and it exited again — forever.

That is unrecoverable in the specific sense that matters here. The one operation
that rebuilds the Server with the current environment is the cutover, and the
cutover runs inside the Updater. A host in this state cannot be repaired by the
mechanism that exists to repair it, and cannot receive the fix for the fault that
put it there. Two instances reached production in a single night, both from
ordinary upstream changes — a retired transcription variable, and a value the host
began interpolating differently. Both were patched with a compensation aimed at
the instance rather than the class, which is how the tree came to hold four
independent workarounds for one defect: `IMAGE_PROVIDED_ENVIRONMENT`, the
`activationEnvironment` `VERITY_SERVER_VERSION` override, `createRawReplacement`'s
single-variable patch, and `RETIRED_MANAGED_SERVER_ENVIRONMENT` with its Compose
bridge. It is not transcription-specific; changing `VERITY_SANDBOX_MEMORY` in the
host environment would wedge a host identically.

**The refusal was right; the exit was not, and the two were welded together.**
D2's ownership claim is unchanged: the Updater still refuses to adopt a container
that is not the Server the authority describes. What changes is that refusing to
adopt no longer means refusing to run.

`describeManagedContainerMismatch` classifies the disagreement:

- **`structural`** — image, mounts, user, `groupAdd`, network, `readOnlyRootfs`,
  restart policy, `no-new-privileges`, `capAdd`, `command`, `init`, sealed host
  ceilings, or an environment variable the container carries that is neither
  sealed nor baked into the image. Still fatal, running or stopped. This is the
  injected-variable check D2's allowlist was written for, and it is untouched.
- **`environment`** — every difference is a difference in the VALUE of a name the
  sealed spec itself supplies, or one recorded as retired. The container is this
  deployment's Server, configured from an older resolution of the same sources.

Only a value may drift. A sealed name the container does not carry **at all** is
`structural`: that is not a Server configured differently, it is a Server running
*without* a variable the authority says it must have — the "quietly running on
defaults" state — and it has no value of its own for the tolerance to preserve.

An `environment` mismatch on a **running** Server is tolerated and reported. The
Server already has that environment and is already serving on it; the Updater
cannot improve that by ceasing to exist. The mismatch is evidence about the past,
not a decision about the present. On a **stopped** Server it is recreated —
without that, a host reboot would turn every tolerated drift into no Server at
all — and this grants no new authority, because the environment used is
byte-for-byte the one `managedServerContainerSpec` already builds when the
container is simply absent, which is the first-install path.

An unresolvable environment **source** is treated the same way: fatal for
*building* a Server, not for *judging* one that is already up and owned. With no
running owned Server it stays fatal — including a *stopped* one, because nothing
is serving and starting a container that lacks a sealed variable is the "running
on defaults" outcome rather than an escape from it. A corrupt spec, a value
carrying a NUL, and a `VERITY_MANAGED_DEPLOYMENT_ID` that disagrees with the seal
stay fatal in every case.

The tolerance is bounded by what the running container can actually show: it
applies only when that container **carries every unresolved name**. The whole
argument is about a value the Server already has and is serving on, so a
container that has no value for the name has nothing to preserve — it is a Server
running without a variable the authority says it must have, which is the state
being avoided rather than a recovery from it. One preserved value does not excuse
another absent one, so a partially-carried set is fatal too.

Two details of that path are load-bearing rather than incidental. Sources are
resolved **leniently** — every failure is collected instead of the first one
aborting the pass — because a report that stops at the first missing source hides
both the other missing ones and any resolvable value that has *also* moved, which
is exactly what the report exists to reveal. And the container is judged against
the names the spec **seals**, not against the environment the Updater managed to
build: a lost source is absent from the built environment while still being a
sealed name, so judging against the build would classify the running Server's own
value as an injected variable and refuse it — turning the lost source straight
back into the crash loop this amendment removes.

Four things stay fatal and are named here so that relaxing them is a decision
rather than a slip: authority unavailable; the name occupied by a foreign
container or by more than one container; any `structural` mismatch; and any
difference in the variables that say *which* install or *which* operation a
container belongs to — `VERITY_MANAGED_DEPLOYMENT_ID`, `VERITY_UPDATE_ID`,
`VERITY_CONTROL_PLANE_HOLDER_ID`, `VERITY_CONTROL_PLANE_WAIT_FOR_ACTIVATION`.
Those are identity, not configuration; tolerating them would let the Updater adopt
another install's Server, or start a candidate into an activation that is never
coming (D7).

**The trade, stated honestly.** A name that now resolves *wrongly* — an operator
fat-fingers `DATABASE_URL` — moves from "the Updater refuses to run" to "the
Server fails to start". Equally loud, but the repair channel survives. Nothing
here ever omits a variable from a Server it builds; it only tolerates a different
*value* for a name the spec sealed, so the "Server quietly running on defaults"
hazard the retired-list rationale warns about does not arise.

**Reporting is part of the decision, not a nicety.** Tolerated drift that nothing
can see is drift nobody fixes, so `GET /v1/reconcile` answers the last verdict:
`ok`, `drift` with the differing names, or `unknown` when an unfinished operation
meant no verdict was reached. Names only — most of them are secrets. It is a
separate route rather than a field on `/v1/deployment` for the same reason
`/v1/agent-seed` is separate: that payload is parsed with exact key counts on the
Server side and a cutover deliberately runs two Server generations at once (D12),
so widening it would make the outgoing generation reject the authority it is
handing over to.

The rollback leg of D12 is unchanged and now pinned by a test: `activateOld`
restarts the retained container **by id**, without comparing it to the spec. A
rollback that started re-comparing would put the fatal refusal back inside the
cutover, at the one point where there is nothing to fall back to.

`deploy/README.md` documents the blunt manual repair for a host already in the
crash loop — remove the Server container so the Updater takes the create path —
including its cost: one hard control-plane restart, no drain, in-flight sessions
lost.
