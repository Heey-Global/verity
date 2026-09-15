# ADR 0018 — Knowledge Realms and Namespaces

**Status:** Proposed · **Date:** 2026-09-15

## Context

Operators keep durable knowledge outside the repositories an agent works in — an
Obsidian vault, a wiki, meeting notes, product decisions. They want agents to use it,
and they want two separations while doing so:

1. **Private and business knowledge must not mix.** A session working on a company
   repository must not have private notes in its context, and the reverse.
2. **Which runtime reaches which body of knowledge must be controllable.** The operator
   phrased this as "which LLM may access what".

### What exists today

- **Per-project agent memory** ([ADR 0008](0008-per-project-agent-memory.md), shipped).
  A single free-text blob in `project_settings.memory`
  (`packages/store/src/schema.ts:248`, cap `PROJECT_MEMORY_MAX_CHARS = 8_000`,
  `packages/store/src/store.ts:572`). The agent appends through
  `agent-seed/bin/verity-memory` against the capability-authenticated broker
  (`packages/server/src/project-memory-route.ts`); the Conductor folds it into the
  runtime system prompt once per fresh backend context
  (`packages/session/src/conductor.ts:5137`, attached at `:1294` and `:4497`).
- **HTTP MCP connections with a project binding.** `http_mcp_connections` is **global**
  (`schema.ts:90`) and `project_mcp_bindings` maps a connection to a project
  (`schema.ts:107`, cap of 16 enabled per project, `store.ts:5884`). The Conductor
  rewrites every bound connection into an internal proxy descriptor carrying only the
  connection id in `X-Verity-MCP-Binding` (`packages/server/src/embedded.ts:1284`,
  `packages/session/src/runner-mcp-servers.ts`). The proxy resolves the real upstream and
  its credential **server-side on every call**, from the internal connection identity
  rather than the request body (`packages/server/src/http-mcp-proxy.ts:188`,
  `packages/server/src/server.ts:4518`). The Sandbox never holds the credential and never
  names its own project.
- **Reference documents in Git.** [ADR 0009](0009-google-drive-sources.md) writes imported
  documents to `docs/reference/`, versioned and idempotent by name.

### What does not exist

- **Any scope above the project.** `ProjectsTable` (`schema.ts:130`) has no grouping
  column. ADR 0008 closed with the global tier explicitly out of scope: *"A truly
  cross-project ('global over all projects') memory … would need a separate channel."*
  That channel is what this ADR defines.
- **A model or runtime as an authorization principal.** The model is a project preference
  (`project_settings.default_model`, `schema.ts:242`) with a per-turn override
  (`server.ts:7307`). Claude, Codex and OpenCode sessions of one project share one
  Sandbox, one gh-token capability of one container generation, and one set of MCP
  bindings. Nothing in the authorization path can currently distinguish them.
- **A retrieval layer.** Search is full-text over the chat projection only, and the
  spike (`docs/search-performance-spike.md`) missed its latency targets for broad project
  and global queries at 20,000 projected messages.

## Decision

**Introduce `realm` as the operator-facing isolation scope above the project, express
durable external knowledge as `knowledge namespaces` bound to a realm, and keep the
content itself in external stores reached through the existing MCP gateway. Verity owns
the boundary and the audit trail; it does not become a knowledge store.**

### D1 — The scope above the project is a realm, and it is not called a workspace

A realm groups projects that may share knowledge. "Private" and "business" are realms.
A project belongs to exactly one.

The name matters here because `workspace` is already taken in this codebase and means
something else: the project checkout inside a Sandbox (`workspaceFolder` and
`workspaceMount` in `packages/server/src/provisioner.ts:243`, `:281`; `workspaceDir` in
`embedded.ts:4022`). [ADR 0013](0013-component-naming.md) D1 fixed one-name-one-thing for
components; the same rule is worth keeping for data scopes, and a `workspace_id` that
denotes a knowledge grouping while `workspaceFolder` denotes a directory is exactly the
drift ADR 0013 was written against.

