# ADR 0006 — Runner-in-Sandbox Extraction and Server-Restart Survival

**Status:** Accepted · **Date:** 2026-07-13 · **Amended:** 2026-08-18

> **Read [Amendment 1](#amendment-1-2026-08-18--the-control-plane-runner-holds-the-docker-socket)
> before relying on D1 or on the anti-forgery invariant.** The operator has
> decided — finally, not provisionally — to give the control-plane Runner the
> host Docker socket. The moment that lands, those claims are void in practice
> for that one container; until it does they still hold, and the amendment is
> here so that nobody builds on them meanwhile. For project Sandboxes they hold
> in full, unchanged, and are still gated by CI.

## Context

[ADR 0005](0005-naming-and-layering.md) established the target vocabulary and
process boundary: the **Runner** owns an agent process inside a project
**Sandbox**, while the **Server** orchestrates sessions and remains the only
writer of control-plane data in PostgreSQL.

The repository has already completed important boundary preparation:

- `RunnerClient` / `RunnerTurn` hide steer, cancel, permission replies, and the
  terminal result behind a process-ready contract (`runner-contract.ts`).
- `RunnerServer` can serialize session, event, permission, and result frames to
  an append-only JSONL file (`runner-server.ts`, `runner-transport.ts`).
- `FileTailRunnerClient` can tail that file, persist each event on the Server,
  and publish only after persistence (`file-tail-runner-client.ts`).
- The Unix control-socket transport carries steer, cancel, and permission
  replies (`runner-control.ts`).
- The complete transport can be enabled through `VERITY_RUNNER_TRANSPORT=1`
  and is exercised through the Conductor, but `RunnerServer` still runs in the
  Server process. The paths are allocated under the Server's temporary
  directory and are neither cross-container nor restart-durable.
- `running_turns` makes an abandoned in-flight turn explicit. Current startup
  recovery settles such a marker as interrupted; it does not reconnect to a
  surviving agent process.

Consequently, an app WebSocket reconnect is durable, but a Server process exit
still terminates the `docker exec` pipe that owns the agent. The recent
lifecycle work guarantees "settle cleanly and never run twice," not "continue
running and reattach."

This distinction blocks transparent Verity Server updates. A project agent must
be able to keep producing output while the Server is unavailable, and a new
Server must resume ingestion and control without losing or duplicating work.

## Decision

Complete the full Runner extraction and make the cross-process protocol
restart-safe. Project-session agents run under a Sandbox-local supervisor;
Verity-self sessions without a Sandbox retain the in-process loopback Runner.

### D1 — A protected, persistent Runner runtime mount

Each project receives a dedicated runtime directory from the persistent
`verity-data` volume. It is mounted at a short path inside the Sandbox and is
visible to the Server through its existing data-volume mount. A representative
layout is:

```text
Server:  /srv/verity/runners/<project-id>/
Sandbox: /run/verity-runner/

turns/<turn-id>/
├── events.jsonl
├── state.json
└── control.sock
```

The exact host-side path may vary for non-Compose deployments, but all of these
properties are mandatory:

- the event file survives Server and Sandbox process exits;
- both Server and Sandbox see the same filesystem objects;
- project code cannot write the runtime directory or connect to the control
  socket;
- socket paths remain below the Unix-domain path-length limit;
- runtime files are scoped to one project and cannot be reached by sibling
  Sandboxes.

The project workspace is rejected as the runtime location. It is intentionally
agent-writable, so an event file there would let project code forge Runner
frames or send its own permission replies.

A mount alone is not a protection boundary when the Runner and agent share a
Unix identity. Restart-surviving remote execution therefore uses a dedicated
Runner owner UID plus a deployment-assigned numeric `verity-runtime` GID. Runtime
directories/files are owner/group-only (`0770`/`0660`): the Runner owns them and
the Server container receives that supplementary GID. The agent child retains
neither the Runner UID nor the runtime GID and clears all supplementary groups
before exec, even when the Server and default agent happen to share numeric UID
1000 in different containers. ([Amendment 1](#amendment-1-2026-08-18--the-control-plane-runner-holds-the-docker-socket):
the control-plane Runner's agent is to keep both of those properties and gain
the Docker group, and a session that can reach the daemon can rewrite these
files as host root regardless. The protection this paragraph describes is void
for that one container and unchanged for every project Sandbox.) Numeric UID/GID
allocation and mount ownership are validated before enabling the remote mode.
The child also runs with
`no-new-privileges` and no retained capabilities; any narrowly required UID/GID
transition remains in the supervisor launcher and is dropped before the agent
binary executes.

A devcontainer that deliberately runs the agent as root or enables privilege
escalation cannot provide this in-container anti-forgery boundary. Verity marks
such a Sandbox as **not restart-survivable**: its active turns block Server
self-update and continue to use the existing lifecycle semantics. The system
must not claim that filesystem permissions protect the Runner from root in the
same container.

Which Sandboxes qualify is decided by **evidence, not by image identity**. The
first implementation admitted only Verity's managed default image, which also
excluded every project devcontainer — even though the toolkit Feature installs
the same reserved identities into one (`installRunnerSupervisor`, injected into
project builds via `--additional-features`). A project image instead ATTESTS the
boundary: before the Sandbox is created, Verity creates a **stopped** container
as a filesystem snapshot and uses trusted Docker/Server code to read its image
configuration, `/etc/passwd`, `/etc/group`, supervisor paths, and every parent
directory. No program from the project image is executed and no output produced
by that image is trusted. The evidence must show a non-root agent that holds
neither the Runner UID nor runtime GID, uniquely reserved
`verity-runner`/`verity-runtime` identities, regular non-symlink supervisor
binaries below root-owned non-writable directories, and binary hashes equal to
the toolkit bundled with the Server. Anything missing, ambiguous, writable, or
different denies the supervisor and degrades that project to the existing
loopback lifecycle, with the failed check named in the project's provision
warning.

Image declarations alone are not evidence: a project can ship a Feature ordered
`installsAfter` the toolkit whose root build step changes identities, groups,
paths, or installed binaries. The host-side filesystem observation catches those
changes without relying on replaceable in-image tools. Deployment policy
separately requires `cap-drop ALL` and `no-new-privileges`; either policy opt-out
vetoes an otherwise valid image attestation.

### D2 — A Sandbox-lifecycle Runner supervisor

The toolkit starts one `verity-runner` supervisor as part of Sandbox startup.
It is not launched through the Server's turn-scoped `docker exec` pipe. The
supervisor:

- owns agent child processes and warm-process state;
- reaps children and publishes its readiness;
- exposes start, list, attach, and per-turn control operations;
- atomically creates one directory per `turnId` and never truncates an existing
  turn log;
- keeps running when the Verity Server disconnects or exits;
- treats loss of the Server control connection as detach, never as cancel.

Devcontainer and default-image provisioning must start the same supervisor
idempotently. Singleton ownership is explicit; a second supervisor cannot
silently unlink or replace the first supervisor's socket.

Each turn created by a worker-lock-capable supervisor also owns a protected
`worker.lock`. The supervisor acquires its kernel `flock` before launch and the
worker inherits that open file description. After launch the supervisor closes
its copy, so the lock remains held exactly while the worker process lives—even
if the supervisor itself is `SIGKILL`ed. A replacement supervisor reclaims the
singleton, scans marked `claimed`/`running` turns before publishing readiness,
and adopts every still-held worker lock. It then observes lock release to settle
the worker without relying on a reusable PID or parent-only exit status. Turns
from older supervisors that have no worker-lock marker remain uncertain during
a rolling deploy; absence of a legacy lock is never interpreted as death.

The Server allocates `turnId` and `startCommandId` before launch and
transactionally persists the `running_turns` marker before calling `StartTurn`.
Start is itself idempotent: `StartTurn(turnId, startCommandId)` atomically claims
a new turn directory and returns exactly one of `created`, `already-running`, or
`terminal`. A lost start ACK is resolved by repeating the same request or
attaching; it never starts a second agent process. An ambiguous discovery state
never launches another agent.

### D3 — Versioned, replayable event frames

Every Runner frame contains at least:

```text
protocolVersion
runnerInstanceId
turnId
frameSeq
kind
payload
```

`frameSeq` starts at 1 and is contiguous within a turn. A `turnId` binds
immutably to one `runnerInstanceId`; every frame also carries a canonical payload
hash. Reusing a sequence with a different Runner identity or payload is
corruption, not a duplicate. The terminal `result` frame is accepted only after
the complete preceding prefix and is the final frame. Session binding,
permission state transitions, transcript chunks, and the result participate in
sequencing just like normal agent events.

The event file is append-only and has one trusted writer. Partial trailing JSONL
is ignored while the Runner is live and diagnosed, without discarding earlier
complete frames, after confirmed Runner death.

Durability is explicit rather than assumed:

- writes are serialized;
- permission boundaries and terminal results are synced before acknowledgement;
- ordinary high-volume frames are synced in bounded batches;
- sync failures surface as Runner failures and are never silently ignored.

`state.json` is written by atomic replace and assists discovery, but it is not
the event authority. The append-only frame log remains authoritative.

Native backend transcripts cross the same boundary without giving the Runner DB
access. The Runner tails the transcript beside the backend process and emits
idempotent transcript-chunk frames containing a logical transcript ID, chunk
sequence, and content hash. The Server persists them through `TranscriptStore`.
For resume after a Sandbox/container replacement, `StartTurn` supplies the last
persisted transcript snapshot (or content-addressed chunks) for the Runner to
restore before launching the backend.

### D4 — The Server remains the DB and sequence authority

The Runner receives no PostgreSQL credentials. The Server ingests frames through
one transactional store operation that:

1. verifies the immutable `turn_id → runner_instance_id` binding;
2. accepts only the next contiguous `frame_seq` and claims
   `(turn_id, frame_seq)` under a unique constraint;
3. verifies that a replayed sequence has the same canonical payload hash;
4. persists the corresponding Verity event, transcript chunk, or lifecycle
   transition;
5. updates the durable Runner cursor / turn state;
6. closes `running_turns` when accepting a terminal frame.

Only a newly claimed frame is published to live subscribers. A stored byte
offset may accelerate tailing but is never used as the correctness boundary.
After a crash, replay from byte zero is safe because frame ingestion is
idempotent.

This preserves the existing persist-then-publish guarantee and makes these two
crash windows equivalent:

- crash before DB commit → the new Server accepts the frame;
- crash after DB commit but before publish → the new Server
  deduplicates the frame and clients receive it through backlog replay.

### D5 — Acknowledged, idempotent control commands

Every steer, cancel, and permission decision contains:

```text
turnId
commandId
leaseEpoch
kind
payload
```

The Runner journals command IDs, lease epochs, and outcomes and syncs the record
before acknowledging it. Every command is acknowledged; while the same
supervisor remains alive, a reconnect retries an unacknowledged command with the
same ID and receives the same result without repeating its effect.

No protocol can atomically commit a journal record and an arbitrary external
stdin/tool side effect across a Runner process crash. Commands therefore have an
explicit `received → applied | ambiguous` lifecycle. If the supervisor dies in
the effect/journal window, recovery reports `ambiguous` and never automatically
retries the command. Operator-visible recovery can settle or inspect the turn,
but it cannot silently duplicate external intent.

In particular, loss of a steer reply is an **unknown delivery state**, not
`injected: false`. The Conductor must not enqueue the same operator message
until the Runner resolves that command ID. Cancel and permission replies are no
longer fire-and-forget.

### D6 — Controller leases provide fencing

At most one Server controls a turn. Attach obtains a monotonically increasing
`leaseEpoch`; every later command carries it. The Runner accepts commands only
from the highest epoch it has acknowledged and rejects stale controllers.

The attach handshake reports:

- protocol and capability ranges;
- Runner instance and turn identity;
- last durable `frameSeq`;
- current turn status;
- outstanding permission requests;
- accepted controller epoch.

The supervisor persists `{controllerId, leaseEpoch}` before attach ACK and
persists each command receipt/outcome before command ACK. A supervisor restart
cannot lower the accepted epoch or revive a stale controller.

A candidate or preflight Server may inspect compatibility but cannot acquire a
controller lease. Socket cleanup is owner-aware; a process never unlinks a
socket merely because a connection attempt failed.

### D7 — Startup recovery attempts reattach before interruption

`Conductor.recover()` changes order for durable `running_turns` markers. The
marker, including `turnId`, `startCommandId`, project/runtime identity, and
protocol version, is written before `StartTurn`; the Runner identity is bound
when the idempotent start/attach response arrives:

1. discover the referenced project Sandbox and Runner;
2. ingest all complete frames idempotently;
3. if a terminal result exists, settle it transactionally;
4. if the Runner is live and compatible, acquire a lease, recreate the
   `RunnerTurn` handle, reconnect control, and continue tailing;
5. if status is uncertain, remain in a bounded discovery state and do not start
   another backend turn;
6. only after confirmed Runner/Sandbox death, append `interrupted` and clear the
   marker.

For an adopted worker, lock ownership is the liveness authority. A held lock is
live; a released lock is confirmed process death. Exit code and signal may be
unknown because the replacement supervisor is not the worker's parent. Durable
terminal frames still take precedence: a result written before lock release is
replayed and settled normally, while release without a result follows step 6.

A surviving turn is never inferred only from the tail of the user-visible event
log. Recovery of a marker with no start ACK first queries/repeats the idempotent
`StartTurn` request before deciding whether an agent exists.

Step 5's uncertain state is bounded in ATTEMPTS, not just per discovery call. A
seam that can never answer — a supervisor socket that is gone, a project runtime
directory that no longer exists — otherwise re-answers `uncertain` forever, and
the marker it preserves keeps the session both badged `running` and fenced
against new prompts, with an operator's Stop as the only exit. After a bounded
number of consecutive `uncertain` discoveries the turn is settled exactly like a
confirmed-dead one, plus a `notice` recording that the Runner's fate was never
established. Fencing a session forever is a worse failure than interrupting a
turn that might still be live: the marker exists so work is not duplicated, not
so a session can be lost.

Two things keep that bound from being a licence to kill live turns. The silence
each attempt judges is anchored BEFORE its discovery call, not after: discovery
is bounded in seconds, and a turn that emits inside that window has produced the
proof of life the seam could not. Such an attempt gives the bound back rather
than spending it, so a turn that keeps speaking is never settled, and one that
goes quiet again is judged on a fresh window.

And because this Runner was never CONFIRMED gone — that is precisely what makes
it uncertain — settling it is not enough: unlike a dead one it can come back and
stream. A confirmed-dead Runner is fenced by its own terminal frame; this one has
none, so the give-up path plants a fence of its own in `runner_frames` before
releasing the session, and every later frame of that turn is refused. Otherwise
a Runner that reappeared would append into the transcript of whatever turn holds
the session next. The fence needs no new column: it is a claim row bearing a
reserved `payload_hash`, and ingest refuses that value from a Runner, so a row
carrying it is a fence by construction and no turn can fence itself. Frames
below it stay valid duplicates, so a re-tail from byte zero is still idempotent.
What no fence can reach is the Runner itself: one that cannot
be contacted cannot be killed, so its effects on the worktree are the residual
cost of bounding step 5 at all. The fence bounds what reaches the LOG.

### D7a — Liveness is checked while the Server runs, not only after a restart

D7 settles turns a restart left behind. A Runner that dies while the Server keeps
running produces no restart, so nothing reclassifies its turn: it stops emitting
and its marker stays open indefinitely.

A periodic sweep therefore walks the open `running_turns` markers and measures
each turn's silence against its own event log — the one signal a locally-run, a
reattached, and a supervisor-written transcript all share. Silence alone is never
death; a long build or a slow tool legitimately emits nothing. It only triggers a
probe through the same discovery seam D7 uses, and only a CONFIRMED-dead Runner
settles the turn. Absent a seam, absent a turn id, or on an `uncertain` answer,
the turn stands — the sweep can end a turn no one is running, never one it merely
cannot see. A confirmed death is settled through the operator Stop path, so the
fence-release guarantee is the one already proven for Stop.

The verdict is about one turn, but it is acted on per session, and a probe takes
seconds to answer — long enough for the probed turn to settle on its own and a
queued successor to start. Both halves of acting on it are therefore scoped back
to the turn that was probed, identity included. The notice is written through an
append that is conditional on the marker *and* on the log not having moved since
the silence was measured (`appendEventForRunningTurn`, one statement, so nothing
can slip between the check and the write, and appends to one session's log are
serialized in the Server — the only writer of them — so the predicate cannot be
overtaken by an append that had not committed when it ran). The marker alone
would not be enough:
because the terminal event is written before the marker is cleared, a turn that
finished normally mid-probe still has one, and the silence condition is what
keeps a "your Runner is gone" notice from landing behind its result. The settle
then re-validates the marker and aims at the turn handle that was probed rather
than at whatever the session holds by then. A stale verdict writes nothing and
settles nothing. Settling still runs through Stop rather than clearing the marker
directly, so the terminal event always precedes the clear and a crash mid-settle
leaves an orphan tail recovery can finish.

The same reasoning bounds D7's own `uncertain` state, which a seam that can never
answer would otherwise hold open forever: past a fixed number of retries the turn
is settled like a confirmed-dead one, with a notice saying it was abandoned rather
than finished. That give-up path has the widest exposure of all — it re-reads the
marker after a discovery that took seconds, then writes across several more awaits
— so its notice and its terminal event go through the same turn-anchored append.
Clearing only this turn's marker keeps a successor's marker intact; anchoring the
writes is what keeps the abandoned turn's `interrupted` out of the successor's
transcript, where it would end a turn that is genuinely running. A refused write
settles nothing and comes back through the retry, which re-reads everything.

Two writers can invalidate such an anchor: an append, and a terminal Runner frame,
which closes the marker the predicate tests. Both take the session's append lock —
in-process, and as a transaction advisory lock so overlapping Server generations
during a cutover are ordered too.

### D8 — Permission state is durable and fail-safe

Permission lifecycle is represented explicitly:

```text
requested → decision-accepted → resolved
                           └──→ denied-on-settle
```

The Runner is the authority for outstanding permissions. On attach it returns a
snapshot so the new Server and app can reconstruct actionable prompts even when
the original request frame was already deduplicated.

While the Server is absent, the agent remains parked. Disconnect never implies
allow. A decision remains pending in the control plane until the Runner
acknowledges it. Turn settlement denies every still-open request locally.

### D9 — Runner and toolkit compatibility is N/N−1

A Server update commonly connects version N to a Runner started from toolkit
version N−1. Event and control handshakes therefore negotiate a supported range,
and each Server release must support the immediately previous Runner protocol.

Runner binaries and agent-seed content are immutable for their lifetime. Updating
the Server or publishing a new seed must not overwrite bytes used by a live
Runner. If a target Server cannot attach to every active Runner, the update is
blocked before cutover rather than interrupting those turns.

### D10 — Credentials and Server-local sessions

Backend routing stays Server-side. Existing mounted credential files and broker
URLs remain the credential boundary; the Runner receives no control-plane DB
credentials or long-lived GitHub App private key.

Claude authentication follows ADR 0002 D4: the agent receives only a fixed,
non-secret bearer placeholder and sends HTTPS through the Verity credential-
injection egress proxy. After terminating TLS, the proxy accepts credentialed
requests only for the exact `https://api.anthropic.com` origin, requires the
placeholder, rejects client-provided API keys, and substitutes the current
Server-managed OAuth access token only in the outbound request. The raw token is
never written to a Sandbox environment, worker request, turn directory, event
log, or agent subprocess. Proxy absence is a launch failure; there is no fallback
to raw-token injection.

The placeholder signals rewrite intent; it is not authorization. Each proxy
listener or mutually authenticated transport peer is bound outside HTTP to one
project identity, and that identity must match the credential scope. CONNECT/TLS
SNI and the decrypted request origin must agree. Client-controlled routing,
framing, hop-by-hop, and forwarding headers are rejected, and outbound redirects
are never followed automatically; every hop would require fresh authorization.

The proxy process and its in-memory access-token cache are update infrastructure,
not part of the replaceable Verity Server process. They remain available during
cutover; the new Server resumes refresh/rotation after it becomes active. TLS
interception uses a Verity-owned CA projected as a public certificate only. The
private CA key and OAuth refresh credential stay outside project Sandboxes.

Project agents can survive Server replacement after this ADR lands. Verity-self
sessions, which have no project Sandbox, keep the loopback Runner and must be
idle before a Server cutover. Broker continuity and secret-key handoff during an
intentional Server update are specified separately in
[ADR 0008](0008-verity-server-self-update.md).

## Crash and race invariants

The implementation is not complete until all of these hold:

- `(turnId, frameSeq)` has at most one control-plane effect.
- A `turnId` binds to one Runner instance, contiguous frame prefix, and payload
  identity.
- A `startCommandId` creates at most one agent process.
- A `commandId` has at most one automatic effect while its supervisor survives;
  crash-ambiguous commands are never automatically retried.
- A terminal frame is persisted before `running_turns` is removed.
- A Server shutdown does not signal, cancel, or close a remote agent process.
- A control disconnect does not change turn or permission status.
- One turn has at most one accepted controller epoch.
- A new turn is never started while an existing Runner is live or discovery is
  inconclusive.
- Runner N remains attachable by Server N and N+1.
- Project code cannot forge event frames or control commands in a
  restart-survivable Sandbox; privileged/root Sandboxes are explicitly excluded,
  and since [Amendment 1](#amendment-1-2026-08-18--the-control-plane-runner-holds-the-docker-socket)
  so is the control-plane Runner, which is to hold the host Docker socket.

## Amendment 1 (2026-08-18) — the control-plane Runner holds the Docker socket

**Decided by the operator on 2026-08-18, and recorded here deliberately BEFORE
the implementation lands.** What follows retracts a guarantee this ADR makes.
The retraction should not arrive bundled with the code that causes it, where a
reader can mistake it for a note about an implementation detail.

**Status: decided, not yet built.** The mechanisms named below —
`privilegeDropFlags()`, the `--groups` substitution, the
`VERITY_CONTROL_PLANE_RUNNER_DOCKER` kill switch, the socket mount on both
topologies — describe what the implementing change is to do, not what is
deployed as this is written. What is already true is the decision and its
consequence for what this ADR may claim.

The control-plane Runner is given the host Docker daemon socket so that the
operator's control-plane session can diagnose faults across the fleet. That is
his primary use for that session, and it stopped working on 2026-08-13, when
`939d6d92 feat(session)!: isolate Claude control-plane turns behind ACP (#1478)`
moved control-plane turns out of the Server process — which has carried this
mount all along — and into a container of their own, which did not.

### Scope — this changes exactly one container

**Project Sandboxes are unchanged.** No daemon socket is mounted into them, no
Docker group is added to them, the agent argv keeps `--clear-groups`, and
`scripts/test-runner-forgery-boundary.mjs` still proves the resulting denials in
CI. Everything below is about the control-plane Runner alone.

That distinction is the point rather than a caveat. The anti-forgery boundary
exists because a project Sandbox runs REPOSITORY code — code Verity did not
write and does not trust — beside the journal the Server believes. That is where
the property has to hold, and there it still does, in full.

### What no longer holds, for that one container

The letter of D1 survives. The agent child still retains neither the Runner UID
nor the deployment-assigned runtime GID; see the `--groups` note below for how.

The guarantee does not survive. A session that can reach the Docker daemon can
start a privileged container, bind-mount the Runner runtime directory, and
append to `turns/<id>/events.jsonl` or the command journal as host root. Group
membership is not on that path, so nothing about the identity the agent runs
under interferes with it. Concretely, for the control-plane Runner:

- D1's mandatory property "project code cannot write the runtime directory or
  connect to the control socket" no longer describes a boundary;
- the crash-and-race invariant "project code cannot forge event frames or
  control commands" is **void in practice**;
- D4's ingestion checks still reject a malformed or out-of-sequence frame, but
  they cannot distinguish a forged well-formed frame from a genuine one — they
  never could; D1 was what made forgery unreachable.

D1 already refuses to make this claim for a Sandbox that runs the agent as root:
"the system must not claim that filesystem permissions protect the Runner from
root in the same container." A container that can CREATE root elsewhere is in
the same position, and this amendment extends the refusal to it. What it does
not extend is the consequence D1 attaches to root Sandboxes — the control-plane
Runner's turns remain restart-survivable. The exclusion is about what Verity may
CLAIM, and Verity must now claim nothing here.

### The `--groups` substitution, and what it is not

Mounting the socket and adding the group to the container grants the agent
nothing. `group_add` applies to the container's own process; the agent is a
`setpriv` child at uid 1000 launched with `--clear-groups`, so it holds no
supplementary group at all, and a `0660 root:docker` socket answers `EACCES` on
open — indistinguishable from the feature not having been deployed. The grant
therefore has to be made in the broker: `privilegeDropFlags()` substitutes
`--groups=<docker-gid>` for `--clear-groups`.

util-linux accepts exactly one of `--clear-groups`, `--groups`, `--keep-groups`
and `--init-groups`, and `--groups` SETS the supplementary list rather than
extending it. The child therefore ends up holding precisely one group, the
Docker one, and not the runtime GID — which is why the wording of D1 survives
verbatim. That GID is deployment-assigned, not the reserved default: whatever
the deployment allocated is what must stay out of this list, and what a test
must assert against.

**That nuance is not what keeps anything safe, and must not be read as though it
were.** It prevents an ACCIDENTAL widening: a future edit that reaches for
`--keep-groups`, or that passes the runtime GID through this argv, would hand
the agent the group that owns every turn journal, and the substitution is
narrow enough that such an edit is visible. It is not what stops forgery.
Nothing stops forgery once the socket is present. `--groups` preserves the
sentence in D1; it does not preserve the protection the sentence was written to
describe.

### The mitigation that does exist

A kill switch, `VERITY_CONTROL_PLANE_RUNNER_DOCKER`. It is opt-OUT and defaults
to ON — the operator's decision, because a diagnostics console that silently
lacks its capability is the failure this change exists to end.

Its two topologies withdraw the grant by different means, and the asymmetry is
recorded here because a reader auditing one topology will otherwise draw a false
conclusion about the other:

- **Managed topology** (the Runner spec the Server creates): the switch drops
  the bind mount AND the group. The socket is genuinely absent from the
  container.
- **Compose topology**: Compose cannot drop a single entry from a `volumes` list
  conditionally, so the mount stays in place and the launcher withholds the
  Docker group instead. The socket is present in the container; uid 1000 cannot
  open it.

Only the managed one removes the capability from the container, so "is
`/var/run/docker.sock` mounted?" is not a sound audit question on the Compose
path — "does the agent argv carry `--groups`?" is.

And the Compose withdrawal is weaker than the managed one in a second way that
must not be papered over. It denies the agent by permission bits alone, so it
holds only while the socket's owning group is one the agent does not have. A
host whose `/var/run/docker.sock` is group-owned by the numeric GID the agent
already runs with as its PRIMARY group — 1000 by default — presents a `0660`
file the agent can open without any supplementary group at all, and the kill
switch will have withdrawn nothing. The implementing change must therefore
refuse to withhold-only in that case: on Compose, a socket whose GID collides
with the agent's primary (or run) GID has to fail the launch loudly rather than
report a denial it is not delivering. The managed topology has no such edge,
because there the switch removes the mount.

### The trade the operator accepted

The control-plane agent ingests untrusted text as a matter of routine: container
logs, GitHub issue and PR content, and output produced by project sessions. With
the daemon socket reachable, a prompt injection that lands in any of those has a
host-takeover path — it can start a privileged container and leave the box. This
is a direct consequence, not a theoretical residual, and it is the reason the
control-plane container must now be read as host-root-equivalent.

The alternative considered was a narrow diagnostics tool channel: a fixed set of
read-only daemon operations brokered to the agent, in the shape ADR 0014 uses
for secret tools, so that no general daemon access ever reaches the session.
That was estimated at roughly six days of work. The operator weighed it against
the socket and chose the socket, accepting the exposure above in exchange for
having the fleet diagnostics console back now.

### Consequences elsewhere in this document, and in others

- **Acceptance test 8 and fault-matrix row 8** — `scripts/test-runner-forgery-boundary.mjs`,
  run by the `server-image` CI job — now prove the boundary for **project
  Sandboxes**, not for every agent container. Its scope narrowed; its assertions
  did not, and it remains the gate for the case that matters.
- **[ADR 0002](0002-credential-and-isolation-architecture.md)** — "project =
  container = security boundary" is unaffected for projects. The control-plane
  container is now outside it, by decision rather than by accident.
- **[ADR 0014](0014-acp-secret-tools-approval-gated.md)** — chose approval
  gating over attestation for reaching a privileged capability from an agent
  turn. Neither mechanism is applied here: daemon access is unmediated. A future
  reader looking for the gate should know there is none, rather than assume the
  0014 pattern was reused.

## Rollout

1. **Durable frame identity and ingestion.** Add `turnId` / `frameSeq`, immutable
   Runner binding, contiguous/hash-consistent ingestion, transcript chunks, the
   DB receipt constraint, durability policy, and replay tests while the Runner
   remains in-process.
2. **Reconnect-safe control.** Add command IDs, acknowledgements, permission
   transitions, ambiguous-command handling, idempotent remote start, and lease
   epochs to the current socket transport.
3. **Sandbox supervisor.** Add the protected runtime mount and UID boundary,
   supervisor entrypoint, discovery state, and immutable per-turn directories
   without routing production sessions through it yet.
4. **Remote attach.** Extend `running_turns`, add the remote `RunnerClient`, and
   recover live handles before abandoned-turn settlement.
5. **Production routing.** Route project sessions through the supervisor, move
   warm-process and fail-safe permission ownership into the Sandbox, and leave
   Verity-self sessions on loopback.
6. **Hardening and fault matrix.** Remove the Server's turn-time `docker exec`
   dependency where possible and run crash tests at every append/commit/ACK/lease
   boundary.

Each stage is independently shippable. Production routing stays behind an
explicit feature flag until the complete fault matrix passes.

## Acceptance tests

The release gate includes real process/container tests, not only loopback unit
tests:

1. Start a project turn, kill the Server with `SIGKILL`, let the agent continue,
   restart the Server, and observe the complete result exactly once.
2. Repeat with the crash after frame append but before DB commit, and after DB
   commit but before publish.
3. Lose the connection after steer injection but before ACK; verify one operator
   message and one agent-side effect.
4. Lose the connection after a permission decision but before ACK; verify no
   auto-allow and one decision.
5. Finish the turn while the Server is offline; verify terminal recovery and
   transactional marker closure.
6. Race old and new Servers through independent PostgreSQL pools; verify an
   overlapping frame is claimed exactly once, conflicting terminal sequences
   serialize, and marker closure remains atomic. Separately verify only the
   highest controller lease epoch can control the Runner.
7. Attach Server N+1 to Runner N and reject an incompatible N+2 protocol before
   any cutover.
8. Attempt event/control forgery from project code and verify the protected
   runtime boundary rejects it. CI recreates the production UID/GID/mode layout
   in a root-isolated container and attacks the event stream, command journal,
   turn directory, and Unix control socket from the unprivileged agent UID.
9. Lose a remote-start ACK and verify the repeated `StartTurn` returns the same
   process; inject a frame gap or hash conflict and verify ingestion fails closed.
10. Crash the Runner in the command effect/journal window and verify the command
    becomes `ambiguous` instead of being repeated.
11. Recreate a Sandbox from the persisted transcript and verify backend resume
    without direct Runner access to PostgreSQL.

### Fault-matrix audit (2026-07-20)

The audit distinguishes a mechanism test from a real process or container
boundary. A native worker adapter being present is necessary for the opt-in
supervisor transport, but does **not** by itself make that backend release-ready.

| # | Automated evidence | Boundary | Status |
|---|---|---|---|
| 1, 5 | `test-runner-claude-live-container.sh` — production Sandbox stack, real Claude ACP adapter over the spawn broker, Server-A container `SIGKILL`, offline completion, Server-B replay, terminal marker closure, and a credential-free assertion inside the Claude process; `two-server-cutover-postgres.test.ts` retains backend-neutral lease checks | managed project container + separate Server containers + PostgreSQL + real ACP/file/control transport | covered for Claude ACP |
| 2 | `turn-survival.test.ts` S2/S4 | real store/transport seams; injected crash windows | covered at mechanism level |
| 3, 4 | `runner-control.test.ts` lost-ACK steer and permission retries | real Unix socket + durable command journal | covered |
| 6 | `runner-frames-postgres.test.ts` and `two-server-cutover-postgres.test.ts` | independent PostgreSQL pools + overlapping Server clients | covered |
| 7 | `runner-control.test.ts` protocol cutover cases | real Unix socket, N/N-1 wire behavior | covered |
| 8 | `scripts/test-runner-forgery-boundary.mjs`, invoked by the `server-image` CI job | root-isolated production image + unprivileged agent UID | covered |
| 9 | `runner-supervisor-feature.test.ts` lost StartTurn ACK plus `runner-frames.test.ts` gap/hash rejection | real supervisor/worker process for ACK; real store for frame validation | covered |
| 10 | `runner-control.test.ts` effect/journal crash window | durable journal fault injection | covered |
| 11 | `test-runner-claude-live-recreate.sh`, backed by `runner-transcript.test.ts` and resume assertions in `runner-supervisor-feature.test.ts` | old managed Sandbox and runtime volume removed; fresh Sandbox restores from PostgreSQL before a real `claude-agent-acp` resume, with no database environment or credentials reaching Claude | covered for Claude ACP |

Backend release readiness is therefore explicit:

| Backend | Supervisor transport | Server restart/cutover | Sandbox recreate continuity | Release status |
|---|---|---|---|---|
| Claude | ACP worker for every managed project session plus a dedicated isolated control-plane supervisor | managed-container live smoke covers the real ACP adapter, Server `SIGKILL`, offline completion, replay, exactly-once settlement, and credential scrubbing | managed-container recreate smoke removes the entire Sandbox and Runner runtime, restores the transcript from PostgreSQL into a fresh runtime, and verifies ACP resume | ACP-only; project and control-plane turns fail closed without their supervisor |
| Codex | native worker | generic file/control cutover covered | managed-container recreate smoke persists rollout JSONL in PostgreSQL and restores it into a fresh `CODEX_HOME` before native resume | recreate gate covered |
| OpenCode | HTTP server client, no native worker | outside this supervisor transport | not evaluated by this ADR gate | unchanged loopback/HTTP path |
| Pi | no native worker | outside this supervisor transport | not evaluated by this ADR gate | unchanged loopback path |

Consequently fresh deployments enable `VERITY_RUNNER_SUPERVISOR` by default. Claude
has passed the ACP restart and recreate release gates and has no native production
fallback; setting the supervisor flag to `0` intentionally disables Claude. Existing
deployments whose immutable spec was sealed without `CAP_CHOWN` must be reinstalled
before Claude can run. Codex has passed the recreate gate, with its rollout state
restored server-side and no database access in the worker. The managed-project-
container smokes are enforced by CI.

Claude's former stateless helper-query implementation (`claude -p`) is deliberately
absent: it ran in the Server rather than through the supervised ACP boundary. Auto-
title and task-refinement callers use their existing no-query fallback. Reintroducing
Claude helper queries requires a dedicated supervisor protocol and may not restore
the native process path.

## Consequences

**Positive:** project agents survive Server restarts and updates; output is
durable before DB ingestion; control operations become reconnect-safe; transcript
handling moves to the filesystem where the backend actually writes; the Server
can eventually lose project-container `exec` authority.

**Negative:** a new long-lived process and protocol must be maintained across
versions; the store gains idempotency receipts and lease state; filesystem
durability adds bounded sync overhead; fault-injection coverage becomes a release
requirement.

## Rejected alternatives

- **Spawner-only remote exec:** the Server still owns stdout, permission state,
  and the child pipe, so a Server exit still terminates the turn.
- **Runner writes directly to PostgreSQL:** expands DB credentials into every
  Sandbox and breaks the Server-only persistence boundary.
- **Workspace-hosted runtime files:** project code could forge events and control
  operations.
- **Byte offset as the replay authority:** offsets are lost or stale across
  crashes and cannot make DB effects idempotent.
- **Fire-and-forget control:** cannot distinguish delivery from lost ACK and
  duplicates operator intent.
- **Interrupt-and-retry after update:** violates the operator requirement and can
  repeat external agent side effects.

## Related

- [ADR 0002](0002-credential-and-isolation-architecture.md) — credential and
  Docker-socket boundary.
- [ADR 0005](0005-naming-and-layering.md) — Server, Runner, and Sandbox naming.
- [ADR 0008](0008-verity-server-self-update.md) — Gateway, Updater, cutover, and
  rollback built on restart-surviving Runners.
- [ADR 0014](0014-acp-secret-tools-approval-gated.md) — approval gating as the
  alternative to attestation when an agent turn reaches a privileged capability;
  see Amendment 1 for why it is not applied to the Docker socket.
