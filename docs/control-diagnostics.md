# Control diagnostics

`verity_diagnostics` is an on-demand, read-only MCP tool advertised only to
Verity Control. Each call uses the existing approval and audit path; reusable
standing grants are unavailable. Caller identity and knowledge exposure are
checked before the approval and again when producing the snapshot.

Call with `{}` for the running server version, push and preview capability flags,
secret-job runtime readiness, and Uplink connection state. Readiness is `unknown`
when no runtime probe exists. A failed probe reports `not_ready` without exposing
its exception. Uplink reports `unknown` if its source is absent, fails, or returns
an invalid shape. Capability flags alone do not prove delivery or dependency health.

Call with `{ "sessionId": "<selected project session>" }` for one session's lifecycle,
last activity, projection truncation flag, and up to 20 structured technical
records from the latest 2,000 events. Existing cross-project target and knowledge
restrictions apply. The report omits messages, free-form errors, backend labels,
configuration values, credentials, and remote stream metadata.

The snapshot does not provide a job inventory, queue depth, GitOps comparison,
component versions, or cross-component correlation. It names these limitations
explicitly. A status code is evidence of a failure, not proof of its root cause.
Use existing fleet observations to corroborate a diagnosis, prepare a concrete
project-session handoff for remediation, and read the affected live state once
more after the fix. Do not poll this tool.
