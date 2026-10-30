# Project egress host controller

Status: experimental, deny-only host foundation. This is not a production
protected-mode implementation. The installer and Server do not enable or invoke
it. The existing policy APIs and account/action permissions are unchanged.

## Authority and protocol

The host service exposes only `POST /v1/command` on
`/run/verity-egress/control.sock`. Its directory belongs to root and the dedicated
`verity-egress-control` group; it is not mounted into a project or relay. A
256-bit bearer key at `/etc/verity-egress/control.key` is projected read-only only
to the trusted Server. It must never be a project secret or environment value.
The listener limits headers, request size and concurrent admitted operations.

The strict protocol can query the current binding, register an exact network
binding, prepare denial, start an exact container as sandbox/relay, connect the fixed inspected pair, and retire a
generation.
It accepts neither commands nor nft rules, URLs, destination grants or arbitrary
Docker specifications. Renewal/admission is deliberately unavailable in this
increment: installing a destination lease cannot override the startup fence.
A successful start response is `started-denied`, never `protected` or `ready`.

The Server is the trusted registrar. Project and generation come from that
registrar, never labels or sandbox headers. The host separately checks the local
Docker daemon's network ID, explicit bridge, network name, endpoint membership,
container ID, nonprivileged configuration, role-specific capabilities and
`restartPolicy: no`. Both roles currently require the `runsc-project` runtime
with exactly the inspected systrap/sandbox/host-uds profile; ordinary runc is
rejected because Docker embedded DNS can bypass bridge filtering. The existing
runc relay therefore cannot use this experimental start path; injection selects
gVisor for the relay. Both roles drop all capabilities and require no-new-privileges.
Only the Sandbox may add the exact Runner process-identity set (CHOWN, KILL,
SETGID, SETPCAP, SETUID); neither role can add network or admin capabilities. Stopped containers may lack endpoint IDs; admission later
requires the existing full attachment verifier after start.

## Durable reservation and start ordering

A versioned registry under `/var/lib/verity-egress` reserves generation identities,
bridge/network IDs and container roles, including retired reservations. It is
saved by file fsync, atomic rename and directory fsync before acknowledging a
registration or starting a process. Corrupt or conflicting state fails closed;
a failed write poisons the current controller until restart. The supplied systemd
units hold an exclusive flock across the full process lifetime. Direct entrypoint
invocation without this lock is unsupported.

The global startup tables deny routed, host-directed and same-bridge traffic from
the reserved `vep*` interfaces. Individual generation tables add persistent denial.
Restoration requires no running Docker daemon. Every start then serializes
inspection, durable reservation, acknowledged denial, fresh inspection and Docker
start. Post-start inspection failures restore denial and stop the exact container.
Retirement keeps denial and reservations, stops registered containers, and rejects
reactivation even after process reconstruction. No cleanup operation opens access.

Before explicit transport readiness, this denies all traffic, including DNS and relay traffic. Bounded transports,
verified endpoint admission and the full Runner runtime acceptance fixture remain
subsequent increments, not hidden exceptions in this protocol.

## Host service packaging

`node scripts/build-project-egress-host.mjs` bundles the host entrypoint to
`packages/server/dist/project-egress-host-main.mjs`. The files in `deploy/egress`
are uninstalled fixture templates, not a production installation command:

- `verity-egress-bootstrap.service` restores denial before Docker.
- `docker-egress.conf` makes Docker require successful bootstrap and repeats
  locked denial restoration in `ExecStartPre` on every daemon start.
- `verity-egress-host.service` restores denial again before binding the socket,
  then accepts the trusted Server's commands after Docker starts.

A fixture installation must supply the dedicated group, protected key directory,
bundle at `/opt/verity-egress`, Node 26, nftables, a local rootful Docker daemon,
and the unit/drop-in files together. RuntimeDirectory cleanup removes stale
sockets between service invocations; the application never steals an existing
socket pathname. `LiveRestoreEnabled` and rootless Docker are rejected by the
control entrypoint. The experimental entrypoint accepts Docker 29.9.2, matching
the pinned runtime fixture; other daemon versions require explicit validation.
Systemd >=249 must run as PID 1: Docker continuously upholds
the controller, and `BindsTo`/`PartOf` plus ordering couple controller teardown and
revalidation to daemon transitions. `Type=notify` reports readiness only after
denial, host checks, binding revalidation and control-socket creation. Shutdown
rejects queued admissions before fencing after in-flight writes; independent
`ExecStopPost` denial also runs after crashes or failed startup, without needing
the registry or Docker. Both preflight and cleanup share the controller lock.
Kernel-denial failure attempts registered-container containment during graceful
shutdown; systemd ordering alone cannot guarantee containment if the kernel and
container stop operations both fail.

