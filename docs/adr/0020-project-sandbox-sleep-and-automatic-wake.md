# ADR 0020 — Project Sandbox Sleep and Automatic Wake

**Status:** Proposed · **Date:** 2026-09-15

This ADR defines intended behavior and implementation boundaries; it does not
describe functionality that is already available.

## Context

Verity should be able to stop an idle project Sandbox without removing its
container. A stopped Sandbox consumes no project CPU and no resident process
memory, while its container filesystem and host-backed project checkout remain
available for a fast restart.

When a user sends a turn to a session whose project is sleeping, Verity wakes
the project automatically. The turn remains durably queued until the Sandbox,
project relay, Runner, and freshly issued capabilities are ready. The user does
not have to wake the project manually and the turn must not be lost if fast wake
fails.

Sleep is distinct from the existing pause/deprovision operation:

| State | Container | Checkout | Credentials | Resume path |
| --- | --- | --- | --- | --- |
| `active` | Running | Retained | Active generation | None |
| `sleeping` | Stopped and retained | Retained | Revoked | Fast wake |
| `absent` | Removed | Retained unless purged | Revoked | Full provision |

## Decision

Verity will introduce a durable project Sandbox sleep state that retains a
stopped container and its writable layer. Sandbox-dependent work, including a
new session turn and a scheduled agent loop, will pass through one readiness
gate that wakes a sleeping project before execution. Wake will preserve the
container-bound relay generation, refresh rotatable capabilities, verify
compatibility and readiness, and fall back to full provisioning whenever reuse
is unsafe.

Automatic sleep will use activity leases rather than timestamps alone. Active
turns, permission decisions, lifecycle mutations, explicitly retained
development servers, and every unexpired, unrevoked public preview share will
block sleep. Software updates will not wake stopped Sandboxes; an incompatible
sleeping container will receive the update through cold provisioning when work
next arrives.

## Goals

- Reclaim the RAM and CPU of inactive project Sandboxes.
- Wake a sleeping project automatically when work arrives.
- Preserve the stopped container's writable layer and cached project tooling.
- Never execute a turn before the refreshed authorization boundary is ready.
- Coalesce concurrent wake requests into one operation per project.
- Fall back safely to full provisioning when the retained container cannot be
  reused.
- Keep explicit pause/deprovision behavior available for reclaiming disk or
  applying incompatible changes.

## Non-goals

- Preserving live process memory. This is stop/start, not checkpoint/restore.
- Preserving running development servers across sleep.
- Moving a sleeping container between hosts.
- Sleeping a Sandbox while an agent turn or other protected project operation
  is running.
- Replacing backup and restore or host-level high availability.

## State model

Add these durable project states:

- `sleeping`: the expected container exists but is stopped, and all rotatable
  capabilities of its previous epoch have been revoked. Its relay generation is
  retained, because the stopped container cannot be re-addressed to a new one.
- `sleeping_starting`: the sleep transition owns the project. It exists so that
  state reconciliation, which reads a stopped container under an `active`
  project as a failure, cannot demote a project that is on its way to sleep.
- `waking`: one server process owns a wake attempt. New work joins that attempt.
- `sleeping_pending`: optional internal state indicating that an idle deadline
  has passed but an operation currently prevents sleep. This may instead be an
  in-memory scheduler concern if no UI needs to expose it.

The core transitions are:

```text
active --idle/manual sleep--> sleeping --incoming work/manual wake--> waking
   ^                              |                                      |
   |                              | explicit pause                       | ready
   |                              v                                      |
   +-------------------------- absent <----- fallback provision ---------+
```

`waking` must be crash-recoverable. On Server startup, reconciliation inspects
the expected container:

- a compatible stopped container returns to `sleeping` and can be retried;
- a compatible running and ready container completes as `active`;
- a missing or incompatible container enters the normal provision path;
- an ambiguous or unsafe container is removed before provisioning.

## Entering sleep

Sleep is allowed only when all of the following are true:

- no agent turn is starting, running, cancelling, or awaiting a permission
  decision;
- no project lifecycle, branch mutation, secret job, or container replacement
  operation holds the project activity lease;
- no public preview share is active for the project;
- no development server is configured to keep the project awake;
- no explicit project policy disables automatic sleep.

