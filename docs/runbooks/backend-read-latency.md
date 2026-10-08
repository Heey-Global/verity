# Investigating slow overview reads

With server logging enabled, slow overview and session-detail reads emit
`slow backend read diagnostic` after three seconds. This covers `/projects`,
`/sessions` (including the envelope response), session detail, activity, links,
branches, session/project dev-server discovery, public-share listing, server
updates, and provider limits. Streaming routes do
not run the probe. No new endpoint or database permission is required.

First confirm the running image's OCI revision label. Deploying a new release
and measuring an older container are different observations. Retain the UTC
completion time, request ID, route pattern, status, and duration for each wave.
The diagnostic contains route patterns, request IDs, bounded code locations,
and numeric aggregates; it does not
include raw URLs, session/project IDs, SQL, query parameters, or errors.

| Field | Meaning |
| --- | --- |
| `beforeHandlerMs` | Time from the first request hook to handler entry, including authentication and parsing. |
| `eventLoopDelayMaxMs` | Maximum lateness of a 100 ms timer while the request was open, also checked at completion before a delayed timer can fire. |
| `eventLoopUtilization` | Process-wide utilization during the request, shared with other work in that interval. |
| `poolAcquire` | Connection acquisition count, total/max duration, failures, and observed maximum queue length/pool size for this request. Includes connection creation and generation verification as well as waiting for an available connection. |
| `poolAcquire.holders` | Up to ten oldest checked-out connections observed after a checkout has been pending for one second. Each has an origin (`METHOD route-pattern (request-ID)` or bounded background code locations) and `heldMs`. Holders also include the acquisition phase when available and
PostgreSQL `backendPid` when supplied by the driver. Collected once per request; absent when no checkout reaches the threshold. |
| `poolAcquire.holderSampleWaitMs` | Time the sampled checkout had already been pending. A late sample can reflect event-loop delay. |
| `queries` | Query execution count, total/max duration and failures after checkout, including result decoding. SQL lock waits belong here. |
| `phases` | Named handler phase durations, including failures. |

`totalMs` values sum individual operations. Concurrent operations and nested
phases overlap, so these totals can exceed HTTP wall time and must not be added
as if they partitioned the request. The pool/SQL aggregates use the production
PostgreSQL driver; an alternative driver does not supply these measurements.

`request_authorization` times the paired-user route access check in the request
hook; compare it with `beforeHandlerMs` to separate that database-backed check
from other work before handler entry. `pool_generation_verify` times the
initial shared-lock and server-generation check when a new physical PostgreSQL
connection is created. That work happens before checkout resolves and otherwise
appears only as acquisition time. Neither measurement changes authorization
or generation fencing.

For session lists, inspect `session_list`, `session_projection`, `session_links`,
`session_summaries`, and `session_attention`. For project lists, inspect
`project_list` (including installation sync and reconciliation),
`project_permissions`, `project_overview`, `project_toolkit`, `project_releases`,
and `project_sandbox_updates`. `project_release_refresh` separates waiting
for the release service from `project_release_persist` database writes.
`project_settings` and `project_control` cover the settings read and optional
control-project creation inside the overview.

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

## Identifying connection holders

During a slow wave, retain `poolAcquire.holders` with the request ID and UTC
completion time. Match holder request IDs to the normal request logs. All
HTTP methods receive an origin, including write routes; only the selected
slow reads emit diagnostics. A background origin contains sanitized source
file/line locations rather than SQL or query parameters.

The snapshot is taken while checkout is pending, before the blocking
connections are released. It reports checked-out connections, not current SQL
statements or database locks. A long hold can include a transaction waiting
on external work, query processing, or delayed JavaScript scheduling. The
origin names the context that acquired the connection; asynchronous work
started by a request can retain that origin after its response.

Snapshots are bounded and sampled, not a complete history. A blocked event
loop can delay the sampling timer until holders have changed; an empty snapshot
does not prove that the pool was idle throughout the wait. Correlate repeated
holders across a wave and inspect those callsites next. Event-loop utilization
and pool acquisition times alone still do not identify the CPU consumer.

## Optional CPU capture during a latency wave

Set `VERITY_LATENCY_CPU_PROFILE_DIR` to an absolute writable directory in the
server container, outside the repository (for example `/var/tmp/verity-latency`),
when starting a diagnostic deployment. Leave it unset during normal operation.
This setting is opt-in: the local inspector session does not open a debugging
port. No profiling occurs without the setting.

An observed event-loop delay of at least 500 ms starts a five-second CPU
profile. Only one capture runs at a time, with a five-minute cooldown and at
most three attempts per process. Captures larger than 8 MiB are discarded.
Files are created with mode 0600 in a directory created with mode 0700; an
existing directory keeps its existing permissions. A bounded log message
`backend latency CPU profile` identifies the saved file or failure stage,
without logging the profile or raw error.

Retrieve the `.cpuprofile` files from that directory and inspect them in a CPU
profile viewer. These files contain function names and source locations, not
SQL or argument values. Keep them local and remove them after analysis; they
are diagnostic artifacts, not repository content. Shutdown stops an active
profiler. Unset the variable on the next normal deployment.

Sampling starts after a delay is observed and cannot reconstruct a block that
has already ended. It is most useful during recurring waves. A profile without
a CPU hotspot does not rule out host scheduling stalls or earlier blocking
work. Pool-holder snapshots and CPU samples answer different questions and
should be correlated by time, not treated as interchangeable evidence.
