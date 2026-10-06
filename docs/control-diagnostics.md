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
environment values, credentials, and remote stream metadata. Resource limits
are returned as explicit technical measurements in the infrastructure section.

The snapshot does not provide a job inventory, queue depth or GitOps comparison.
Docker version, component image IDs and runtime timestamps support incident
correlation; they do not constitute a complete component version inventory.
The report names source coverage and limitations explicitly. A status code is evidence of a failure, not proof of its root cause.
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

## Local resources and runtime incidents

The `infrastructure` section combines bounded read-only evidence for local and
Docker-backed installations. It includes Server process memory and heap limits,
visible host memory/load, data filesystem capacity, visible cgroup v2 memory
counters and peak, CPU quota/throttling, Docker version, container image IDs,
start/end times, restart counts, exit codes, OOM flags, health, resource limits
and current container memory/PID statistics. Unsupported measurements are
`null`; an unavailable counter is never reported as zero. Host memory and load
may describe the whole machine rather than the container's allocation.

The default window is the last hour. Select a historical interval with ISO
 timestamps including a timezone offset:

```json
{
  "projectId": "<selected project>",
  "runtime": {
    "since": "2026-10-06T20:00:00+02:00",
    "until": "2026-10-06T20:15:00+02:00"
  }
}
```

Intervals must be ordered, at most 24 hours long, and end no later than the
current time (with one minute of clock tolerance). `sessionId` also selects its
owning project's container when `projectId` is omitted. Project access is
checked before collecting evidence and again before returning it. Historical
Docker events retain IDs for removed containers when the daemon still has those
events. The tool never accepts a shell command, journal selector, arbitrary
container ID, path or unrestricted log query.

Infrastructure containers are selected using the running Server's managed
 deployment or Compose project labels and an allowlist of component roles.
For managed Servers created outside Compose, the attached control network's
verified Docker ID and Compose ownership identify companion services in the
same stack. Without a verified deployment identity, the tool does not enumerate unrelated
host containers. At most 12 containers, 256 Docker events and 200 log lines per
infrastructure container are read. Docker calls have five-second timeouts within
an overall 30-second Docker collection deadline and bounded response bodies.
Project-container stdout/stderr is excluded because it can contain transcripts.
Infrastructure log messages are converted to allowlisted codes for memory
pressure, kernel faults, disk/file/process limits, runtime starts/stops and
failures, Runner reconciliation failures and update progress; raw text, environment values, arbitrary labels and credentials are
never returned. Other error/failure messages produce a generic `runtime_error` code; normal
unrecognized messages produce no record.

`OOMKilled: false` and low current RAM do not exclude a prior host OOM kill.
Exit code 137 alone does not prove OOM. Docker's recent event buffer can truncate
history and is lost on daemon restart; missing events are not proof that a
container remained alive. Samples and event timestamps support correlation,
not an automatic root-cause verdict.

## Historical host evidence

The self-hosted installer installs `verity-host-diagnostics` and a systemd timer
that refreshes its snapshot every minute. It reads the previous 24 hours from
kernel, Docker, containerd and host-runtime journals, including retained earlier
boots. Only classified technical codes, timestamps, boot IDs and recognizable
container IDs are exported. The script changes neither containers nor runtime
registrations. Raw journal entries remain on the host.

The snapshot is written atomically to
`/var/lib/verity/host-diagnostics/snapshot.json`. Compose mounts that directory
read-only at `/run/verity-host-diagnostics` in the Server, never in project
sandboxes. Collection reads at most 2,001 entries and 1 MiB per journal source,
returns at most 200 classified records per source, and marks truncation. Source
failures remain separate from healthy evidence. Journal retention limits the
available history; the exporter cannot recover already discarded records or a
memory peak that was never measured.

For an existing installation, rerun the self-hosted installer to install the
exporter and timer and apply the Server mount. A Server image update alone does
not install a host service. Managed bootstrap seals the same read-only bind into
new deployments and migrates existing specifications on an installer rerun.
Other sealed fields and absent resource-limit fields are preserved; an already
sealed diagnostic host path cannot be relocated implicitly. A running Server
that exactly matches its recorded pre-migration authority keeps serving and is
reported as having a pending diagnostic mount. The next normal guarded Server
update applies the bind; a stopped pre-migration Server is recreated with it.
Other structural mismatches remain fatal. Host evidence is unavailable in the
running Server until this replacement occurs. Older releases that
predate this mount cannot parse the migrated specification. The migration keeps
the previous sealed authority as `server-deployment.before-host-diagnostics.json`
in the updater-owned deployment root, without overwriting it on retries. A
rollback below that release requires compatible authority and its matching
image, restored through the normal stopped-deployment maintenance workflow.

On hosts without systemd, schedule the installed
`/usr/local/libexec/verity/verity-host-diagnostics` yourself, for example once per
minute using the host's scheduler. It requires Bash, GNU date/coreutils and jq;
`journalctl` and permission to read system journals are needed for host evidence.
Hosts without those journals still retain local and Docker diagnostics.

For containers with a custom hostname, set `VERITY_DIAGNOSTIC_SERVER_CONTAINER_ID`
to the Server's Docker container ID to anchor infrastructure selection.

For a custom deployment, mount the classified snapshot directory read-only and
set `VERITY_HOST_DIAGNOSTIC_SNAPSHOT` to its Server-visible snapshot path. An
explicit `VERITY_HOST_DIAGNOSTIC_DIR` can select the exporter/Compose host path;
configure the systemd service's environment and writable paths consistently
when using a non-default directory. A bare local Server can read the snapshot
from its host path using `VERITY_HOST_DIAGNOSTIC_SNAPSHOT`.

Each report includes source availability, snapshot time, covered interval and
truncation. A snapshot older than five minutes, or more than one minute ahead of
the Server clock, is marked stale. Unavailable, failed, stale, partial or truncated
host evidence cannot exclude OOM or a runtime crash. Reading an old interval
does not extend the exporter's 24-hour collection window. Use these diagnostics
on demand; the host timer collects evidence independently of agent polling.