### D2 — Realm assignment lives in `project_settings`, not in `projects`

```
project_settings.realm_id  TEXT NOT NULL REFERENCES realms(id)
```

`ProjectSettingsTable` exists precisely so that "GitHub/project sync can refresh lifecycle
metadata without touching local runtime preferences" (`schema.ts:219`). Realm assignment
is such a preference: the installation-sync upsert writes `projects` rows and would have
to be taught to preserve a column there, which is the kind of thing that is correct on the
day it is written and silently wrong after the next sync change. The migration creates one
real default-realm row and backfills a settings row for every project. Project creation must
create both records transactionally. There is no `NULL` sentinel: every authorization join
uses an ordinary non-null foreign key, and a missing settings row fails closed.

`realms` itself is minimal — `id`, `name`, `memory`, timestamps.

### D3 — Knowledge has three tiers and Verity stores only the first

| Tier | Content | Where it lives | How the agent reaches it |
| --- | --- | --- | --- |
| Facts | decisions, conventions, gotchas | `realms.memory` + `project_settings.memory` | injected at context init |
| Documents | specs, imported reference material | Git, `docs/reference/` (ADR 0009) | ordinary file tools |
| Corpus | vault, wiki, archive | external store, an MCP connection | on demand through the gateway |

Only the facts tier grows in this ADR. The documents tier is unchanged. The corpus tier is
configuration: a connection row, a namespace row, and the proxy that already exists.

Verity does not ingest, chunk, embed, index or edit the corpus. The retrieval evidence in
`docs/search-performance-spike.md` is that even full-text search over the chat projection
needs a query-plan optimization before it meets its targets; a general document-retrieval
layer is a product, not a feature, and the repository's product boundary places the
self-hosted core at running agent fleets. A plain-Markdown wiki read with ordinary tools is
also what an agent consumes best — the second-brain designs the operator cited work that
way rather than through a vector index.

### D4 — Namespaces bind a connection to a realm; enforcement stays in the proxy

```
knowledge_namespaces(id, realm_id, connection_id, label, mode, enabled)
   mode: 'read' | 'read_write'
```

A `read` namespace also carries a non-empty, operator-reviewed
`read_tool_allowlist`. The proxy parses MCP `tools/call` requests and rejects a tool whose
name is not on that allowlist before forwarding it. Discovery responses are filtered to the
same set. Connections that cannot provide a stable read-only tool set cannot be exposed as a
`read` namespace. `read_write` is a separate explicit mode, never the fallback when read-only
enforcement is unavailable.

A namespace connection must itself expose exactly one corpus, scoped by its upstream root or
credential. The same connection may belong to at most one namespace globally. Verity refuses
namespace creation unless the connection is marked `isolated_corpus` during an operator
verification step; the UI states that a tool allowlist does not partition its arguments. A
server that can search both private and business roots therefore needs two connection rows
with independently scoped upstream configuration. Verity does not claim to repair an upstream
credential that can escape its declared corpus.

The method policy is also fail-closed. A `read` namespace permits only MCP lifecycle traffic
(`initialize`, `notifications/initialized`, `ping`), `tools/list`, and allowlisted
`tools/call`; it rejects resources, prompts, completion, logging, sampling, elicitation and
unknown or extension methods. Supporting a read-only resource API later requires another
explicit method-and-identifier policy, not a broader wildcard.

JSON-RPC batch arrays are rejected for namespace connections in phase 1. Supporting them later
requires authorizing and pre-auditing every element before forwarding any element; mixed
partially authorized batches must fail as a unit.

At the Streamable HTTP layer, `POST` carries only the JSON-RPC methods above. `GET` (SSE) and
`DELETE` (cleanup) are allowed only for an upstream session id established through that same
resolved namespace, caller session and connection; arbitrary session ids fail closed. Audit
events record these as `transport:get` and `transport:delete` with no target name, linked to
the namespace and upstream session id. They confer no additional JSON-RPC method authority.

