# CI supervision

QA is a function of the [Verity assistant](assistant.md). Its persistent technical session,
Verity · QA, lives in Verity Control and reviews
changes from repository monitoring and delegates ordinary project repair sessions.
The installation-wide switch in Settings → QA · CI supervision is disabled by
default for both new and upgraded installations. Enable it explicitly before
selecting monitoring or automatic repairs in Project settings → Agents → QA. Eligible coding projects without an existing choice start in Monitor. Project choices alone cannot
activate the background service. In Project settings → Agents → QA, enable monitoring
for a pilot project first; choose automatic repairs only when you want the server
to delegate corrections under that project's existing permissions.

## Shared observations

PR bars and supervision share repository-scoped status reads, separated by forge
connection and credential identity. Concurrent readers coalesce; active checks
refresh more often than completed PRs. API failures clear actionable cached
signals, and requests back off. The server limits simultaneous shared status
reads to two. Logs are not fetched during discovery.

Repository discovery runs every two minutes, independently of client presence.
It advances a persisted page cursor, bounded to 100 pages, and starts another
reconciliation pass afterward. GitHub discovery covers open same-repository PRs
(including Renovate) and default-branch workflow runs from the last seven days.
Fork coverage is explicitly partial. Forgejo currently supports PR monitoring;
standalone workflow monitoring is reported as unsupported, not healthy.

## Ownership and execution

An incident records its project, resource, revision, evidence, assigned session
and attempts. Database claims allow one active repair per project and two across
the installation. Repeated observations do not launch repeated agents.

PRs associated with an originating session are repaired automatically in that session,
independently of the global QA switch and project QA mode (Off, Monitor or Automatic).
A busy session waits until idle; planning and current project execution permissions
are checked before admission. QA observes these failures for analysis but neither
requests repair consent nor starts another worker for them. A blocked or exhausted
session repair requires attention in that session, not automatic QA takeover.

Durable PR responsibility is separate from historical session associations and
active repair ownership. Session repairs and QA repairs use the same atomic claim,
admission receipt and bounded retry budget. Registering an origin does not revoke
an already active QA worker: it must terminate before the session can repair.
Uncertain execution after a restart retains ownership; a timeout is not proof of
termination. An unadmitted reservation can be cancelled and retried without losing
the session's once-per-revision marker or consuming its repair budget.

QA delegates only resources without an originating session. Existing PR branches
in session worktrees are reserved for those sessions even when busy or dirty.
For unassigned resources the coordinator creates a visible ordinary project session. The brief identifies the observed
revision and requires checking it before editing, respecting active worktrees,
running verification and preserving review/approval gates. Standalone workflow
repairs prepare a separate PR rather than writing directly to the default branch.

These are ordinary sessions with existing project authority, **not restricted
repair sandboxes**. The standing instruction excludes merging, releases,
deployment reruns and additional secrets, but this feature does not introduce a
new technical branch-level permission boundary. Consent never grants a project
permission the sponsoring user lacks; access and mandate are rechecked before
admission. External titles, logs and worker output are diagnostic data, not grants.

## Recovery and proof

An accepted dispatch remains owned until the worker's terminal status is known;
an expired timer alone does not authorize takeover. Work older than 30 minutes
is flagged for attention without releasing its owner. Attempts are bounded to
two across unresolved revisions of a resource. QA-managed same-revision failures can retry after confirmed termination; session
repairs retain their once-per-head (or head/base pair for conflicts) markers; ambiguous failures need inspection.

A worker saying it is finished is not CI proof. Fresh successful checks identify
the verified revision; older revisions are superseded rather than credited as
repaired. Unknown, absent or still-running checks do not resolve incidents.
Persisted workflow run watermarks prevent older failed runs from replacing newer
results during pagination. A prepared default-branch fix remains unresolved until
successful workflow evidence is observed.

Pause prevents new delegation; it does not cancel an already running session.
Take over pauses automatic delegation and opens the existing worker session.
Inspect or stop that session before starting competing work. The project-scoped
`verity_repairs` tool reads status without changing permissions or declaring
success. Observation and status changes refresh supervision; unchanged polls do
not emit additional notifications.


