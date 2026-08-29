# Session worktree lifecycle and recovery

**Status:** Draft
**Scope:** Verity server, project containers, agent seed, and session recovery

## 1. Problem

Each Verity session executes in a Git worktree, but today part of the association is inferred from
Git metadata and filesystem paths. The same checkout has different absolute paths on the host and
inside a project container. A valid host-side worktree can therefore appear `prunable` from inside
the container. Commands such as `git worktree prune`, `git gc`, or an implicit prune during
`git worktree add` can deregister a live session without deleting its directory.

The failure is hard to diagnose: the conversation still exists, but Git commands, branch lookup,
the PR/issue chip, resume, and later cleanup may fail because the worktree is no longer associated
with the repository.

The desired property is stronger than "cleanup usually works": a live session must never lose its
workspace association, and an interrupted transition must be recoverable without guessing.

## 2. Design goals

- Verity is the sole owner of session-worktree creation, reassignment, and deletion.
- A stable session identity is independent of its current branch, path, container, and process.
- Cleanup never relies on `git worktree prune` as a discovery mechanism.
- Host and container paths are explicit views of one workspace, not competing identities.
- Merge handling and workspace replacement are atomic from the session's perspective.
- Reconciliation is conservative: repair or quarantine ambiguous state; never delete it.
- Existing repositories and sessions can migrate incrementally.

## 3. Source of truth

Postgres is the authoritative registry for session workspace ownership. Git's worktree metadata and
the filesystem are projections that Verity validates and can reconstruct.

Persist workspace-generation records with immutable generation identities separately from the
session's current-generation pointer. At minimum, use:

- `session_workspace`, keyed by `(repository_id, session_id, workspace_generation)`, which stores
  each physical generation and its lifecycle state; and
- `session_workspace_binding`, keyed by `session_id`, which points to exactly one current
  generation and carries the active transition/fencing token.

The generation record contains:

| Field | Meaning |
| --- | --- |
| `session_id` | Stable Verity session ID and part of the generation key |
| `project_id` / `repository_id` | Repository identity, independent of its mount path |
| `workspace_generation` | Monotonic generation incremented on every replacement |
| `state` | Lifecycle state described below |
| `branch_ref` | Expected full branch ref; cached metadata, not session identity |
| `head_oid` | Last verified commit, useful for diagnosis and recovery |
| `host_path` | Canonical host path |
| `container_path` | Canonical path exposed to the agent |
| `git_admin_dir` | Expected host-side Git administration directory |
| `container_id` | Current project container generation, if attached |
| `lease_expires_at` | Liveness lease renewed by the running session |
| `transition_id` | Idempotency key for an in-progress provision or cleanup |
| timestamps/error | Audit and recovery information |

The binding contains `session_id`, `current_workspace_generation`, and a monotonically increasing
`fencing_token`. A uniqueness constraint permits only one current binding per session while old and
new generation records coexist during replacement. Updating the pointer and fencing token is the
atomic cutover operation.

Every destructive operation checks the registry first. A directory name or the output of
`git worktree list` is never sufficient proof that a workspace is orphaned.

## 4. Lifecycle state machine

```text
provisioning -> ready -> attached -> retiring -> retired
      |          |         |           |
      +-------> repair <----+-----------+
                    |
                 quarantined
```

- `provisioning`: paths and Git metadata are being created; the session cannot start yet.
- `ready`: the workspace passed validation and may be attached.
- `attached`: a live session owns the workspace and renews its lease.
- `retiring`: a replacement is already ready or the session has ended; new agent work is blocked.
- `retired`: Git registration and directory are gone and the transition is fully recorded.
- `repair`: expected state and observed state disagree; automated safe repair is in progress.
- `quarantined`: state is ambiguous and requires inspection. Nothing is deleted automatically.

State transitions use a database transaction and an idempotent `transition_id`. Filesystem and Git
operations cannot share that transaction, so each transition is a resumable saga: record intent,
perform one operation, validate it, then record completion. A server restart repeats or completes
the same transition safely.

## 5. Provisioning protocol

1. Acquire a repository-scoped lifecycle lock and create the `provisioning` registry row.
2. Resolve the canonical host path and its deterministic container-path mapping.
3. Create the worktree only from the host/control-plane namespace.
4. Make the worktree-side `.git` pointer mount-portable while retaining a valid host-side reverse
   pointer.
5. Validate from both namespaces:
   - registry paths map to the same workspace generation;
   - the host validates the administration directory, absolute reverse `gitdir` pointer, branch,
     and HEAD;
   - the container validates ordinary worktree-scoped Git operations such as
     `git rev-parse --show-toplevel`, branch, status, and HEAD.
6. Mark the record `ready`; only then start or attach the agent process.

Repository-wide worktree enumeration is a host/control-plane operation. Because the one reverse
`gitdir` pointer contains the canonical host path, it can legitimately look unresolved from the
container namespace. Agent-side enumeration must never drive validation or cleanup, and all
container-side direct or indirect pruning is blocked. A future host-path alias mount could make
both views resolvable, but it is not required for correctness.

Provisioning must not run a Git command that can implicitly prune until all currently registered
live worktrees have passed host-side validation.

## 6. Merge and continuation protocol

A merged PR does not itself determine whether the conversation ends. Verity applies an explicit
session policy:

### End after merge

1. Stop accepting new turns and terminate the agent process cleanly.
2. Mark the workspace `retiring` and revoke its lease.
3. Verify that no live session or transition owns it.
4. Remove its Git registration and directory from the host namespace.
5. Validate absence and mark it `retired`.

### Continue after merge

1. Acquire the session transition lock, stop accepting new turns, and let the active turn finish.
2. Verify the old workspace is clean and its HEAD has the expected merged relationship. If it has
   uncommitted or unpushed follow-up work, abort the transition and keep the old generation
   attached until that work is handled explicitly.
