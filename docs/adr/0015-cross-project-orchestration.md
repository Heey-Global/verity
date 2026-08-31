# ADR 0015: Durable cross-project orchestration

- Status: proposed
- Date: 2026-08-23
- Relates to: ADR 0002 (credential and isolation architecture), ADR 0006
  (Runner extraction), ADR 0011 (pragmatic secret brokerage)

## Context

Verity can run isolated sessions in repository projects and in the control-plane
project, but it cannot durably coordinate one outcome across several projects. A
control-plane session can describe a sequence in chat, yet chat history is neither a
workflow engine nor an authorization boundary. Process restarts, expired sessions,
missed provider events, and concurrent updates can therefore lose progress or repeat
mutations.

The first required delivery flow is deliberately narrow:

```text
source change -> source PR/CI -> immutable image digest -> GitOps change
-> GitOps PR/CI -> merge decision -> Argo CD reconciliation -> health verification
```

The repositories involved must retain their existing instructions, credentials,
sandbox, review rules, and ownership. The control plane must not mount their
worktrees or inherit their secrets. Codex subagents remain local to one session and
are not the persistence or authorization mechanism for this feature.

Existing Verity facilities provide useful foundations but do not implement this
workflow:

- sessions already belong to one project and one worktree;
- projects already bind a canonical repository and runtime;
- PostgreSQL/Kysely provides durable transactional state;
- the GitHub REST client resolves a pull request head SHA and check status, but its
  short-lived cache is a UI projection rather than durable gate evidence;
- project-bound opaque capabilities and approval audit records provide patterns for
  attenuated authority, but their existing tokens must not be reused for handoffs;
- there is no general provider webhook inbox, workflow outbox, OCI provenance
  verifier, or Argo CD integration;
- current authentication identifies a device credential, not a workspace user with
  a project/environment authority lattice.

## Decision

### D1 — Verity owns a durable workflow aggregate

Cross-project orchestration is a Verity platform capability backed by dedicated
PostgreSQL tables. It is not encoded in prompts, session events, repository files,
or a permanently running control-plane session.

The aggregate contains workflows, steps, attempts, immutable handoffs, typed
artifacts, structured results, policy decisions, leases, idempotency records, an
append-only workflow event stream, a provider inbox, and a dispatch outbox.

Every state-changing command carries an idempotency key. Workflow mutation uses
optimistic concurrency on a monotonically increasing workflow version. A transition
that makes external work dispatchable and its outbox record are committed in one
transaction. Provider deliveries are persisted before reduction and deduplicated by
provider plus delivery ID.

Session events remain session-scoped and are not overloaded with provider or
workflow events.

### D2 — The MVP uses one fixed serial template

The MVP does not expose a general DAG editor or execute user-authored workflow code.
It supports one versioned, service-owned template:

```text
source session -> source PR/CI -> image verification -> GitOps session
-> GitOps PR/CI -> merge decision -> Argo CD health -> completion
```

Its only mutating handoff kinds are `source.change.v1` and
`gitops.image-update.v1`. One bounded retry is allowed per step. Fan-out,
cross-workflow artifact reuse, automatic rollback, plugin steps, and parallel writes
to the same repository are deferred.

Templates may later become administrator-managed records, but the initial schema
must record a template kind and version so stored workflows remain interpretable
after code changes.

### D3 — Mutations run only in fresh target-project sessions

The workflow service asks the existing project/session provisioning boundary to
create a fresh session in the target project. The session receives an immutable
handoff as Verity-owned session metadata, not as an editable repository file. The
coordinator can read the structured result and named evidence, not arbitrary target
files, credentials, or worktrees.

A handoff capability is a new token type. It is distinct from GitHub-token,
git-signing, memory, and secret-job capabilities. Only its hash is stored. Its
server-side binding includes:

- workflow, step, attempt, handoff, and target project IDs;
- handoff kind and allowed artifact references;
- permitted result operation;
- expiry and container/session generation where applicable.

It cannot create workflows or sibling steps, select another project, mint provider
credentials, merge, deploy, or expand its own claims.

### D4 — Registry relationships are administrator-owned policy

The project/service registry is stored as validated Verity configuration and changed
only through an administrator-authorized path. A model-proposed handoff is never a
source of authority.

For the MVP, a registry relationship binds a service to:

- its source project and canonical repository;
- its OCI repository;
- one GitOps project and canonical repository per environment;
- the only allowed manifest path prefix;
- the Argo CD application identity; and
- accepted handoff kinds.