An active share is one that is neither revoked nor expired. It keeps the project
awake on its own, independently of any dev-server condition: a share is bound to
one container generation and serves only while that sandbox runs, so stopping the
sandbox breaks a link that has already been handed to someone outside Verity.
The dev-server rule does not subsume this. A share may target a static folder
rather than a dev server, and that variant needs the running sandbox without any
dev server being configured at all. Sleep eligibility therefore queries active
shares directly.

Because shares carry their own expiry, this keep-awake condition clears itself.
A project whose last share expires becomes sleep-eligible at the next idle
evaluation with no explicit revocation required.

The sleep operation runs under the existing per-project lifecycle
serialization and performs these steps:

1. Atomically prevent new project work from starting. Work arriving after this
   point waits for the sleep operation and then initiates wake.
2. Persist the sleep intent before touching Docker. State reconciliation treats
   a stopped container under an `active` project as a container failure, so a
   reconcile tick landing between the stop and the state write would demote the
   project to `failed`. The durable intent has to precede the stop, and
   reconciliation has to recognize it.
3. Quiesce the Runner and close the project relay.
4. Revoke every rotatable authority, including GitHub, commit-signing, MCP,
   Claude/Codex egress, and any later capability types.
5. Stop the Sandbox container without removing it, using an explicit stop rather
   than a kill of the container's main process. Sandboxes carry
   `restartPolicy: 'unless-stopped'`, which keeps an explicitly stopped
   container stopped across a Docker daemon restart or host reboot while still
   restoring genuinely active projects. Sleep depends on that distinction.
6. Verify that Docker reports the expected container as stopped.
7. Persist `sleeping` together with the retained container identity and its
   compatibility fingerprint.

Capability revocation remains fail-closed. If it fails, Verity must not report
the project as safely sleeping. The Sandbox is stopped, and the project enters
a retryable failed lifecycle state with an actionable error.

## Automatic wake on a session turn

Turn submission should separate durable acceptance from execution:

1. Validate and durably record the submitted user message and turn request.
2. Acquire or join `ensureProjectReady(projectId)`.
3. If the project is `active`, proceed normally.
4. If it is `sleeping`, atomically claim `waking`. Concurrent callers await the
   same in-flight promise; only one wake generation is created.
5. If it is already `waking`, join the existing wake operation.
6. Dispatch the turn only after readiness succeeds.

The client may show `Waking project...`, but no separate user action is
required. Cancellation while waking cancels the queued turn, not necessarily
the shared wake operation, because other turns may be waiting for it.

Other operations that require a running Sandbox should use the same
`ensureProjectReady` gate rather than implementing independent wake logic.

## Operations that must not silently skip a sleeping project

Introducing a state that is neither `active` nor `absent` changes the meaning of
every existing check written as "is this project active". Each one has to be
resolved deliberately as wake, wait, or refuse. Two are behavior regressions if
they are missed:

- **Scheduled agent loops.** The loop scheduler skips a run whose project is not
  `active`, records that outcome, and does not re-fire the tick — the database is
  the source of truth for what already fired. Because sleeping is the normal
  state of an idle project, a scheduled loop on a project nobody touched would
  stop running altogether rather than waking it. Loop execution must acquire
  `ensureProjectReady` and distinguish a sleeping project, which it wakes, from a
  failed or absent one, which it still skips.
- **Sandbox update status.** The update checker returns `unknown` for any project
  that is not `active`. Once most idle projects sleep, a fleet overview would
  report almost nothing. Sleeping projects need a real verdict computed against
  the retained container, marked as applying on wake rather than as an in-flight
  automatic repair.

The remaining call sites need an explicit decision recorded with the
implementation rather than a default: dev-server routes, which already separate
"container exists" from "container running" and must place sleeping on the
correct side of each; project-scoped maintenance and relay-repair sweeps, which
filter to active projects and should continue to leave sleepers alone; branch and
repository reads that reach into the Sandbox; and cross-project workflow
dispatch, whose target may be asleep.

Session-level health signalling needs the same treatment: a sleeping project must
not raise the `sandbox_disconnected` attention marker on its sessions. A sleeping
Sandbox is expected to be down, and a banner saying otherwise trains operators to
ignore the one case that matters.