The separate `project-egress-boot` workflow preflights an actual KVM guest from a
dated, SHA256-pinned Canonical image and requires a changed guest kernel boot ID.
Missing KVM is a failure, not a skipped acceptance result or container fallback.
This establishes boot-VM feasibility only; actual-unit ordering, retained
Runner/relay topology and daemon/Server recovery still require the subsequent
VM integration matrix before these templates may be installed in production.

## Evidence and remaining gates

Unit tests cover durable-before-start ordering, failed persistence/firewall/
inspection, serialized retirement, recovered reservations, identity conflicts,
post-start mismatches, schema rejection, actual Unix authentication and corrupt
or symlinked state. The disposable gVisor workflow additionally exercises the
actual host controller, durable store and Unix listener with a process emitting
UDP from its first instructions. An independent receiver must observe nothing
until a removed-fence mutation restores delivery. Registry reconstruction and
retired-start rejection run while the fixture retains its exact generation.
This probe covers one IPv4 startup path; it is not the complete Runner/relay,
dual-stack, retained-socket, systemd boot or daemon-restart acceptance fixture.

Production remains disabled pending full lifecycle and bounded-route integration,
absolute-expiry handling under delayed commit/suspension, continuous startup and
restart observation, and per-path closure within the agreed two-second acceptance
bound. The existing 184-case regression and adapter smoke remain independent
baselines. No existing project is migrated or labelled protected by this change.

## Experimental Server lifecycle injection

`ProjectEgressLifecycle` connects the Provisioner and relay lifecycle to the
bounded authenticated Unix client. It is an internal dependency for disposable
fixtures; production configuration does not construct or select it. The client
has a total deadline, bounded headers/body, strict response validation and no
retries. A lost acknowledgement means an unknown outcome, never permission to
start through Docker directly.

The host's read-only `current` operation recovers the active registered generation
without consulting container labels, renewing a lease or changing rules. New
provisioning retires the previous host binding before creating a fresh generation
bridge. Docker restart policy is `no`; Sandbox and relay starts, wake and relay
in-place recovery require host acknowledgement. The relay uses the same isolated
gVisor runtime, including when adopted after Server reconstruction. A selected
path never falls back to the legacy project network. Devcontainer builds and
privileged runtime configurations are rejected for this experimental path.

This remains deny-only: the injected path cannot yet provide usable DNS, model,
broker or preview access, and is not a production-ready protected project mode.
Stale gVisor filestore recovery cannot replace a registered object within the
same generation; repair must retire that generation and allocate a fresh one.
Generation networks and retired host reservations are retained, not garbage
collected by this increment. Complete systemd/daemon failure, hard-expiry and
real Runner/relay traffic evidence remain open acceptance gates.

## Experimental relay profile

The optional host-controlled relay uses `runsc-relay` with exactly
`--platform=systrap`, `--network=sandbox`, and `--host-uds=open`. Only the disposable
egress CI daemon registers this profile. The production installer and the Sandbox's
`runsc-project` registration are unchanged. Missing or different profiles refuse
protected startup; there is no runc, host-network, or `host-uds=all` fallback.

The host service optionally reads `/etc/verity-egress/relay.json`, a canonical,
root-owned private file. Absence disables relay starts. Its strict schema contains
`image` (an immutable repository digest or image content ID), `dataVolume`,
`socketOwnerUid`, `relayGid`, `brokerSubpath`, `claudeSubpath`, and optional
`codexSubpath`. Paths are relative directories below the inspected local Docker
volume, not arbitrary bind sources. Provisioning does not write this policy.

For each start, including adoption, the host derives the generation directory
using the same identity helper as the existing listeners. It checks declared
volume subpaths, effective mounts, socket inode permissions and directory contents,
non-writable/non-symlinked ancestors, image identity, fixed entrypoint, non-root
user, read-only filesystem and private namespaces. Only the three compiled relay
socket targets are eligible; extra mounts, devices, published ports, overridden
commands and additional environment settings are refused. Forge proxy overrides
are consequently unavailable on this experimental path. Read-only mounts restrict
filesystem changes, not socket operations: existing broker/account/action and
model authorization remain required.

