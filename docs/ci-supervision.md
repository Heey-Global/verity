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
the installation. Repeated observations do not launch repeated agents. Existing
session-based automatic repair defers to this coordinator for enrolled projects,
including paused projects, rather than starting a competing repair.

Compatible, clean and idle PR sessions can be reused. Otherwise the coordinator
creates a visible ordinary project session. The brief identifies the observed
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
two across unresolved revisions of a resource. Same-revision failures can retry
after confirmed termination; ambiguous failures need inspection.

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

The global switch stops background discovery, new AI reviews and new repair
assignments. It also requests cancellation of an active automatic QA review;
ordinary project repair sessions continue and can be stopped from their chats.
Their ownership is not released on a timeout. PR-bar status reads remain independent.
Re-enabling reconciles current forge state before reviewing pending events, and
invalidates decisions prepared under an older switch revision.

The QA function has one durable technical session under Verity Control, with its own chat and
history. Opening that chat does not enable monitoring or change project consent.
The chat receives cached observations with freshness information; it does not
poll the forge. Automatic reviews propose structured assignments tied to observed
incident IDs and revisions. The server checks consent, access, current evidence
and ownership before admitting them. Model output never closes an incident.

QA runs in the backend's enforced tool-free mode: no shell, repository tools,
MCP connections or project tool credentials are made available to the model.
The current Claude backend supports this mode; backends that cannot enforce it
refuse the turn and require choosing a compatible model in the session. This
restriction applies to manual chat turns as well as automatic reviews. It does
not change the existing permissions of the project sessions doing repairs.

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