## What a retained container fixes in place

Reuse is only possible for the parts of a Sandbox that Docker lets a stopped
container keep. Two of them are immutable after creation and therefore bound the
design:

- **The container generation.** A Sandbox is stamped with its relay generation as
  a label at creation, the relay's container name is derived from the project and
  that generation, and the Sandbox reaches the relay through environment
  variables carrying that name — the broker, project-memory, MCP and egress URLs.
  Labels and environment are fixed once a container exists, and the broker's Unix
  socket is addressed from the same generation. A retained container therefore
  keeps its generation. Minting a new relay generation during fast wake would
  leave the woken Sandbox addressing a relay that no longer exists.
- **Published dev-server ports.** Port bindings live in the container's host
  configuration and cannot be changed afterwards.

What remains rotatable is the capability material, because it is deliberately
projected as read-only file mounts at per-project host paths rather than as
environment values — the GitHub capability, the signing token, and the egress
client identity. Rewriting those files while the container is stopped is what
makes a fresh authorization possible without a fresh container.

The concept therefore separates two notions the container conflates:

- the **relay generation**, bound to container identity and stable across sleep;
- the **capability epoch**, rotated on every sleep and every wake.

## Fast wake sequence

Fast wake reuses the stopped container and its relay generation, and rotates the
capability epoch:

1. Inspect the retained container and verify ownership labels, stopped status,
   image identity, runtime, mounts, network contract, toolkit identity, and the
   stored compatibility fingerprint.
2. Reconcile the per-project Docker network. Verify — do not attempt to change —
   the container's published dev-server ports. A stopped container releases its
   host port binding, so a port it needs may have been taken while it slept; that
   is a wake failure and selects cold fallback, which reallocates.
3. Resume the relay for the retained generation and issue a new capability epoch
   bound to it. No new relay generation is created.
4. Replace the bind-mounted capability material while the container is stopped.
   No old raw capability may be reused.
5. Start the relay and Sandbox in an order that cannot expose a running Sandbox
   with redeemable stale authority.
6. Run the normal post-start projection required after every process start,
   including the Runner boundary attestation. Fast wake must not be a path that
   admits a Sandbox the cold path would have rejected.
7. Wait for explicit Runner and connector readiness, not merely Docker's
   `running` flag.
8. Persist `active` and release queued work.

Fast wake should target a p95 well under the cold provisioning path it replaces;
the measured figure, not the mechanism, is what justifies the feature. Phase 3
sets the number once the current cold path has been instrumented.

If a credential source itself has expired, the existing credential authority
refreshes it as part of gateway use. The Sandbox receives only the new broker
capabilities and public connection material; provider refresh tokens remain
outside the Sandbox as they do today.

## Compatibility fingerprint

A sleeping container may be reused only when its runtime contract still matches
the desired project configuration. Store a fingerprint derived from at least:

- selected image digest or derived devcontainer image identity;
- Sandbox runtime and security configuration;
- bind mounts and named-volume layout;
- network mode and required connector configuration;
- Runner toolkit identity;
- relevant project settings and published ports;
- Server-side sleep/wake contract version.

Do not include short-lived credential values in the fingerprint. A mismatch is
not an error: it selects cold fallback.

## Cold fallback

Fast wake falls back to full provisioning when the container is missing,
running unexpectedly, owned by another project, incompatible, corrupt, or
unable to pass readiness.

The fallback must:

1. Stop and revoke any partially created wake generation.
2. Remove the retained container safely.
3. Enter the existing provision path without accepting a second turn request.
4. Keep the original queued turn attached to the operation.
5. Execute that turn after provisioning succeeds, or mark it failed with the
   provisioning error.

This makes automatic wake reliable even across image updates and Server
upgrades. It also avoids maintaining compatibility migrations for arbitrary old
container generations.

## Software updates while a project sleeps

Sandbox updates are applied today by recreating the container: a new image, a new
Runner toolkit, or a rotated signing-broker token all reach a project that way,
and the reconciler rebuilds orphaned generations onto the current image. A
stopped container is pinned to whatever it was created with, so sleep and the
update path have to agree on who owns a stale sleeping sandbox.

