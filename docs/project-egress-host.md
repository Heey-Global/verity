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
binding, prepare denial, start an exact container as sandbox/relay, and retire a
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

This denies all traffic, including DNS and relay traffic. Bounded transports,
verified endpoint admission and the full Runner runtime acceptance fixture remain
subsequent increments, not hidden exceptions in this protocol.

## Host service packaging

`node scripts/build-project-egress-host.mjs` bundles the host entrypoint to
`packages/server/dist/project-egress-host-main.mjs`. The files in `deploy/egress`
are uninstalled fixture templates, not a production installation command:

- `verity-egress-bootstrap.service` restores denial before Docker.
- `docker-egress.conf` makes Docker require successful bootstrap.
- `verity-egress-host.service` restores denial again before binding the socket,
  then accepts the trusted Server's commands after Docker starts.

A fixture installation must supply the dedicated group, protected key directory,
bundle at `/opt/verity-egress`, Node 26, nftables, a local rootful Docker daemon,
and the unit/drop-in files together. RuntimeDirectory cleanup removes stale
sockets between service invocations; the application never steals an existing
socket pathname. `LiveRestoreEnabled` and rootless Docker are rejected by the
control entrypoint. Systemd ordering and restart behavior still require full
managed-host integration evidence before these templates may be installed.

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
