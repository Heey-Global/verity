# Coordinate sessions from chat

Ask your agent to start a session in a named project, link it to the current
session and hand over a task:

> Start a new session in the Website project, link it here and ask it to
> investigate the failing login test.

You can also ask it to find an existing session first:

> Find the session handling login tests in the Website project, link it here
> and ask what it has found.

The agent searches projects and sessions you may access. It uses session names,
status and published progress summaries, without reading another session's
transcript. Summaries may be missing or outdated, so a result is evidence of a
possible match. When several matches are plausible, the agent asks you to choose.
Control sessions are supported when your permissions allow them. Large projects
are searched in bounded pages; an initial partial scan does not establish that
no matching session exists.

Creation and linking follow managed approval. Review the selected project,
session and requested handover before approving. These actions are unavailable
while the source session is planning. You can still manage links manually in
Session settings.

A link permits bounded text exchange between the two agents. It grants no
additional repository, tool, secret or transcript rights, and each agent retains
its existing authority. Existing message allowances and renewal approvals still
apply. A message from another agent cannot authorize further delegation.

If creation, linking or handover is interrupted, retry the same request rather
than requesting a second session. The agent reuses a stable request ID to avoid
duplicate sessions and assignments and reports any partial result. A queued
handover was accepted for delivery; it does not mean the target is already
running, or that the assigned task is complete.