Updates are applied lazily, at wake. Image identity and toolkit identity are
already part of the compatibility fingerprint, so a sleeping container whose
target has moved fails the fingerprint check and takes cold fallback, which
provisions onto the current image. No separate update mechanism is required and
no project is woken in order to be updated.

Waking is the only moment this has to happen, including for a security-labelled
update. A stopped container executes nothing, so a sleeping sandbox on a
superseded image is strictly less exposed than a running one on the same image.
Force-waking projects to patch them would create exposure in order to remove it.

Two existing behaviors must learn about the sleeping state:

- Automatic repair must not treat a sleeping sandbox as one to rebuild. Recreating
  or waking it to close an image gap defeats sleep entirely; the gap is closed by
  cold fallback at the next wake.
- Update status must report something true about a sleeping project. Today the
  checker answers `unknown` for anything not `active`, and the self-repair
  verdict `converging` promises an automatic repair that a sleeping project is
  not receiving. Neither is right: the gap is known, and it closes at the next
  wake.

A rotated signing-broker token is carried as a container label and is therefore
also a fingerprint input rather than something a wake can patch in place.

## Idle policy

Suggested defaults for an initial release:

- automatic sleep after 45 minutes without protected activity;
- no automatic sleep while a public preview share is active;
- no automatic sleep while a development server is running, subject to the
  auto-start rule below;
- per-project `keep awake` override;
- deployment-level enable/disable switch and idle duration;
- explicit `Sleep now` action;
- existing pause action continues to remove the container;
- optional later policy to deprovision sleeping containers after several days
  to reclaim disk.

A running development server cannot by itself hold a project awake. Dev servers
marked auto-start are started whenever the project environment starts, so a woken
project immediately runs one again; if that counted as keep-awake activity, the
project would sleep exactly once and never again. The keep-awake condition has to
distinguish a dev server someone is using — an active share, a recent request, or
an explicit per-server keep-awake flag — from one that merely exists because
auto-start recreated it. Waking must not re-arm the condition that prevents the
next sleep.

Activity should be represented by a per-project lease/counter rather than a
collection of loosely related timestamps. Starting protected work acquires a
lease; completion releases it. The scheduler may sleep a project only when the
lease count is zero and its last release is older than the configured timeout.

## Concurrency and failure rules

- Sleep, wake, deprovision, repair, update, and delete serialize on the same
  project lifecycle primitive.
- A turn accepted during sleep waits and then wakes the project; it must not race
  container stop.
- Multiple turns accepted while waking share one wake attempt and retain their
  normal session ordering.
- Explicit deprovision/delete wins over queued automatic wake according to the
  lifecycle lock; work that can no longer run receives a durable terminal
  outcome.
- Server shutdown leaves enough durable state for startup reconciliation. An
  in-memory promise is only a coalescing optimization, never the authority.
- Every external call in sleep/wake has a deadline and retry classification.

## API and user interface

Expose the lifecycle state in existing project responses. Suggested additions:

- `POST /projects/:id/sleep`
- `POST /projects/:id/wake` for diagnostics and explicit UI use
- project settings for idle timeout and `keepAwake`
- timestamps such as `lastActiveAt`, `sleepingSince`, and `wakeStartedAt`
- a concise wake/fallback status visible on the project and session screens

Normal session submission must not require clients to call the wake endpoint.
The endpoint is an administrative convenience; automatic readiness is the
server's responsibility.

The mobile app ships on its own release cadence, so a client that predates these
states will receive them. Its project-state handling enumerates the states it
knows, and an unrecognized value must degrade to something harmless rather than
to a blank or error screen. Either the new states arrive only in an additive
field alongside an existing state that older clients already render, or the
server reports `active` to clients that have not indicated support. Which of the
two is chosen belongs in this document before the API changes.

## Observability

Record structured lifecycle events and metrics for:

- sleep eligibility decisions and blockers;
- sleep duration;
- fast-wake latency and success rate;
- readiness-stage latency;
- cold-fallback reasons and duration;
- queued turns and time spent waiting for readiness;
- credential revocation or issuance failures.

Never log raw capability material or provider tokens.

## Implementation plan

### Phase 0: measure the current cold path

- Instrument today's provisioning path per stage: container create, relay start,
  capability issuance, boundary attestation, and readiness waits.