3. Record a separate transition ID while leaving the active fencing token unchanged, so the old
   generation remains valid if provisioning fails.
4. Keep the quiesced old workspace attached while Verity provisions a new workspace generation
   from the current integration branch (or an explicitly selected follow-up branch).
5. Validate the new workspace completely.
6. In one database transaction, make the new generation current, advance the fencing token exactly
   once, and mark the old one `retiring`. Every new turn, process, heartbeat, and lifecycle write
   must present that current token; stale-generation activity is rejected after cutover.
7. Restart or resume the agent in the new path and confirm a heartbeat carrying the new generation
   and fencing token.
8. Resume turns only after that heartbeat. Retire the old workspace only after the new attachment
   is confirmed.

There is never a visible state in which a continuing session has no current workspace. Checking
out `main` in place is not required and should not be used as a substitute for a controlled
replacement.

## 7. Reconciliation and recovery

A server-side reconciler compares four observations:

1. the Postgres ownership record;
2. the host filesystem;
3. the host-side Git worktree administration data;
4. the container mount and agent heartbeat.

It classifies discrepancies rather than immediately pruning them:

| Observation | Action |
| --- | --- |
| Live lease, directory exists, Git registration broken | Rebuild/repair registration, then validate |
| Live lease, host valid, container path invalid | Repair mount/path mapping or recreate container attachment |
| No lease, registry owner exists | Move to `repair`; confirm process and grace period before cleanup |
| Git entry has no registry record | Import as quarantined legacy state; do not delete |
| Registry record has no directory | Mark repair failure and surface a recoverable session error |
| Old transition interrupted | Resume the recorded idempotent transition |
| Heartbeat or write has a stale fencing token | Reject it and retain the current binding |

Automatic repair writes an audit event containing the previous and resulting metadata without
including credentials. Destructive cleanup requires an expired lease, no live process, no current
or pending ownership reference, and a completed grace period.

## 8. Agent-side safety boundary

The agent seed's Git wrapper is defense in depth, not the lifecycle implementation.

- Reject `git worktree prune` in agent sessions.
- Reject `git worktree remove` for every Verity-managed workspace, resolving real paths and both
  host/container aliases before classification.
- Prevent indirect pruning through relevant `git gc` and worktree-add paths, or route those
  operations through the server API.
- Keep the existing protection against direct recursive deletion of `.verity-sessions` paths.
- Return an actionable message stating that Verity owns the lifecycle.

Server-side lifecycle code invokes the real Git binary in the host namespace through a narrowly
scoped internal interface. It does not relax the agent wrapper.

## 9. Path model

Paths are attributes, not identities. A workspace is identified by
`(repository_id, session_id, workspace_generation)`.

The project configuration defines a reversible mapping such as:

```text
host:      /srv/verity/workspaces/<project>/.verity-sessions/agent-<id>
container: /work/.verity-sessions/agent-<id>
```

Code must not persist a container path into a host-side reverse pointer or infer a host path by
string replacement outside this mapping component. Startup validation rejects a mapping that is
not reversible or escapes the configured worktree root.

## 10. Observability

Expose structured lifecycle events and metrics:

- workspace transition started/completed/failed;
- reconciliation mismatch by class;
- repair attempted/succeeded/failed;
- live workspace observed as prunable (critical alert);
- quarantine count and age;
- cleanup prevented because ownership or liveness remained.

The session UI should distinguish "agent process stopped" from "workspace association damaged"
and offer a server-driven repair action when recovery is safe.

## 11. Migration plan

### Phase 0: Immediate guardrails

- Block agent-side prune/remove and indirect prune paths.
- Add a server startup audit that reports, but does not mutate, suspicious registrations.
- Disable any cleanup based solely on `git worktree list --prunable`.

### Phase 1: Registry and validation

- Add the workspace-generation registry and populate it for new sessions.
- Import existing sessions conservatively; ambiguous entries become quarantined.
- Centralize host/container path mapping and dual-namespace validation.

### Phase 2: Idempotent lifecycle

- Move provisioning and retirement behind repository-scoped locks and resumable transitions.
- Implement safe reconciliation and repair of known metadata failures.
- Require lifecycle validation before an agent starts.

### Phase 3: Atomic post-merge continuation

- Implement generation replacement for sessions that continue after merge.
- Add UI state for transition, repair, and quarantine.
- Enable cleanup only after lease, ownership, process, and grace-period checks pass.

## 12. Required tests

- A host-valid worktree whose host path is invisible in the container is never deregistered.
- A container-path reverse pointer is detected and repaired to the canonical host path.
- Agent commands cannot invoke direct or indirect pruning.
- Server restart at every lifecycle step resumes the same transition without duplicate worktrees.
- A turn racing with replacement is drained before provisioning or rejected by generation fencing.
- Failed replacement leaves the old generation attached and usable.
- Successful replacement never exposes a session without a current workspace.
- Cleanup refuses a live lease, live process, current generation, or pending transition.
- Legacy and unknown Git entries are quarantined, not deleted.
- Two concurrent transitions for one repository/session serialize correctly.
- Branch changes inside a valid workspace update metadata without changing session identity.

## 13. Acceptance criteria

The design is complete when:

- no agent-executable Git command can deregister a Verity-managed live worktree;
- every live session resolves to exactly one validated current workspace generation;
- a lost Git association can be reconstructed from the registry without reconstructing intent from
  directory names;
- merge continuation either completes atomically or leaves the previous workspace usable;
- automated cleanup can demonstrate absence of ownership and liveness before deleting anything;
- all lifecycle actions are auditable and safe to retry after a crash.