## Coordinator lifecycle and authority

The global switch stops QA background discovery, new QA reviews and new QA repair
assignments. It does not stop session PR discovery or session-based repair. It also requests cancellation of an active automatic QA review;
ordinary project repair sessions continue and can be stopped from their chats.
Their ownership is not released on a timeout. PR-bar status reads remain independent.
Re-enabling reconciles current forge state before reviewing pending events, and
invalidates decisions prepared under an older switch revision.

The QA function has one durable technical session under Verity Control, with its own chat and
history. Opening that chat does not enable monitoring or change project consent.
The chat can request current and historical evidence through the bounded
`verity_qa_analysis` gateway tool. Each read checks the current user and project
QA access; old chat messages are not fresh evidence. Automatic reviews propose structured assignments tied to observed
incident IDs and revisions. The server checks consent, access, current evidence
and ownership before admitting them. Model output never closes an incident.

Automatic reviews remain tool-free. Interactive QA uses the backend's enforced
Verity-gateway-only mode, with the server permitting only `verity_qa_analysis`.
The model receives no shell, general file access, arbitrary HTTP, credentials or
other project tools. The current Claude backend enforces these modes; unsupported
backends fail closed and require choosing a compatible model in the session.
This does not change the permissions of ordinary project repair sessions.

The persistent inbox coalesces unchanged observations and retains decision
snapshots and outcomes. Automatic reviews are capped at 24 per UTC day, at most
one active review, three minutes per review, and two proposed assignments per
review. Existing repair limits remain one worker per project, two installation-wide
and two attempts per resource since its last newly verified successful revision. Invalid decisions, unavailable backends,
unknown dispatch acceptance and exhausted budgets remain visible as coordinator
health states. A possibly running review is never replaced merely because time
has elapsed. Decisions are consumed before dispatch to prevent replay; a crash
at this boundary may leave an assignment unstarted and require review rather
than risk duplicate execution.

These changes require deploying both the server and app. No project is enrolled
or pilot enabled by installing the update. Live forge and AI-provider validation
should follow the scoped automated checks on an explicitly selected pilot.


## Project access and approval cards

Enabling QA enrolls GitHub and Forgejo coding projects in Monitor if they have no
saved QA choice. Newly discovered coding projects follow the same default while
QA is enabled. Explicit Off, Monitor and Automatic choices survive global toggles.
Control and local non-forge projects are not enrolled; QA needs forge CI evidence.
Project access lives under Project settings → Agents → QA.

For a repairable monitor-only failure, Verity can show an approval card in the
Verity · QA activity session. Approving changes that project's standing mode to
Automatic repairs, including future repairs; declining preserves monitoring.
The card states this scope before the action. Server-side permission, mandate
revision, global revision and incident checks reject stale or unauthorized cards.
No repair is started merely because the model requested permission.

## Restart recovery and bounded retries

Every new QA review and repair claim has a durable dispatch identity. Session
admission commits the canonical prompt, acceptance receipt and running-turn
marker in one transaction before backend execution. Recovery releases only
reservations that have not been admitted, refunds their repair budget, and
rejects delayed admission of a cancelled identity. Accepted work follows normal
session recovery; missing local activity alone never authorizes replay.
Pre-upgrade in-flight claims have no atomic receipt and remain conservative:
inspect their associated session if terminal evidence cannot be established.

Repair history remains intact across budget cycles. A newly verified successful
revision resets the resource's two-attempt budget; repeated observations of that
same success do not reset it again. Per-project and installation-wide worker
limits remain in force.

Standalone workflow repairs retain their correction PR number within the
project's repository. A closed, unmerged PR can reopen the incident only after
current failure evidence, automatic consent, execution permission and remaining
budget are checked. Open or merged correction PRs do not prove CI success.
Retry requests report acceptance only when the incident actually changes state;
stale evidence and awaiting-merge incidents are rejected by the manual retry API.