- Establish where the current minutes actually go. Stages that fast wake also
  performs are not removed by retaining a container, and if they dominate, the
  design target has to change before Phase 1 is built.

### Phase 1: explicit sleep and wake

- Add durable states and migrations.
- Audit every existing `active`-state check and record its resolution.
- Add lifecycle serialization and compatibility fingerprinting.
- Implement stop-without-remove plus fail-closed capability revocation.
- Implement fast wake, readiness checks, and cold fallback.
- Add explicit API actions and project-state UI.

### Phase 2: transparent turn wake

- Introduce the shared `ensureProjectReady` gate.
- Persist a turn before awaiting project readiness.
- Route session turns and other Sandbox-dependent actions through the gate.
- Add coalescing, cancellation, and crash-recovery tests.

### Phase 3: automatic idle sleep

- Add project activity leases and the idle scheduler.
- Add deployment and per-project policies.
- Add `keep awake` behavior for development servers.
- Measure actual memory reclaimed and wake latency before changing hosting
  capacity assumptions.

### Phase 4: disk reclamation

- Optionally transition long-sleeping projects through the existing
  deprovision-keep path.
- Retain cached images according to a separate disk-pressure policy.

## Required tests

- A sleeping Sandbox has been stopped but not removed.
- All old capabilities fail immediately after sleep.
- Sending a turn to a sleeping project wakes it and executes the turn once.
- Concurrent turns cause exactly one wake generation.
- A turn submitted during the sleep race is neither lost nor executed early.
- New capabilities work after wake and old capabilities remain rejected.
- Changed image, mounts, toolkit, or runtime configuration triggers cold
  fallback.
- Wake readiness failure cleans up the partial generation and provisions once.
- Server restart during `waking` reconciles safely.
- Explicit pause/delete cannot be undone by a queued wake.
- A running turn, permission prompt, lifecycle mutation, or keep-awake dev
  server prevents automatic sleep.
- An active preview share prevents automatic sleep, including a static-folder
  share on a project with no dev server configured.
- A share that expires or is revoked releases that block, and the project then
  becomes sleep-eligible.
- Waking a project whose image or toolkit moved during sleep provisions onto the
  current target instead of reusing the stale container.
- Automatic repair neither wakes nor recreates a sleeping sandbox to close an
  update gap, and reports that project as pending on wake rather than
  converging.
- A scheduled agent loop whose project is asleep wakes it and runs, instead of
  recording a skipped tick.
- State reconciliation leaves a sleeping project sleeping, including when a
  reconcile tick observes the stopped container during the sleep transition, and
  does not demote it to `failed`.
- A sleeping container is still stopped after a Docker daemon restart, while an
  active project's sandbox returns on its own.
- A woken project whose auto-start dev server comes back is still eligible for
  the next automatic sleep.
- Sessions of a sleeping project raise no `sandbox_disconnected` attention
  marker.
- A dev-server host port taken by something else during sleep produces a cold
  fallback, not a failed wake.
- A client that does not understand the new states still renders a sleeping
  project.

Before accepting the guard suite, deliberately break capability rotation,
container compatibility detection, and wake coalescing and confirm that the
corresponding tests fail.

## Open decisions

- Whether development servers always prevent sleep or may be explicitly marked
  disposable.
- Whether a long-lived share should be able to hold a project awake
  indefinitely, or whether share-held wakefulness needs its own ceiling.
- Whether revoking capabilities on sleep is worth the reissue it forces on every
  wake. A stopped Sandbox with a closed relay has no redemption path, so the
  rotation is defence in depth rather than a closed hole, and it is the most
  expensive step of waking.
- How a sleeping project's garbage-collection eligibility is expressed, so that a
  retained stopped Sandbox and its relay are not reaped as an abandoned pair.
- Whether reconciliation after a Server restart may keep a sleeping container, or
  whether the existing rebuild-every-sandbox behavior wins and sleep is simply
  lost on restart.
- Whether `sleeping_pending` needs to be durable and user-visible.
- How long a queued turn may wait for wake/provision before becoming terminal.
- Whether disk-pressure eviction is purely age-based or host-capacity-aware.
- Which non-turn project operations should wake automatically in the first
  release.