After Docker becomes available, the host service revalidates restored container
bindings before serving control requests. During this deny-only restoration, a
stopped relay may have empty trusted socket directories: its Server-owned
listeners cannot exist until Server recovery. Ownership, permissions, generation
mounts and container identity remain mandatory. Running relays and all ordinary
start/admission checks still require the socket inodes. Server unlock restores
verified relay listeners before projecting gateway identity, preventing an empty
process-local listener map from triggering Sandbox replacement. Individual relay
recovery failures are logged without blocking administrative unlock.

Mismatches cause attempted container stops and leave the controller unavailable.
The bootstrap rule restoration remains
independent of Docker. This does not establish daemon boot acceptance or hard lease
expiry under host suspension.

The experimental gVisor relay uses a PID ceiling of 64 rather than the ordinary
relay's 32, because the cgroup includes sentry/gofer threads. With the pinned
systrap runtime, 32 produced a `newosproc` failure; a sequential comparison at
64 passed broker readiness with the same 192 MiB memory and CPU limits. The
96 MiB V8 heap cap is unchanged. This evidence is specific to the pinned runtime,
not a universal minimum for other gVisor versions or workloads.


## Experimental Sandbox-to-relay transport

After both registered roles are running, the host derives each endpoint from
local Docker inspection and the actual network-namespace/veth/bridge topology.
Docker's network and container IP/MAC assignments must agree. gVisor transfers
addresses into netstack, so the Linux peer proves the interface binding, not the
continued presence of an address on that Linux NIC.

Admission atomically replaces both the reserved-prefix boot rules and generation
rules. The only IPv4/TCP paths are Sandbox to its relay on 8080, 8443 and, when the
host policy includes a Codex socket, 8444. Return traffic must match the same pair,
service source port and established conntrack state. Bridge rules additionally
bind both interface indices/names and MACs; ARP is limited to the same pair.
Each admission uses a fresh 128-bit conntrack label, assigned only to an initial
SYN. Both directions require that exact label, so old streams remain denied after
re-admission, including loosely re-tracked mid-stream packets. Protected transport
labels are host-owned and are not restored from cached controller state.
Host input, other endpoints, IPv6, UDP and DNS remain denied. The relay has no
Internet exception. Existing gateway TLS, project identity, credential/account
and action authorization remain authoritative.

`connect` takes only a project/generation reference and acknowledges the inspected
relay IPv4 address. Provisioning compares it with the mounted hostname projection.
Protected DNS overrides confer no access. Start, prepare, retirement and recovery
first revoke the pair; restart can admit it only after both roles are revalidated.
Recovery does not replay cached addresses. A failed revocation poisons the
controller and attempts to stop both registered containers.

This remains experimental and uninstalled. It does not implement general DNS or
Internet admission, connector/preview transport expansion, the full attack matrix,
daemon boot acceptance, or hard expiry during host/controller suspension.

## Native boot and recovery evidence

[Native KVM run 41033733062](https://github.com/Heey-Global/verity/actions/runs/41033733062)
passed on source commit `b798d4604b75d756dcdc655ac4169542e27c1bb0`.
The downloaded artifact also passed the independent `boot-proof.py verify` check:
five lifecycle events, eight removed-fence observation paths, and complete raw
evidence. Controller SIGKILL, actual Server SIGKILL, Docker stop/start, Docker
SIGKILL and a real kernel reboot retained the same Sandbox/relay container IDs,
images, mounts and registry. The reboot changed the kernel boot ID.

Independent dual-stack receivers observed no unauthorized protected traffic.
Old streams and the bounded in-flight request stayed denied after re-admission;
fresh authenticated memory requests succeeded. Corrupt registry, nftables failure
and unsupported live-restore configuration were rejected. Removing the fences
restored receipt on all eight observation paths, including inherited and
transferred descriptors.

The largest observed post-event successful-request/handler-receipt offset was
0.408 seconds, within the two-second fixture bound. The separately measured
explicit recovery phase took 6.752–12.880 seconds; this excludes event handling
and reboot waiting and is not total outage duration. These observations apply to
the pinned experimental Linux/systemd, Docker and gVisor configuration in this
run. They do not establish hard expiry during host/controller suspension, general
Internet/package/connector/preview access, the remaining attack matrix, or
production readiness. The templates remain uninstalled and protection inactive.