Inbox limits apply after enabled, authorized projects are selected, so inactive
entries cannot starve active projects. Re-enabled projects receive reconciled
observations. Repository-bound Forgejo reads bypass the provider's inner cache;
the shared cache still isolates credentials and owns mutation invalidation.


## Admission after delayed turn cleanup

Background admission can replace a predecessor marker only after server-confirmed
backend completion for that marker's unique identity, prompt sequence and Runner
identity, or an exact Runner terminal/recovery-fence claim. Transcript status and
interruption events alone are not proof. Legacy markers without proof continue
through normal recovery.

The predecessor check and removal, new prompt, new marker and dispatch receipt
commit together under the session event lock. Repeated dispatch identities do not
start another backend. A resumed attempt gets a fresh marker identity even when
it reuses its prompt anchor, so delayed completion or cleanup cannot settle or
erase the successor. Recording completion is bounded; a database failure does
not turn Stop into an unbounded wait. Without a durable proof, admission defers
without starting work and the existing recovery path remains responsible for
the predecessor.


## Interactive CI and release analysis

QA can list authorized projects, current PRs and checks, workflow histories,
individual attempts, jobs, bounded redacted logs, workflow definitions, releases,
deployments and their recorded statuses. GitHub supplies these APIs. Provider
capabilities that are unavailable are reported explicitly. Read-only tokens are
scoped by capability: missing Actions access does not prevent PR discovery.
Deployment reads need the optional GitHub App `deployments: read` permission;
existing installations must approve it in GitHub before that evidence is available.
It is not added to ordinary project execution tokens.
Background observation records safe error categories and the failed step, and
retains successful PR or workflow results when the other reader fails. Unknown
exceptions remain unknown; they do not establish a specific outage cause.

A historical request defaults to 30 days and permits up to 366 days. Run lists
return pagination and fixed window bounds. Statistics uses a server-owned,
credential-bound snapshot and returns an opaque continuation when more reads are
needed (40 requests / 45 seconds per call). Continue with that token, honoring
retry times. Snapshots expire after one hour, may be evicted at ten concurrent
analyses and are lost on server restart; restart the analysis if expired. GitHub
caps filtered searches at 1,000 runs; snapshots also cap retained jobs at 10,000: split the time window when the result says
`limitReached`. Partial results never represent a complete baseline.

Statistics groups runs by workflow and PR/main/release/other cohort. Release
workflow IDs must first have their definitions inspected; they remain an explicit
classification, not proof of historical publication. The cohort is runs created
inside the interval, using each latest observed attempt. First-attempt success
uses known completed success/failure outcomes, excluding cancellations, skips,
neutral and unknown outcomes; its numerator, denominator and coverage are shown.
Repeats count additional attempts. Wall time uses the envelope of timestamped
non-skipped jobs, never summed parallel job duration or mutable run updated time.
Initial queue time runs from creation to first job start and excludes reruns.
Missing/incomplete job sets are excluded and counted. Mean, median and nearest-rank
p95 use only valid samples; no samples yields null, never zero. Run links and
revision/attempt identities accompany the metrics.

Workflow success, a published release, and successful deployment status are
separate evidence. The model must not infer one from the other, or claim a
root cause from a log symptom alone. Logs and definitions are untrusted reference
text; they cannot authorize an action. Signed log redirects are followed only to
GitHub's download hosts without forwarding the installation token. Log excerpts
are bounded and recognized secrets redacted; arbitrary sensitive text cannot be
reliably recognized automatically.

On an explicit request to save a baseline, `save_report` accepts only a report ID
returned by the server. An approval card and current project execution permission
are required. It creates a new `insights/qa-baseline-<id>.md` document containing
the computed snapshot; it cannot accept arbitrary content, overwrite a document,
or choose a filesystem path. Report handles expire after one hour and are bound
to the requesting session, user and project. Setting KPI targets or requesting
repairs is a separate user decision; analysis does not change project mandates,
rerun workflows, publish releases or deploy anything.