The proxy applies policy in both directions, including streamed `POST` responses and `GET`
SSE. Upstream responses must correlate to an outstanding authorized request. Upstream-initiated
requests (including sampling, elicitation and roots) are rejected, and notifications are
fail-closed to an explicit protocol list such as `notifications/tools/list_changed`; logging
messages and unknown extensions are dropped and audited. An upstream stream cannot acquire
authority that the client request policy denied.

Namespace access requires the proxy's trusted per-turn caller identity, not the project-scoped
container identity. The server mints the existing MCP proxy bearer for a specific
`{ sessionId, turnId, projectId, sessionRealmId }`; `mcpProxyResolveCaller` validates it and
supplies those fields to descriptor resolution, transport-session binding and audit. A bearer
cannot be used after its turn or from a different session. Any backend path that currently
reaches the proxy with project identity alone must gain this per-turn binding before namespace
descriptors are enabled; project identity is insufficient and fails closed.

`project_mcp_bindings` stays as it is for project-specific tools. A shared resolver produces
the deduplicated union of direct bindings and enabled namespaces for a project. The Conductor
uses that resolver when building MCP descriptors in `embedded.ts`; descriptors carry the
opaque connection id only, as today. `resolveConnection` in `server.ts:4518` uses the same
resolver on every call and derives the namespace mode and allowlist from server-side rows.
No Sandbox-facing descriptor or request field is accepted as policy input.

That location is the whole point of the design. It already re-resolves the binding on
**every** proxied call, against `identity.projectId` taken from the internal connection
identity rather than from anything the Sandbox says (`http-mcp-proxy.ts:188`). A namespace
check placed there inherits that property unchanged: a Sandbox cannot name its own realm
any more than it can name its own project, and revoking a namespace takes effect on the
next call rather than on the next session. The existing cap of 16 enabled connections per
project (`store.ts:5884`) becomes a union-aware invariant. Enabling a namespace or moving a
project validates the resulting deduplicated union for every affected project and rejects the
write if any would exceed 16; descriptor construction asserts the same bound fail closed.

A realm move is a session-generation boundary, not a metadata-only update. Its preflight locks
the project and validates the target realm, namespace union, direct-binding conflicts and
hosted Learning Loops before setting `realm_move_pending`, which refuses new turns and
configuration writes. The server then stops active turns and tears down backend contexts;
failure clears the pending flag while sessions remain resumable in the unchanged old realm.
Only after every context is confirmed stopped does one transaction revalidate the locked
inputs, permanently close the existing sessions and change membership atomically. Closed
transcripts remain visible as history but cannot seed a backend context or call MCP. This
prevents a failed move from destroying resumability and prevents old-realm memory, messages or
fetched corpus data from entering a context with new-realm authority.

That final transaction also creates a fresh `kind = 'agent_loop'` session in the target realm
for every standard Agent Loop and repoints its `session_id`; run history stays attached to the
loop. Provisioning may occur later through the existing session path. Learning Loops must have
been rehosted during preflight and are not rebound implicitly.

`sessions.realm_id` snapshots the project's non-null realm at session creation and never
changes. Every agent-mediated cross-project path — session discovery, progress, recent-message
observation, handoff, dispatch and future transcript tools — resolves the caller session and
requires its `realm_id` to equal the target session's. Pre-move sessions therefore remain in
their old realm and are excluded from new-realm agent reads even though their transcripts are
retained. Direct operator UI/API access may list historical sessions across realms because it
uses operator authentication rather than a session capability; it must not turn that access
into content delivered to an agent without the same-realm check.

Policy provenance is unique rather than composed. `connection_id` is globally unique in
`knowledge_namespaces`, and
enabling a namespace is rejected if that connection is directly bound to **any** project,
regardless of realm. Creating a direct binding is rejected if any namespace globally names
the connection. Realm moves revalidate these global invariants as part of preflight.
Thus every reachable connection is authorized by exactly one direct binding or one namespace;
the proxy never has to merge a write policy with a read policy.

