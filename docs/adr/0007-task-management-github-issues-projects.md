# ADR 0007 — Task Management on GitHub Issues + Projects v2

**Status:** Proposed · **Date:** 2026-07-04

## Context

Verity manages **projects** (repos) and **sessions** (agent runs in worktrees), but has
no first-class **task management**. The only work-item surface today is read-only: the
server lists open GitHub issues per repo (`packages/server/src/github.ts:522`,
`GitHubIssueService`, `GET .../issues?state=open`, 60s cache) and the mobile app renders
them as a footer section under the session overview (`apps/mobile/app/index.tsx:549`,
`IssuesSection`) with a detail screen that can seed a session from an issue
(`apps/mobile/app/issue/[number].tsx`). No create, no update, no ordering, no planning.

The operator wants a real planning layer:

1. **Tasks = GitHub issues.** Each task lives in the repository it belongs to.
2. **An inbox** for not-yet-assigned / not-yet-triaged tasks (no repo chosen yet).
3. **Planning:** prioritize and manually reorder the backlog.
4. **"Umsetzen" button:** hand a task to an agent session for implementation.
5. **Voice-first capture:** speak an idea → an agent drafts a well-structured issue,
   asks the operator clarifying questions until the blueprint is good enough that an
   agent can actually implement it, then files it.
6. **Navigation:** a clear top-level split between planning and the live session view.

Operator constraint clarified during design (2026-07-04): **task management may depend on
GitHub being reachable.** The whole feature is intrinsically GitHub-woven, so a
GitHub-independent / offline planning mode is explicitly **out of scope**. This removes
the resilience argument for keeping ranking/drafts in a Verity-local store.

## Decision

**Tasks are GitHub issues; the planning layer is a GitHub Projects v2 board. GitHub is
the source of truth for tasks, their draft state, their manual order, and their custom
fields — no parallel Verity-local task store.**

### Why Projects v2 (and thus GraphQL)

Projects v2 natively provides the three things the operator asked for, which we would
otherwise reimplement in Verity:

- **Draft issues** — repo-less items that are not real issues yet. This *is* the inbox:
  capture lands as a draft, gets refined, then "convert to issue" into a chosen repo.
- **Manual ordering** — board position = backlog rank. Stable, drag-reorderable.
- **Custom fields** — Priority / Status / Estimate / Iteration stored on GitHub, editable
  from both Verity and the GitHub web UI (bidirectional).

Projects v2 is **GraphQL-only**. This is a deliberate, scoped exception to Verity's
REST-first posture — see "GraphQL budget" below and the `AGENTS.md` precision this ADR
introduces.

### Access-pattern split (the core of the exception)

The existing "no GraphQL" rule in `AGENTS.md` exists to protect **high-frequency status
polling**: the server polls PR/CI status per branch on a short cache across many
concurrent sessions. GraphQL's rate limit (5000 points/hour, **per token, shared globally**
across all sessions and repos) would be exhausted by that pattern and break status for
*everyone*. That rationale is specific to polling and does **not** transfer to task
management, which is user-initiated and low-frequency.

| Access pattern | Frequency | API |
|---|---|---|
| PR / CI status | per-branch poll, seconds, all sessions | **REST** (unchanged) |
| Task read (backlog, board) | user-initiated, on-demand | **GraphQL**, cached |
| Task write (create/reorder/field/promote) | user-initiated, occasional | **GraphQL** |

**Hard rule:** GraphQL/Projects v2 is called **on-demand + cached, never in a poll loop.**
A backlog fetch costs ~1 point; interactive use stays far inside the 5000/h budget. The
danger is only reintroduced if task data is polled like status — so it must not be.

### Task lifecycle

```
Draft (Projects v2 draft, inbox)
   → Refined issue (converted into target repo, on the board, ranked + prioritized)
   → In session (agent implementing; "Umsetzen")
   → PR (linked, "Closes #N")
   → Done (issue closed)
```

This lifecycle doubles as the navigation model: **decide → do → land.**

### Voice → blueprint refinement

Reuses the existing session/chat infrastructure rather than a new subsystem:

1. Operator taps "+ New Task" in the Plan tab and speaks. Transcript lands as a **draft
   item** on the board (inbox).
