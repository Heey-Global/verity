# Bounded agent signal diagnostics

When an ACP process exits with `exitCode: null` and `signal: SIGHUP`, the displayed
fallback exit code does not identify its cause. A signal can originate from a
process or from the kernel; an empty stderr tail does not distinguish them.

The sandbox toolkit includes `verity-agent-signal-trace`, an opt-in Linux
signal-delivery observer for Codex ACP. It records `SIGHUP`, its `si_code`, and
sender PID/UID and process-group/session IDs when the kernel supplies them.
Kernel-generated signals do not necessarily have a sender PID. A sender that
has already exited may have no readable group/session IDs. PID reuse must be
considered when correlating records with later process snapshots.

The observer records numeric process metadata, without reading arguments,
environment variables, or tool output. Its records go to the adapter's stderr
and therefore to the existing bounded, redacted process-failure diagnostic.
Successful turns do not produce a process-failure diagnostic.

## Activate one diagnostic window

Deploy a sandbox image containing the updated broker, Python 3, and observer.
Existing sandboxes need the updated files through the normal provisioning path;
a server update alone does not install the observer. This feature does not
change Docker's pinned runtime registrations or enable gVisor debug logging.

A host administrator can create a lease for one session inside its project
container. Replace both variables with the selected container name and session
UUID. The command requires the existing authority to execute as root in that
container; it does not add permissions to the agent.

```sh
container='your-project-container'
session='00000000-0000-0000-0000-000000000000'
docker exec -i --user 0 "$container" /usr/bin/python3 - "$session" <<'PY'
import json, os, sys, tempfile, time
root = '/run/verity-runner-broker'
with tempfile.NamedTemporaryFile(mode='w', dir=root, delete=False) as lease:
    json.dump({'sessionId': sys.argv[1], 'expiresAt': int(time.time() * 1000) + 600000}, lease)
    path = lease.name
os.chmod(path, 0o600)
os.replace(path, root + '/signal-trace.json')
PY
```

Start the affected session's next turn within the window. The broker accepts
only a root-owned, non-symlink regular lease, with exactly the two fields above,
a matching session UUID, and an expiry at most ten minutes away. Expired,
malformed, writable-by-others, or non-root-owned leases leave launches unchanged.
The lease is unavailable through the agent spawn protocol. Wiki-isolated
sessions and other backends are excluded.

The observer attaches before the adapter is executed. The adapter retains its
PID, parent, process group, stdio, and exit behavior. A separate diagnostic child
is explicitly authorized to trace it through `PR_SET_PTRACER`, without elevated
capabilities. All existing threads and subsequently cloned threads are observed;
agent subprocesses are not traced. Attachment requires Linux ptrace support and
an applicable host security policy. If diagnostic setup or attachment fails, a `trace-failed` record
is emitted when the output channel is available and the adapter starts normally.

Observation stops at the lease's remaining duration (at most ten minutes) or
when its 64 KiB output budget is exhausted or its diagnostic output cannot accept data.
Diagnostic writes do not change the adapter's stderr blocking mode. Delivery of signals is preserved,
including fatal signals and job-control stops. The observer then detaches; the
adapter continues normally. Cancellation does not intentionally kill the
adapter. Tracing changes timing and adds a diagnostic child, so failure to
reproduce during observation is not proof that the original failure is resolved.

## Read and remove

After a failure, retrieve that session's process-failure diagnostic through
Control. Look for JSON records with `event: signal` and `signal: SIGHUP` inside
`stderrTail`. Correlate `senderPid` and the process-group/session IDs with a
contemporaneous process snapshot. An absent record may mean attachment failed,
the window expired, the output budget was exhausted, or the bounded stderr tail
no longer contains it; it does not rule out a signal.

The observer is a signal-delivery trace, not a syscall trace. It cannot establish
which command called `kill`, and kernel-originated signals require process-group
and runtime evidence to explain their cause.

The window expires automatically. To disable future traced launches immediately,
an administrator can remove the lease:

```sh
docker exec --user 0 "$container" /usr/bin/python3 -c \
  'from pathlib import Path; Path("/run/verity-runner-broker/signal-trace.json").unlink(missing_ok=True)'
```

Removing the lease does not interrupt an observer already attached; its original
deadline still applies. To stop that observer early, send SIGTERM to the
**diagnostic child only**, not the adapter or its process group. It detaches
without forwarding that signal to the adapter.
