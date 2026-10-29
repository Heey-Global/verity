# Diagnostic logs

Administrators can open **Settings → Server → Logs** and switch between Audit
and System. Audit records intent, initiator, outcome and provenance. Its detail
view also shows duration and the event timeline. Failed image builds link to
**Build output** using the audit operation ID.

## Build output

Failed image-build commands retain their captured stdout and stderr independently
of the audit database. The private `build-diagnostics` directory is below the
configured server data directory (falling back to the data-volume or workspace
root). Put that directory on persistent storage to retain output across restarts.
Files are private to the server user. Credential patterns, server environment
values and the scoped registry token are removed before writing; reads also
apply redaction. This is best-effort sanitization, not anonymization of customer
data such as repository names or paths.

Limits are 1 MiB per encoded record, 100 MiB across retained records, and seven
days. When a record exceeds its limit, the error tail is retained and marked
shortened. Oldest records are removed first. Cleanup runs on reads, writes and
hourly while the server is running. Expired files on a stopped server are removed
when it next reads, writes or performs its cleanup sweep. An unavailable file is
shown as unavailable, never as proof that the operation had no error.

Only command failures after a durable build intent can be linked. Success output,
pre-build validation failures and interrupted builds without a captured rejection
are not archived. Existing audit records do not acquire historical output.
Capture failures do not replace the original build error or prevent its audit
outcome from being attempted. A missing file can mean capture was unavailable,
storage failed, the record predates capture, or the total storage budget evicted it.

## Existing system sources

- **Server container:** bounded Docker stdout/stderr from the current server
  container, with a requested time window of at most 24 hours and a tail of at
  most 1,000 lines / approximately 64 KiB. Reaching a limit is marked as partial.
  Severity filters apply to structured numeric server log levels; plain output
  has no inferred severity. Unexpected agent exits already logged by the server
  appear here too. Docker logging configuration controls retention; replacing a
  container may remove its history.
- **Host events:** the existing read-only diagnostic snapshot supplies classified
  events, source states, freshness and coverage. Raw journal text is not exposed.
  Kernel/runtime events do not carry a trustworthy common severity, so the UI
  offers no severity filter for this source.

Neither source is copied into the database. Missing, failed, stale and truncated
sources are presented explicitly. No additional host privileges are requested.

## API and support boundary

`GET /audit/operations/:operationId/diagnostics` returns the build capture state,
operation provenance, safe phase/code, capture time, text and truncation state.
`GET /diagnostics/logs` accepts `source=server|host`, `since`, `until` and optional
`level=all|error|warning|info`. Responses are not cacheable. Both routes use the
existing administrator policy; project membership alone grants no access.

Selections include source/window or operation provenance and
`supportConsent: required`. This is a reusable local selection contract, not a
support report or consent receipt. No export, upload or support messaging is
implemented. A later support flow must separately select data, review customer
identifiers, show a preview and obtain explicit transmission consent. Local
administrator access must never be treated as permission to send that data.

Audit integrity verification, secret events in the unified list, additional
audit domains, audit retention, export and agent read access remain separate work.
