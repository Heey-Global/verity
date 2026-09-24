# Moving a session between local projects

**Status:** Implemented — targeted integration and regression tests
**Scope:** Verity server, store, session conductor, and mobile client

## 1. Outcome

Move an idle session from local project A to local project B while keeping its session id,
name, and durable conversation history. Continue in B using the existing database-backed
context handoff used for backend changes. Transfer uncommitted work into a fresh worktree
based on B's configured default branch.

This is a context handoff, not migration of a backend's native runtime. The accepted fidelity
is the same as the existing agent-switch handoff: the durable history remains in the database,
but the prompt is bounded and tool output can be truncated. Do not describe it as lossless
native resume or promise that the entire history fits into the next model prompt.

## 2. Scope and boundaries

- Both projects must be local, visible, and outside the control plane.
- The session must be idle, with no meeting job or queued work admitted during the move.
- Agent Loop sessions are excluded because their automation belongs to a project.
- Session identity, name, events, and durable transcripts remain intact.
- Native backend bindings are reset and a durable move marker forces the next turn through the
  existing cold-start handoff, including sessions originally created with Claude.
- Native subagent/runtime files are not migrated. Keep source artifacts until ordinary retention
  rules can safely collect them; do not invoke session-deletion cleanup for this operation.
- Commit history is not transferred. If session commits would remain behind, require explicit
  acknowledgement and retain their source branch.
- GitHub project moves and live process migration are outside this version.

## 3. Context continuation

Reuse the existing handoff path in `packages/session/src/handoff.ts` and the conductor rather
than implementing separate Claude, Codex, and OpenCode transcript migration.

Before committing the move, close any cached backend session using the existing backend-reset
mechanism. Preserve all durable conversation data. Reset every backend binding associated with
the Verity session, so switching back to a previously used backend cannot resume the old workspace.

The next turn must load history from the database and run against the target project and worktree.
Include a server-authored move notice naming the target project, branch, and workspace, and any
source branch or files left behind. The notice must distinguish historical source paths from
paths valid in the new workspace. Target project instructions, knowledge, and permissions apply
from this turn onward; source-project permissions must not follow the session.

Persist the move notice atomically with the project/worktree update and backend-binding reset.
Read this notice from durable move metadata on subsequent turns; do not rely solely on
`session_pending_note`, which is consumed before backend launch. A failed launch must not lose
the notice. Suppress the canonical Claude-session-id resume fallback after a move; deleting
backend bindings alone does not force a cold start. Once a new binding exists, normal resume
uses that binding. The handoff header must describe earlier workspace paths as historical,
without claiming that prior branches and files necessarily exist in the target workspace.

## 4. Workspace transfer

Create a fresh branch/worktree from the target project's configured default branch. Do not copy
the source `.git` metadata, transplant its index wholesale, or import its commit history.

Capture the source's index and working-tree states separately. A status path list followed by
`git add` is insufficient: it destroys partial staging. Parse NUL-delimited Git output and
handle filenames without shell interpolation.

| Source state | Target treatment |
| --- | --- |
| Modified or new tracked file | Transfer working content and the independent staged content, when present |
| Untracked, non-ignored file | Copy as untracked unless explicitly staged in the captured index |
| Tracked deletion | Apply absence to the corresponding working-tree/index state |
| Rename | Treat as source-path deletion plus destination-path creation, preserving both states |
| Ignored file | Leave in the retained source workspace and list it as not transferred |
| `.git` or dependency/build artifacts excluded from transfer | Never copy Git metadata; report exclusions and retain their source copies |
| Unmerged index, unsupported submodule or file type | Refuse before committing the move with an actionable explanation |

Reconstruct only affected index entries against the target base using captured blob contents and
file modes. Keep unaffected target entries intact. Preserve executable bits and symlinks as links;
never follow source or destination symlinks outside the workspace. Reject path/type conflicts and
unsafe ancestor paths. Untracked directories must be enumerated down to files, including an
explicit accounting of ignored descendants.

For an affected path, allow applying the change when the target base matches the source's
pre-change content or the desired result already exists. A transferred file may be created when absent in the target, including a modified tracked
source file and its independently captured index content. Otherwise refuse with a conflict list: do not silently replace
a different target file or delete target-only content. Resolving conflicts manually and retrying
is sufficient for this version; an interactive merge editor is out of scope.

The staged/unstaged distinction is preserved wherever it is representable against the target base.
If a source delta is already part of that base, report it as already present rather than manufacturing
a redundant staged change.

## 5. Source retention

A successful move does not force-remove the source worktree. It can contain ignored files,
committed work, or other assets that were deliberately not transferred. Retain it as a recovery
workspace and show its location in the result. The move itself grants no authority to discard it.

Register this retained workspace durably so ordinary orphan cleanup cannot mistake it for garbage.
A later explicit cleanup may remove it after remaining assets have been handled. Project deletion
must account for retained workspaces in its existing destructive-deletion flow.

The implementation must establish whether existing lifecycle storage can represent this retention.
Do not assert that no schema change is needed before that is verified.

## 6. Admission and lifecycle coordination

Take the session's exclusive claim and coordinate with both projects' lifecycle admission in a
stable ordering. Integrate with the existing project deletion/spawn barriers: a final database
lock alone cannot protect a target worktree from concurrent deprovisioning.

Keep the fences through preparation and commit. Block conflicting session starts, deletion,
project deprovisioning, and other workspace mutations. A session claim alone does not freeze
external file writers; detect changes to the captured source snapshot before committing, abort on
mismatch, and retain the original workspace regardless.