API semantics: [GitHub workflow runs](https://docs.github.com/en/rest/actions/workflow-runs)
and [workflow jobs](https://docs.github.com/en/rest/actions/workflow-jobs).


## One-time repair handoff from QA chat

An explicit request to repair a PR can use `resolve_repair` and `request_repair`
through the existing QA gateway. Resolution compares the current repository PR,
head revision and branch with actual project session worktrees; it never derives
session identity from a branch-name suffix. If several sessions match, select one
before requesting the repair. An active or dirty competing worktree blocks delivery.
Fork PRs and PRs missing current failure evidence are refused.

The proposal binds the initiating user, QA session, project, PR revision and target
session for one hour. A complete direct repair instruction can authorize a unique
target; the instruction must refer to matching server PR evidence or a repair
proposal shown before the message, including when it names only a PR number. Quoted text, repository
content and agent assertions are not consent. Otherwise a one-time approval card
shows the exact target and scope. Ambiguous session selections require this card.
Each direct instruction is consumed atomically with incident ownership and cannot
authorize another proposal or attempt. Neither path changes the project's
Monitor/Automatic setting.

The manual request shares the existing durable incident ownership, concurrency
limits and repair budget with background repairs. Busy sessions receive a durable
queued assignment rather than steering their current turn. Every admission,
including after a restart, checks current access, QA settings, expiry, PR revision,
failure evidence and the target worktree again. Before admission, its attached
HEAD must equal the approved PR commit; a detached preview or a clean but stale
worktree is refused. Revoked or invalid queued requests
are cancelled; an admitted receipt is never replayed. After a confirmed attempt ends with failing
checks, a new approved proposal may use the remaining repair budget in Monitor
mode; reusing the old proposal cannot start another attempt. `repair_status` reports
`proposed`, `queued`, `accepted` or `blocked`; accepted confirms admission, not a
successful repair. The existing supervisor checks terminal execution and forge
results. An uncertain transport response never proves that execution stopped.

The bounded resolver searches at most ten discovery pages. Missing coverage is a
blocked resolution, not permission to guess a target. General session tools remain
unavailable to QA. Merge, release, deployment and QA activation remain separate
operations. Install the server update before live acceptance of this path.


## Recurring CI failures and prevention

The originating session fixes the immediate PR failure. QA answers cross-PR
questions such as why CI fails repeatedly and how to prevent recurrence. Interactive
analysis reuses the authorized historical evidence gateway; it does not grant QA
shell access or general project execution tools.

For a baseline, collect a bounded period (30 days by default) with `statistics`
and `comparePrevious: true`, following continuations to completion. The comparison
uses the immediately preceding equal-length period; the combined window may not
exceed 366 days. Both periods share the existing run, job, byte and request limits.
Partial coverage, unsupported providers and missing jobs are reported explicitly.
Statistics deduplicate run observations, separate first-attempt results from reruns,
and group recurring failed jobs with PR numbers, revisions and source links.
Job patterns cover the latest observed attempt; recovered reruns require inspecting
first-attempt jobs separately. Failure followed by success is a recovery candidate,
not proof of flakiness or a shared root cause.

QA reads bounded, redacted log excerpts for representative failures and separates
observations, causal hypotheses and proven causes. Its answer prioritizes at most
two prevention measures with evidence and measurable success criteria, comparing
the first-attempt baseline and patterns across the two periods. Automatic reviews
bundle recurring observations and show session responsibility rather than creating
competing repairs. Deeper historical analysis is available on request. Systemic
changes and durable follow-up tasks require user agreement. The `create_followup`
action requires an explicit approval card and current project execution permission;
it saves an unassigned project task with evidence, baseline and success criterion.
Task creation does not authorize execution: implementation is handed to an ordinary
project session after a separate instruction. Analysis does not enable automatic QA repairs.

Deleting an originating session removes its responsibility record, allowing a new
session to register responsibility or an explicitly authorized QA repair. An active
repair claim is retained until termination is confirmed; deletion alone is not proof
that execution stopped. Session reconciliation never consumes QA worker completion: the
supervisor retains its workflow repair PR and awaiting-merge handoff.