### D5 — Realm memory is read with a scope check; only the operator writes it

`projectMemoryPrompt` (`conductor.ts:5137`) becomes a two-part read — the realm block resolved
from immutable `session.realmId`, then the project block resolved from `session.projectId`.
For a dispatchable session the server also requires the project's current realm to equal the
snapshot; closed historical sessions cannot initialize a backend. The session states nothing.
Both blocks keep the ADR 0008 framing (`operator-curated; may be stale — verify before relying
on it`), and an empty realm memory emits no header, as today.

**Agent writes stay project-scoped.** `verity-memory append` continues to write
`project_settings.memory` only; realm memory is written by the operator in the UI. ADR
0008's Security section already records that agent-written memory is a durable
influence channel at system-prompt altitude, injected before the operator reviews it. At
realm altitude that channel would let one compromised turn plant standing text in the
system prompt of **every sibling project in the realm** — the blast radius ADR 0008 bounded
by keeping the capability project-bound. Widening the read scope is the feature; widening
the write scope is not, and they are separable.

### D6 — The model is not an authorization principal; the realm is

"Which LLM may access what" cannot be implemented as a per-model flag inside a project, and
this ADR states that rather than shipping a control that reads stronger than it is. Within
one project there is one Sandbox, one capability, one container generation and one set of
bindings; the backend choice is a per-turn parameter resolved after all of that
(`server.ts:7307`). Worse, an in-context filter is not a boundary at all: anything injected
or fetched into a context is readable by the model, and prompt injection defeats filtering
applied after the fact.

**The decision is that runtime separation is expressed by realm membership** — put the
private projects in the private realm and give that realm only the namespaces and the
runtimes it should have. A realm may additionally declare an allowed runtime set through a
normalized relation:

```
realm_allowed_runtimes(realm_id, runtime)  PRIMARY KEY (realm_id, runtime)
```

No rows for a realm means unrestricted. `runtime` is validated against the server's canonical
backend identifiers at write time; unknown values are rejected rather than ignored.

enforced by one shared realm-aware model validator used by every creation, dispatch,
existing-session model change, per-turn override, handoff and Agent Loop reaction path
(including `server.ts:4659`, `:7049`, `:7307`, `:7674`). No caller may resolve or persist a
model without it. This is a **configuration guard**, not a containment boundary: it stops an operator from
accidentally opening a private-realm session on a runtime they did not intend, and it is
worth having for that reason alone. It must not be documented as preventing a model that
already has a context from reading what is in it.

### D7 — Every namespace call is recorded against its realm

The proxy sees every call already. It appends a row to a dedicated
`knowledge_namespace_audit` event table containing `{ requestId, phase, realmId, namespaceId,
projectId, sessionId, turnId, connectionId, method, targetName, namespaceMode, outcome,
denialReason, createdAt }`. `phase` is `request` or `outcome`; an outcome event links to its request by
`requestId`, and only outcome events carry `outcome`/`denialReason`. `targetName` is the
validated tool or resource identifier when the method has one. Events form a per-realm hash
chain using the same sequence/previous-hash/event-hash shape as the Brokered Secrets audit
trail. Phase 1 does not prune this chain; a future retention policy must first define and
retain verifiable checkpoints across deleted prefixes. Without this, "did a session in the business realm read my private notes" has no
durable answer, and a separation nobody can verify is a separation nobody should trust.

Auditing is fail-closed before side effects: the proxy must append a hash-chained request
event before forwarding and refuses the call if that write fails. It appends a linked outcome
event afterward. If the outcome write fails after the upstream already answered, the durable
request has no linked outcome and is therefore reported as `unknown`; a retry worker may
append the result later; it is never silently treated as success. Thus every forwarded access
has a durable intent record even across a database failure that occurs after forwarding.

## Alternatives considered