Validate source/target identity, visibility, supported session kind, target readiness and base,
source index support, path conflicts, and any explicit acknowledgement of commits left behind.
Fail before changing the session's durable association whenever preparation cannot complete.

## 7. Procedure and recovery

1. Acquire session and project admission; validate the move.
2. Capture the source file/index manifest and inventory excluded assets and source-only commits.
3. Create the target worktree and transfer the captured states. Verify destination contents,
   modes, index entries, and source snapshot stability.
4. Prepare the existing backend-reset and source-preview shutdown steps. A failure here leaves
   the session assigned to A; preserve data and provide retryable diagnostics.
5. In one database transaction, revalidate the expected source association and target visibility;
   update project/worktree, reset backend bindings, append the move notice, register the retained
   source workspace, detach source preview references, and revoke applicable session-scoped
   source permissions. Identify all affected permission/grant stores during implementation.
6. Invalidate affected caches and reload client session/list state. Any external preview restart
   or cleanup is idempotent and recoverable; it cannot reverse a committed move.
7. Release admission. The next user turn starts in B with the existing history handoff.

Before the transaction commits, A remains authoritative and no move notice is published. Remove
only preparation artifacts whose ownership is proven. A backend closed during preparation can
restart in A; preview processes stopped during preparation must be recoverable there.

After commit, B is authoritative and A is retained for recovery. Persist enough operation state to
reconcile interrupted preparation and post-commit work after restart. An API retry after a lost
response must return the committed result rather than create another worktree. Use an operation
id scoped to the session; reusing it with different input is a conflict.

Do not claim crash safety from operation ordering alone. Durable operation/retention bookkeeping
and restart reconciliation are part of the implementation, using existing storage where suitable.

## 8. API and client

Proposed endpoint:

```text
POST /sessions/:id/project
{ "project": "<targetProjectId>",
  "operationId": "<unique retry key>",
  "onCommits": "block" | "leave" }
```

Uncommitted changes are transferred as the normal behavior; a separate dirty-worktree opt-in is
unnecessary. `onCommits` defaults to `block`. This version has no bulk `includeIgnored` switch:
ignored assets remain accessible in the retained source workspace.

The success response includes the new project/branch, `contextMode: "history-handoff"`, transferred
and already-present paths, skipped paths, and the retained source workspace/branch. Return stable
error codes for busy state, unsupported sessions, file conflicts, and unacknowledged source commits.

Add “Move to project…” to the existing long-press session menu alongside Rename and Delete.
Open a picker listing other visible local projects, then show a confirmation naming the target
with a “Move” button. Keep the action unavailable while the session is running, with an
explanation that the current turn must finish or be stopped; the session itself is not ended. Explain that the chat
remains, context continues through the normal agent-switch handoff, and uncommitted work is copied.
Show source commits that require acknowledgement and actionable conflict details. On success keep the same chat identity, regroup the session under the target project, and show
any files left behind and where to find them. If no eligible target exists, explain that another
local project is needed. Keep the picker open on a conflict and show the affected paths.

Reload the authoritative session and list after success. On a timeout, reconcile using the same
operation id before claiming failure or reverting the displayed project. Keep the route under
normal user authentication; it is not an agent tool permission.

## 9. Verification

- Store transaction: association, backend reset, notice, retention, and permission changes commit
  together; failure leaves all durable source state unchanged.
- Backend continuation: with a previously used backend, the next turn takes the cold-start handoff,
  receives prior conversation content and the move notice, and executes in B with B's project context.
- Transfer: partial staging, new/untracked files, deletions, renames, binary files, executable bits,
  symlinks, ignored descendants, unusual filenames, and target-path collisions.
- Retention: excluded assets survive success and restart; normal orphan cleanup preserves them.
- Lifecycle: race moves with project deletion, queued turns, and source modifications.
- Recovery: inject failures before/after the transaction and during external side effects; retry a
  committed operation after dropping its response and verify that no second move occurs.
- Permissions and previews: source access does not carry into B; preview references and runtime
  state reconcile after both successful moves and failed preparation.
- Client: list/detail refresh, conflict presentation, retained-file notice, and timeout reconciliation.

For each new guard, deliberately break the behavior it protects and observe the failure, following
repository contributor instructions. Mocked wiring tests must not be presented as proof that a real
backend consumed the handoff; include a backend integration check for the continuation contract.

## 10. Implementation sequence and estimate

1. Confirm reusable backend-reset/handoff, lifecycle admission, and retention/operation storage.
2. Implement and test file/index capture, conflict detection, and transfer in isolation.
3. Implement the transactional move and restart reconciliation.
4. Add the route and mobile interaction.
5. Exercise failure paths and backend continuation; run proportionate repository verification.

This removes native transcript and subagent migration from the earlier design. File/index transfer
and lifecycle recovery remain the main uncertainties. Replace the earlier six-day estimate with a
revised estimate after steps 1 and 2 establish the required storage and transfer work.

## 11. Implementation notes

The first implementation adds `session_moves` for retry results, retained workspace/backend
identities, durable context notices, and pending preview restarts. Startup removes uncommitted
preparation workspaces only when the recorded destination is still unassigned; it never removes
a retained source workspace. Public previews for the moving session are revoked while preview
retargeting is fenced. Running source previews return to the source project's default checkout.

Transfers have a conservative 64 MiB aggregate snapshot budget. Intent-to-add, unmerged indexes,
submodules, skip-worktree and assume-unchanged entries are refused with actionable errors.
Ignored files and dependency artifacts stay in the retained source workspace. Context tests use
real Git and database state and inspect the backend invocation; they do not claim that a live
external model has recalled every item in the bounded history handoff.
