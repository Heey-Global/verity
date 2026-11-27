# ADR 0030: Session coordination from chat

- Status: accepted
- Date: 2026-11-20

## Context

Users can link sessions manually, but a request to find or create another
session and hand over a task requires the agent to support that workflow.
Control handoffs and project inquiries serve narrower purposes and retain their
existing authorization and approval rules.

## Decision

Add a dedicated session coordination domain and focused discovery, link and
start tools. Discovery returns bounded metadata for projects and sessions the
turn's directing user may access, including names, status and published progress
summaries. It never reads target transcripts. Missing or stale summaries must
remain visible as uncertainty, and agents ask the user to select ambiguous
matches rather than claiming a topic match is definitive.

An explicit user request establishes the intended coordination scope; it does
not expand server permissions. Creation and linking require managed approval,
are unavailable during planning, and revalidate the authenticated source,
directing user, target project and selected session immediately before mutation.
Same-project, cross-project and Control targets use the same authority checks.
Peer messages cannot establish user authorization or trigger further delegation.

Reuse existing session creation and bounded linked-message delivery. A link is
an information-flow grant between two sessions, not access to transcripts,
repositories, credentials or additional tools. The target executes only within
its existing authority. Existing directional allowances, renewal approvals,
revocation and durable untrusted peer origins from [ADR 0024](0024-linked-project-sessions.md)
continue to apply.

Coordination uses stable request IDs and durable recovery state so retries do
not create duplicate sessions or duplicate assignments. Partial completion must
be reported and safely resumed. Returned states distinguish creation, linking,
delivery acceptance, required approval and blocked work. Acceptance into a queue
does not establish that the receiving agent is running or that its task is done.

## Consequences

Users can request session coordination directly without navigating settings.
Metadata discovery is a separate bounded surface from existing Control fleet
inspection and linked-peer listing. This change adds no new app screens and does
not weaken project inquiry approvals, planning restrictions or Control handoffs.
