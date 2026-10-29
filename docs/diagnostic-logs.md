# Diagnostic logs

Administrators open **Settings → Server → Logs**. Builds, Images, Projects and
System share one category bar. All combines individual audit events with available
server messages and classified host signals, newest first in the selected time
window. Build requests and outcomes have separate rows at their own timestamps.
Older audit event pages retain stable ordering and filtering.

Sources load independently, so unavailable sources do not hide other entries.
Audit search queries event kind, operation IDs, image IDs and project labels;
System search covers loaded entries only. System-only source filters apply to
server/host entries, and severity filters are available for the server source
alone. Unknown severity is not Info.

Entries use local day groups and times. Messages are directly readable; tapping
a row opens technical details and audit events link to the associated operation.
Records use the log list (design system § 5.2a). With every source available there
is no status text; the header info button opens retention, coverage and retry
details, and an unavailable source is named in a hint box above the list.
Build failure output expands inside its operation details;
legacy system-log links redirect to the unified list or corresponding operation.

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
  most 1,000 lines / approximately 64 KiB. The bounded decoder retains the newest
  output across Docker frames on HTTP and Unix-socket transports. Reaching a limit is marked as partial.
  Severity filters apply to structured numeric server log levels; plain output
  has no inferred severity. Unexpected agent exits already logged by the server
  appear here too. Docker logging configuration controls retention; replacing a
  container may remove its history.
- **Host events:** the existing read-only diagnostic snapshot supplies classified
  events, source states, freshness and coverage. Raw journal text is not exposed.
  Kernel/runtime events do not carry a trustworthy common severity, so the UI
  offers no severity filter for this source.

The automatic server identity comes from the running kernel hostname rather than
an inherited `HOSTNAME` environment value. An explicit
`VERITY_DIAGNOSTIC_SERVER_CONTAINER_ID` still overrides it. Server failures expose
safe reason codes for missing configuration, missing containers, denied access,
unreachable Docker and other read failures, without exposing daemon error text.

Neither source is copied into the database. Missing, failed, stale and truncated
sources are presented explicitly. No additional host privileges are requested.

## API and support boundary

`GET /audit/operations/:operationId/diagnostics` returns the build capture state,
operation provenance, safe phase/code, capture time, text and truncation state.
`GET /diagnostics/logs` accepts `source=server|host`, `since`, `until` and optional
`level=all|error|warning|info`. Audit operation queries also accept optional
`since` and `until` bounds. Responses are not cacheable. These routes use the
existing administrator policy; project membership alone grants no access.

Selections include source/window or operation provenance and
`supportConsent: required`. This is a reusable local selection contract, not a
support report or consent receipt. No export, upload or support messaging is
implemented. A later support flow must separately select data, review customer
identifiers, show a preview and obtain explicit transmission consent. Local
administrator access must never be treated as permission to send that data.

Audit integrity verification, secret events in the unified list, additional
audit domains, audit retention, export and agent read access remain separate work.

### Individual event list

The Logs screen lists individual audit events alongside available Server messages
and classified host signals, newest first. A build request and its outcome are
separate records with their own event timestamps. Categories filter the same
list. The administrator-only `GET /audit/events` endpoint accepts `domain`, `q`,
`since`, `until`, `before` and `limit`; its cursor orders by stored timestamp and
unique event ID. Existing operation endpoints remain available for grouped details.
Audit search matches event kind, operation ID, image ID and project label.

Rows show readable messages directly. Tapping a row opens technical details;
audit records link to their operation and captured build output. Source availability
is shown separately from events. Audit pages can be loaded within the selected
time window, while System search and history cover only the loaded source snapshot.
This does not introduce Server or host log archiving.