Dispatch validates the relationship again immediately before launch. The launcher
resolves the worktree, repository, and container image from the registered project;
no handoff field may override them.

### D5 — Completion and gate satisfaction are separate

A target session submits a schema-validated result with one of `completed`,
`blocked`, `failed`, or `cancelled`. Natural-language output may explain the result
but cannot advance workflow state.

`completed` means only that the local handoff contract was fulfilled. CI, merge,
artifact existence, deployment, and health remain independently verified gates.
Every provider gate binds to immutable coordinates, including repository, pull
request, exact head SHA, source commit, image digest, desired Git revision, and Argo
CD observed revision as applicable. A force-push or changed input invalidates stale
evidence.

The workflow reaches `succeeded` only when its final health contract passes for the
expected observed revision. Generic Pod readiness may be one signal but is not by
itself a universal application health contract.

### D6 — Provider transitions are event-driven with bounded reconciliation

Authenticated provider events are the primary trigger. A low-concurrency reconciler
repairs missed events and expired leases by querying only non-terminal records whose
`next_reconcile_at` is due. It uses exponential backoff and provider-specific rate
limits.

An event that could cause a terminal or consequential transition is reduced only
after querying current provider state. GitHub gates use REST and bind checks to the
exact PR head SHA; the existing UI cache is not workflow evidence. Gate evaluation
must distinguish required branch-protection contexts from merely successful checks.

Cancellation prevents new dispatches, requests cancellation of active sessions, and
preserves existing branches and pull requests.

### D7 — Consequential authority is re-evaluated at the boundary

Workflow creation, every dispatch, merge, production transition, rollback, and
destructive action require a current policy decision. Previous successful dispatches
do not grant later authority. A handoff result cannot manufacture an approval.

The effective decision is the intersection of authenticated user authority,
control-project policy, target-project inbound policy, registry relationship,
environment policy, and the current approval state. Merge remains separate from
session creation. The initial outcome request does not imply merge or production
deployment authority.

The safest initial decision scope is exactly one consequential transition. Reusable
environment policies are deferred.

All mutating workflow routes fail closed unless the deployment supplies an explicit
`authorizeWorkflowAction` policy. The single-user MVP may set
`VERITY_WORKFLOW_ALLOW_PAIRED_DEVICES=true` to authorize authenticated paired
devices; unauthenticated/headless callers remain denied. This is an explicit,
deployment-wide staging policy, not a reusable cross-project grant. Multi-user
rollout remains blocked until Verity has an authoritative user identity and
membership/role model. Device bearer identity must not be relabelled as
`createdByUserId`, and a project-scoped provider credential is not evidence of the
requesting user's authority.

### D8 — OCI provenance has one configured authority

The image gate never trusts a digest or provenance claim submitted by a session. It
accepts a digest only after a server-side provider adapter verifies that it belongs
to the configured OCI repository and is bound to the expected source commit.

Before the image gate is implemented, Verity must select one authoritative evidence
contract per registry integration: preferably a signed OCI attestation containing
the source repository and commit, verified against configured issuer and subject
policy. GitHub Actions run metadata may be linked as supporting evidence, but two
conflicting providers must not be merged heuristically. Until an attestation format,
trust roots, and conflict rule are selected, image verification remains unavailable
and workflows stop at that gate.

### D9 — Audit is append-only and transactionally coupled

Every workflow transition records actor type and ID, correlation IDs, prior and new
state, policy-decision reference, sanitized inputs, and evidence references. Raw
secrets, provider tokens, arbitrary session files, and unbounded model text are
excluded.

Consequential transitions and their audit/outbox records commit atomically. A
best-effort post-commit audit path is insufficient. Authorization must be explainable
from structured policy and evidence records without replaying model text.

## State model

The workflow uses a small closed state machine:

```text
draft -> awaiting_authorization -> running -> awaiting_decision
                                      |              |
                                      v              v
                                   blocked <------ running
                                      |
                                      v
                    succeeded | failed | cancelled | rolled_back
```

Steps use:

```text
pending -> ready -> dispatching -> running -> result_submitted
                                               |
                                               v
                                        waiting_for_gate
                                          |          |
                                          v          v
                                     completed   retryable_failed
                                                      |
                                                      v
                                          ready | permanently_failed
```

State transitions are implemented as explicit domain commands rather than generic
row updates. Illegal transitions fail closed.

## Delivery sequence

### Phase 1 — Orchestration core in shadow mode