2. A **refiner agent** (a session in a drafting mode, with repo context) turns the
   transcript into a structured blueprint: *title, problem statement, acceptance criteria,
   affected files/areas, open questions.*
3. If open questions remain → it **asks the operator** (chat back-and-forth) until it is
   confident the blueprint is implementable.
4. The agent **proposes a target repo** from the content; the operator confirms →
   **convert draft to issue** in that repo, on the board.
5. The issue is now **"Umsetzen"-ready**: `POST /sessions { issue, project }` seeds the
   session with the full blueprint; the resulting PR links back (`Closes #N`).

### Navigation

Migrate the mobile app from its current single **Stack** (`apps/mobile/app/_layout.tsx:66`,
no tabs) to a **3-tab bottom bar**:

1. **Sessions** ("Now") — the live pulse of running agents, PRs, unread. Today's home
   minus the issues footer.
2. **Plan** — the prioritized backlog across projects, the inbox/draft section, and the
   voice "+ New Task" entry. The new center of gravity.
3. **Projects** — the repo fleet, provisioning, settings.

Settings / Concierge stay as header-pushed screens (low-frequency, admin) — no tab.

**Naming guardrail:** the Plan tab must **not** be called "Todos". Verity already uses
"Todos" for the *in-session execution checklist* (`todo-group` widget in
`apps/mobile/app/session/[id].tsx`) — ephemeral agent state, distinct from durable
backlog tasks. Reusing the word guarantees confusion. Use **"Plan"** / **"Tasks"**.

## Consequences

**Positive:** native inbox (draft issues), native manual ordering, native custom fields —
far less to build and maintain than a Verity-local task store; tasks are bidirectionally
visible/editable in the GitHub web UI; the voice→blueprint loop reuses existing session
infra; a clean 3-tab mental model (decide → do → land).

**Negative / accepted:** task management is unavailable when GitHub/GraphQL is unreachable
(explicitly accepted — the feature is GitHub-woven by nature). A new GraphQL client
surface must be added alongside the REST client, with different auth/error handling. The
Projects v2 API is node-ID based and more verbose than REST issues (polymorphic field
value unions, `updateProjectV2ItemPosition` with `afterId` for ordering) — real
implementation cost.

**Guardrail that must hold:** GraphQL is on-demand + cached only. If a future change ever
needs task data live-refreshed, it must still not poll GraphQL on a status-like cadence;
revisit this ADR rather than quietly adding a loop.

## Configuration

The board is selected per deployment by **`VERITY_TASKS_PROJECT_NUMBER`** — the
Projects v2 board number under the `repoDir` origin's owner
(`github.com/orgs/<owner>/projects/<number>`). It is wired at the entrypoint
(`main.ts` → `parseTasksProjectNumber`) into `EmbeddedServerConfig.tasksProjectNumber`.
Unset/empty → task management is off (the `/tasks` routes 503, the Plan tab hides);
set-but-invalid throws at startup (fail loud). The service is built only when
`repoDir` + a GitHub token + the board number are all present.

## Suggested build order

1. **Backend foundation** — a GraphQL client; `GitHubTaskService` for board read
   (items + fields + order), issue create/update, draft create + convert-to-issue,
   reorder. Keep REST `GitHubPrService` status polling untouched.
2. **Plan tab + bottom tabs** — Stack → `(tabs)` migration; backlog list with
   priority + drag-reorder; inbox/draft section.
3. **"Umsetzen" end-to-end** — blueprint as session seed; PR ↔ issue linkage.
4. **Voice → refiner loop** — draft capture; clarifying-question agent; convert-to-issue.

## Related

- `AGENTS.md` — "GitHub API And Status Polling": this ADR narrows that rule from a blanket
  "Verity uses no GraphQL" to "**status polling** is REST; GraphQL is permitted for
  user-initiated, on-demand task operations, never in a poll loop." The `AGENTS.md` edit
  accompanies this ADR.
- `packages/server/src/github.ts` — existing REST `GitHubPrService` / `GitHubIssueService`.
- `apps/mobile/app/_layout.tsx`, `apps/mobile/app/index.tsx`, `apps/mobile/app/issue/[number].tsx`
  — current navigation and issue surfaces.
