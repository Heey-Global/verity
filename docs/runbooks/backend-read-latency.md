# Investigating slow overview reads

With server logging enabled, slow overview and session-detail reads emit
`slow backend read diagnostic` after three seconds. This covers `/projects`,
`/sessions` (including the envelope response), session detail, activity, links,
branches, dev-server discovery, and public-share listing. Streaming routes do
not run the probe. No new endpoint or database permission is required.

First confirm the running image's OCI revision label. Deploying a new release
and measuring an older container are different observations. Retain the UTC
completion time, request ID, route pattern, status, and duration for each wave.
The diagnostic contains route patterns and numeric aggregates; it does not
include raw URLs, session/project IDs, SQL, query parameters, or errors.

| Field | Meaning |
| --- | --- |
| `beforeHandlerMs` | Time from the first request hook to handler entry, including authentication and parsing. |
| `eventLoopDelayMaxMs` | Maximum lateness of a 100 ms timer while the request was open, also checked at completion before a delayed timer can fire. |
| `eventLoopUtilization` | Process-wide utilization during the request, shared with other work in that interval. |
| `poolAcquire` | Connection acquisition count, total/max duration, failures, and observed maximum queue length/pool size for this request. Includes connection creation and generation verification as well as waiting for an available connection. |
| `queries` | Query execution count, total/max duration and failures after checkout, including result decoding. SQL lock waits belong here. |
| `phases` | Named handler phase durations, including failures. |

`totalMs` values sum individual operations. Concurrent operations and nested
phases overlap, so these totals can exceed HTTP wall time and must not be added
as if they partitioned the request. The pool/SQL aggregates use the production
PostgreSQL driver; an alternative driver does not supply these measurements.

For session lists, inspect `session_list`, `session_projection`, `session_links`,
`session_summaries`, and `session_attention`. For project lists, inspect
`project_list` (including installation sync and reconciliation),
`project_permissions`, `project_overview`, `project_toolkit`, `project_releases`,
and `project_sandbox_updates`.

Use several requests in the same wave to distinguish candidates:

- Large event-loop delay across unrelated requests supports a process-wide
  scheduling stall. It does not identify the blocking function or distinguish
  synchronous JavaScript from OS scheduling delays.
- Large acquisition duration with observed queued callers supports pool
  contention. Connection setup, generation verification, and event-loop stalls
  can also extend acquisition; do not call all acquisition time queue time.
- Large query duration with small acquisition and timer delay supports slow SQL
  or database lock waits. Obtain an approved PostgreSQL activity/lock sample to
  distinguish them; the diagnostic does not inspect database sessions itself.
- A slow project refresh, release lookup, or sandbox update phase with little
  database time and timer delay points to its external dependencies. Correlate
  with gateway/Docker logs before changing timeouts or cache behavior.

The dev-server discovery fix returns an empty list when an active project's
container has disappeared. Other Docker failures remain errors. This corrects
that discovery response; it does not establish a cause for broad latency waves.
