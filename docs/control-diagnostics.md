# Control diagnostics

`verity_diagnostics` is an on-demand, read-only MCP tool advertised only to
Verity Control. Each call uses the existing approval and audit path; reusable
standing grants are unavailable. Caller identity is checked before approval and again when producing the snapshot.
Verified Control callers can read metadata even when caller or target has Knowledge.
Recent-message reads retain the caller and target Knowledge restrictions.

Call with `{}` for the running server version, push and preview capability flags,
secret-job runtime readiness, and Uplink connection state. Readiness is `unknown`
when no runtime probe exists. A failed probe reports `not_ready` without exposing
its exception. Uplink reports `unknown` if its source is absent, fails, or returns
an invalid shape. Capability flags alone do not prove delivery or dependency health.

Call with `{ "sessionId": "<selected project session>" }` for one session's lifecycle,
last activity, projection truncation flag, and up to 20 structured technical
records from the latest 2,000 events. Hidden projects and Control targets remain unavailable. The report omits messages, free-form errors, backend labels,
configuration values, credentials, and remote stream metadata.

The snapshot does not provide a job inventory, queue depth, GitOps comparison,
component versions, or cross-component correlation. It names these limitations
explicitly. A status code is evidence of a failure, not proof of its root cause.
Use existing fleet observations to corroborate a diagnosis, prepare a concrete
project-session handoff for remediation, and read the affected live state once
more after the fix. Do not poll this tool.

## Matrix import failures

Select `projectId` to read Matrix room import diagnostics for that project. The
verified Control identity and target project checks apply. The
snapshot exposes identifiers, timestamps, HTTP status, attempt counts and
allowlisted failure codes, never response bodies or message contents. At most 20
rooms and 20 active failed imports from each account's connector report are
available; additional failures may be omitted.

The connector reports active failures through its authenticated account update.
An omitted `importDiagnostics` field preserves existing evidence for older
connectors; an empty snapshot clears it after successful retries. Event data
remains in the outbox until import succeeds. `target_message_not_found` identifies
a rejected edit or redaction whose original message was unavailable. It does not
prove why that original message is absent.

An optional `matrixEvent: { accountId, sourceId, eventId }` with `projectId`
checks a single persisted event without revealing its content or sender. Room
binding and activation are checked before and after reading; events from an
older activation are hidden. A stored event alone does not prove Knowledge
projection succeeded. A missing retry alone does not prove import succeeded.
`importDiagnosticsReportedAt` identifies the last connector snapshot and
`importDiagnosticsTruncated` warns that a bounded report omitted failures.

## Control handoffs and progress

Verified Control sessions may list project-session metadata and send approved
briefings across Knowledge boundaries. A handoff carries only the supplied title
and briefing, without automatically copying project Knowledge or transcripts.
Progress returns lifecycle, timestamps, completion and outcome-delivery flags,
and allowlisted technical diagnostics. Free-form summaries, decisions, branch
names, pull-request data and transcripts are excluded from this metadata view.
Ordinary project sessions cannot use these Control tools.