Add the aggregate schema, typed domain commands, transition reducers, event/audit
stream, inbox/outbox primitives, idempotency, leases, cancellation, and the fixed
template. Shadow mode records and evaluates workflows but does not launch sessions,
merge, or deploy.

Tests must demonstrate restart recovery, optimistic-concurrency conflicts,
idempotent command replay, duplicate/out-of-order inbox delivery, outbox recovery,
lease expiry, cancellation, and bounded retry.

### Phase 2 — Structured handoffs and session launcher

Add administrator-owned registry relationships, handoff capability issuance,
Verity-owned session metadata, target-project launch, structured result submission,
and server-side result/reference validation. Dispatch remains limited to the two MVP
handoff kinds.

This phase requires either the explicit single-user staging policy or the
authenticated-user authority prerequisite from D7.

### Phase 3 — GitHub gates

Add authenticated GitHub webhook ingestion plus REST reconciliation. Persist PR and
check evidence bound to exact head SHAs and branch-protection requirements. Existing
short-cache status projections remain UI-only.

### Phase 4 — OCI and Argo CD gates

Implement the provenance contract selected under D8, then the Argo CD event and
reconciliation adapter. Argo evidence records application identity, desired and
observed revision, sync state, health state, and the application-specific health
contract result.

### Phase 5 — Assisted staging pilot

Enable one allowlisted service and staging environment. Source and GitOps sessions
may dispatch automatically when policy allows; merge remains an explicit decision.
Production and automatic rollback remain disabled.

## Consequences

Positive consequences:

- workflows survive server and session restarts without relying on chat memory;
- each repository keeps its own sandbox, instructions, credentials, and review rules;
- provider evidence, session completion, CI, merge, deployment, and health remain
  visibly distinct;
- capabilities are attenuated per attempt instead of transferring credentials;
- fixed templates and administrator-owned relationships constrain the MVP attack
  surface.

Costs and accepted limitations:

- this introduces a new durable domain, migrations, reducers, reconciliation jobs,
  provider adapters, policy records, and a control-plane UI;
- the single-user paired-device policy is deliberately coarse and cannot authorize
  multi-user cross-project dispatch;
- GitHub App webhook subscriptions and permissions require a separate reviewed
  rollout;
- OCI and Argo CD integrations need explicit trust and credential designs;
- the MVP is serial, single-service, and staging-first.

## Rejected alternatives

### One privileged control-plane checkout

Rejected because it combines repositories, credentials, filesystem authority, and
failure domains in one session and bypasses repository-local policy.

### Prompt-only coordination

Rejected because chat history provides neither durable state transitions nor
idempotency, authorization, provider verification, or restart recovery.

### Codex subagents as the workflow engine

Rejected because subagents are session-local implementation workers. They do not
provide cross-project persistence, capability attenuation, provider evidence, or an
audit boundary.

### Session completion as workflow completion

Rejected because an agent can finish after opening a pull request while CI, merge,
publication, reconciliation, or health is still pending or failed.

### General DAGs in the MVP

Rejected because arbitrary graph construction, loops, fan-out, and plugin execution
expand the state, policy, retry, and concurrency surface before the serial delivery
contract has production evidence.

## Unresolved follow-up decisions

These must be resolved by focused ADRs before their dependent phase ships:

1. authenticated workspace user identity, membership, roles, and authority
   delegation;
2. signed OCI provenance format, issuer/subject policy, and conflict handling;
3. Argo CD event transport and its project-scoped read credential;
4. workflow audit retention and visibility when users have different project
   memberships.

They are not blockers for Phase 1 shadow-mode persistence, because that phase performs
no cross-project mutation and grants no provider or deployment authority.

## Acceptance criteria

The architecture is validated when an assisted staging pilot demonstrates that:

1. the control plane creates a durable workflow without receiving a target
   repository filesystem or credentials;
2. every repository mutation occurs in a fresh session of the registered project;
3. a session result alone cannot satisfy CI, image, merge, or deployment gates;
4. a digest advances only after the selected provenance authority binds it to the
   expected source commit;
5. CI evidence is bound to the exact current pull-request head SHA;
6. restart at each wait state causes neither lost progress nor duplicate sessions or
   pull requests;
7. missed and duplicate provider events converge through inbox deduplication and
   reconciliation;
8. cancellation stops new dispatch without deleting branches or pull requests;
9. unauthorized project, environment, merge, or production transitions fail closed
   and produce an auditable policy decision; and
10. final success names the source commit, image digest, GitOps commit, Argo CD
    observed revision, and health evidence.