- **A Verity-native knowledge store** (ingest, chunking, embeddings, search, an editor).
  Rejected: it is a second product beside the control plane, the search spike shows the
  retrieval work is not incidental, and it competes with tools the operator already runs.
  The facts tier in D3 is the small part of it that genuinely belongs in Verity, because it
  is the part that must be in the system prompt.
- **A per-model ACL inside a project.** Rejected in D6 — there is no principal to attach it
  to, and it would misrepresent an in-context filter as a boundary.
- **One shared store with per-document `visibility: private | business` tags.** Rejected: a
  filter over a shared corpus fails open — a mistagged, newly added or renamed document is
  visible by default. Separate namespaces fail closed, which is the correct direction for a
  separation whose failure mode is a private note in a business context.
- **`project_mcp_bindings` alone, with a naming convention.** Rejected: without a scope
  there is nothing to enforce, every new project must be wired by hand, and forgetting one
  is silent.
- **Realm as a full multi-tenancy boundary** (per-realm keys, per-realm users, separate
  secret scopes). Deferred. Verity's authentication identifies a device credential, not a
  user — ADR 0015 records the same gap — so per-realm authority has nothing to hang on yet.
  This ADR keeps realms as an operator-facing grouping over the isolation Verity already
  has (the per-project Sandbox), and claims no more than that.
- **A dedicated realm-write capability for agents.** Deferred with D5; this is the thing to
  reach for if realm memory turns out to need agent writes.

## Consequences

- One migration: `realms`, `knowledge_namespaces`, `knowledge_namespace_audit`, non-null
  `project_settings.realm_id`, immutable `sessions.realm_id`, and `realm_allowed_runtimes`,
  including the seeded default realm and settings/session backfill. Audit appends serialize on
  a locked per-realm chain-head row before assigning the next sequence and hashes, matching
  the Brokered Secrets audit's concurrency discipline.
- Four code seams, all extensions of existing ones: shared descriptor/connection resolution,
  proxy policy enforcement (`server.ts:4518`), the two-part memory read
  (`conductor.ts:5137`), and the model-resolution guard (`server.ts:4659`, `:7307`). No new
  broker or transport; namespace enablement requires the existing MCP proxy bearer to carry
  the per-session/turn caller binding on every backend.
- The system prompt grows by the realm memory once per fresh backend context — the same
  cadence and cap mechanism as ADR 0008, not per turn. Realm and project memory are each
  capped at 8,000 characters, making their combined injected payload at most 16,000
  characters before fixed framing.
- The private/business separation is exactly as strong as the per-project Sandbox boundary
  operators already rely on. This ADR adds no isolation; it makes an existing boundary
  addressable and prevents knowledge from being wired across it by hand.
- Realm memory is a wider injection surface than project memory. Restricting writes to the
  operator (D5) bounds who can place text there; it does not make the text trustworthy, and
  the prompt framing stays advisory.
- No retrieval is delivered. An operator who wants semantic search over the corpus gets it
  from the external store, through the same namespace.
- UI work: a realm screen, a realm picker in Project Settings, and namespace management
  beside the existing MCP connection screen (`packages/server/src/http-mcp-connections-route.ts`,
  `packages/mobile/src/api.ts:2389`).

## Scope / open questions

- Whether the `control_plane` project (`schema.ts:139`) starts in the seeded default realm or
  gets a dedicated realm during migration.
- Whether `allowed_runtimes` ships in phase 1 or follows the namespace work.
- How allowlist drift is presented when an upstream renames a tool. The fail-closed behavior
  is fixed: an unknown name remains unavailable until the operator reviews and updates the
  namespace. Phase 1 may ship `read` only and defer write namespaces.
- Whether the realm should eventually scope brokered secrets and Doppler bindings, which are
  per-project today. Likely yes, and it would be the first real test of realm as an
  authority boundary rather than a grouping.
- Which external store is validated first (an Obsidian vault behind an MCP server is the
  assumed shape) and whether its MCP server is something we ship or something the operator
  runs.
