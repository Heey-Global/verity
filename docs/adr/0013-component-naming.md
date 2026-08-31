# ADR 0013 — Component Naming Across Packages, Images and Runtime

**Status:** Accepted · **Date:** 2026-07-31

## Context

[ADR 0005](0005-naming-and-layering.md) fixed the *conceptual* vocabulary — Server, Runner,
Sandbox, Session. It did not say how those names must appear on the artifacts we build and run,
and that is where the drift is. An inventory of the repository found:

- **The Server is named three different ways at once.** Compose service `verity`, published image
  `verity-server`, running container `verity-verity-1`.
- **Sandboxes are the only runtime containers without a role prefix.** Everything else is
  `verity-relay-…`, `verity-preview-…`, `verity-secret-job-…`, `verity-meeting-…`; a Sandbox is
  `verity-<project>`. In `docker ps` a Sandbox and the Server are not distinguishable by name.
- **One component carried two names.** `packages/broker-relay` — package, image, Dockerfile, CI
  workflow — was the same thing the server, the env vars, the docs and the smoke scripts all call
  the *project relay*. Someone searching `VERITY_PROJECT_RELAY_IMAGE` did not find the package that
  builds it.
- **One package holds two deployables on opposite sides of the trust boundary.**
  `packages/preview-tunnel` contains both the public edge (runs on our infrastructure) and the
  connector (runs on the customer's).
- **"Broker" meant five unrelated things**, so it identified nothing.

None of this is ambiguity in the *concepts*. It is the same concept wearing a different name on
each surface it appears.

## Scope

How a component is named on its package, image, Compose service, container, and labels. Not what
the concepts are — that is ADR 0005 — and not the wire protocol vocabulary.

## Decision

### D1 — One component, one name, on every surface

A component's package directory, npm name, Dockerfile, published image, Compose service, container
name prefix and `verity.component` label all carry the same name.

The failure this prevents is not aesthetic. Runtime containers are found again by name and label; a
component that is called one thing in the code and another in the label is a component whose
running instances the code cannot reliably match.

### D2 — Roles come from a closed vocabulary

A name is `verity-<role>`, and the role is one of:

| Role | What it denotes |
| --- | --- |
| `server` | the control plane |
| `sandbox` | where agent and customer code runs |
| `gateway` | a passage that enforces policy on traffic crossing it |
| `relay` | forwards traffic for one project, without policy |
| `edge` | a publicly reachable entry point |
| `connector` | dials outward from inside an isolated environment |
| `uplink` | the connection to our own infrastructure, and the service on its far end |
| `broker` | mediates privileged operations a caller may not perform itself |

Adding a role is a deliberate act, not a side effect of naming a new file. A new component takes an
existing role unless it genuinely is a new kind of thing.

The words already carried these meanings; this decision only closes the list. Note that `broker`
remains correct for three distinct mechanisms — the internal operation socket, Brokered Secrets, and
the agent-spawn socket — because each of them really does mediate privileged operations. A word used
several times *correctly* is not overloading, and is not a reason to rename.

### D3 — Runtime containers are `verity-<role>-<id>`, without exception

Including Sandboxes. `docker ps` on a Verity host must let a reader tell what each container is from
its name alone, without consulting labels.

### D4 — One package, one deployable

A package that produces two images, or that spans the trust boundary between our infrastructure and
the customer's, is split. `packages/preview-tunnel` is the open case: the edge belongs on the closed
side (ADR 0012), the connector on the open one.

## Consequences

Already applied under these rules:

- `broker-relay` → `project-relay` across package, image, Dockerfile, workflow, smoke script and the
  `verity.component` label (D1).
- The subscription service in ADR 0012 was renamed from *Broker* to **Uplink** (D2): "broker" said
  only that something mediates, which is true of most of the system.

Still to follow:

- Compose service `verity` → `verity-server` (D1).
- Sandbox containers `verity-<project>` → `verity-sandbox-<project>` (D3).
- `packages/preview-tunnel` split into `preview-edge` and `preview-connector` (D4).
- Retire the legacy `heey-global/verity-sandbox` registry path left by the namespace migration in
  favour of the namespaced `heey-global/verity/verity-sandbox` (D1).

**Renaming a label or a container prefix orphans running instances.** The reconciler finds relays and
Sandboxes by name and label, so instances created under the old name become invisible to it and keep
holding their network aliases. Every rename under D1 or D3 is therefore a recreate-after-deploy, and
the remaining ones should be batched rather than taken one at a time.

A rename that only makes the old instances invisible is not finished: a relay carrying the old label
also falls on the *sandbox* side of every "is this a relay?" test, so it vouches for its own
generation and no sweep can reach it. The relay rename therefore keeps matching the previous label
for collection — in the adapter's supersede sweep, the daily GC and the cutover check — while only
ever minting the new one. Later renames under D1 or D3 should carry the same one-release grace, and
may drop it once no instance predating the rename can still be running.

## Rejected alternatives

**Invent a new vocabulary.** The existing words are good and each already means something distinct;
the problem was that they were not held to. A new scheme would have replaced a drift problem with a
migration problem.

**Amend ADR 0005 instead.** It is still *Proposed*, and it describes a target model — the Runner
moving into the Sandbox — that has not happened. Folding accepted artifact-naming rules into a
proposed conceptual ADR would have made both harder to read, and neither easy to supersede.

**Rename every occurrence of an overloaded word.** Rejected for `broker` specifically: three of its
uses are correct. Renaming things that are named right is churn, not cleanup.

## Related

- [ADR 0005 — Naming & Layering](0005-naming-and-layering.md) — the conceptual roles this builds on.
- ADR 0012 — Subscription Uplink (maintained separately) — the trust boundary that D4 splits
  packages along.
