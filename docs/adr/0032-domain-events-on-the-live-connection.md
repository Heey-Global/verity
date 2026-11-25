# ADR 0032: Domain events on the live connection

- Status: accepted
- Date: 2026-11-25
- Amends: [ADR 0026](0026-app-wide-live-connection.md),
  [ADR 0027](0027-live-resource-updates.md)

## Context

The same state appears in several places in the app: the Home overview, the
project page, project settings and the session itself. Secret requests, Quick
Actions (open `choices`), pull request and check status, sandbox provisioning
and the "sandbox needs update" hint are the visible examples.

Only the session transcript reaches the app as events. Everything else reaches
it in one of two indirect ways:

- **Overview hints** (ADR 0026) say that a session changed, without saying
  what. Each persisted event hints `events`, including every streamed text
  chunk, and the Home list answered every hint by reading the whole overview
  again.
- **Resource watches** (ADR 0027) make the server re-read an allowlisted GET
  route at a fixed interval (2–30 s), hash the response, and tell the app to
  read it again when the hash moves. Changes with no emitter — Docker
  lifecycle, the sandbox update target, forge status caches — surface only at
  the next sample.

The effects are visible staleness and avoidable traffic. A decision taken in a
session stays on Home and the project page until the next full read; a sandbox
that finished starting shows as starting for up to 15 s; a pull request opened
in a session shows on the project page after up to three cache lifetimes. The
overview reads were sent uncompressed and without validators, so a phone with
Home open while an agent streamed re-downloaded the full session list several
times a second.

## Decision

### Phase 0: cheaper reads

Before any protocol change, the overview reads become cheap to repeat:

- `/sessions`, `/projects` and `/projects/:id` are gzip-compressed and carry a
  weak ETag over their JSON (`private, no-cache`). The app revalidates them
  with `If-None-Match` and reuses its last body on `304`.
- The Home list reloads at once for `status`, `permission` and `session` hints,
  but at most every 10 s for hints that only report transcript growth.
- Settling a permission removes its request descriptor from the overview
  model as well as its id, so the Home card disappears with the decision. A
  refused decision does not hide the card elsewhere, because the request may
  still be pending on the server.
- The server logs outbound bytes per route pattern and per live frame kind
  every five minutes, so later phases are measured against a baseline.

### Topics and events

A process-local `DomainEventBus` sits beside the session event bus. It
publishes typed events on three kinds of topics:

- `user:<id>` — state that belongs to one person, such as their own requests.
- `project:<id>` — project, sandbox and project-wide pull request state.
- `session:<id>` — overview fields of one session.

Each event names one entity and carries a revision that increases with every
change of that entity, plus a small patch of overview fields. The first
catalogue is `session.summary`, `permission.requested`, `permission.decided`,
`choices.opened`, `choices.answered`, `pr.status`, `project.changed`,
`sandbox.lifecycle`, `sandbox.update` and `resync`.

Events are emitted where the state actually changes: the approval store, the
conductor's permission and choice handling, `updateProjectState` and the
provisioner, the sandbox update checker and reconciler, the forge status
caches, and project mutations. Hash sampling of a route is not an emitter.

### Patches, not only invalidations

Events carry the changed overview fields so every view can apply them without
another read. This departs from the content-free hints of ADR 0026, so
authorization moves to the subscription: the server checks a topic once on
subscribe, with the same policy the corresponding HTTP read uses, and again
when memberships, roles or devices change. A topic a connection may no longer
read ends with `forbidden`. Patches never contain fields the HTTP read would
withhold from that viewer, such as the input of a request the viewer may not
execute; those remain behind the HTTP read.

### Protocol

The live protocol gains version 2, announced in `ready`. A client subscribes
with `topics.sub` and the last cursor it applied per topic, and receives
`domain` frames with a per-topic cursor. The server keeps a bounded ring
buffer per topic. A client that reconnects within the buffer receives what it
missed; one that fell behind receives `resync` and reads the affected
snapshots through the existing HTTP routes. Version 1 clients keep hints and
resource watches unchanged.

### One store in the app

The app holds overview entities in one store keyed by id. Home, the project
page, project settings and the session screen read from it, so one event
updates every view at once. A patch applies only when its revision is newer
than the stored one; a snapshot read replaces the entity and its revision.

### Freshness classes

- **On open or after an action:** opening a session, a project or its pull
  request list asks for a fresh read that bypasses server caches, with
  single-flight and a two-second floor per entity. The result is also
  published as an event, so other devices benefit from the same read. After
  an action such as Allow, merge, push or rebuild, the server checks the
  affected state immediately.
- **In the background:** push only; the app does not poll.

### Forge status without webhooks

Webhooks are deferred. The server keeps polling forges, but only for observed
branches — those of an open session, of open pull requests in a project
someone is viewing, and those the pull-request-ready monitor needs — and
publishes the result as `pr.status`. Several viewers share one read.

## Consequences

- Resource watches remain for logs, meetings and updater progress. Migrated
  routes leave `packages/events/src/live-resources.ts`, and the body-sniffing
  provisioning cadence in the resource observer is removed with them.
- The 15-second client fallback applies only to servers without version 2.
- The bus is process-local, like the session bus. A multi-process deployment
  would replace it behind the same interface.
- A guard derived from the sources must show that every caller of
  `updateProjectState` emits an event; a new state writer that does not would
  otherwise reintroduce silent staleness.

## Verification

Phase 0 is covered by route-level tests of the validator and compression, a
guard that the overview routes keep the conditional option, client tests of
revalidation and credential isolation, and model tests of hint spacing and
permission settlement. Later phases add tests for resume gaps, topic
authorization including revocation, revision ordering, version 1
compatibility, and a two-socket integration test in which a decision on one
device clears the Home card on another within one second.
