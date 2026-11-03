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
the registry or Docker. Both preflight and cleanup share the controller lock. The daemon preflight waits
up to 15 seconds for crash-triggered controller teardown (bounded by its
10-second stop timeout); lock timeout prevents daemon startup.
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

## Explicit offline installation candidate

`scripts/project-egress-install.py` is an **experimental installation candidate**,
not a supported production installer or permission to deploy. It does not install
packages, download binaries, change Docker runtime configuration, provision
credentials, change the application toggle, or claim native-host acceptance.
The existing disposable boot fixture remains the source of native lifecycle
proof; fake filesystem/command tests establish orchestration only.

Prepare a reviewed offline asset directory containing the bundled
`project-egress-host-main.mjs` (built with
`node scripts/build-project-egress-host.mjs`), `project-egress-deadline.py`,
target-host compiled `project-egress-deadline.bpf.o` and
`project-egress-renew.bpf.o`, and the three unit/drop-in files from `deploy/egress`.
Compile the BPF sources using the validated target architecture and kernel
headers, following the disposable native fixture. Do not substitute unreviewed
objects or copy binaries from an incompatible host. Then stage a transfer bundle:

```sh
python3 scripts/project-egress-install.py stage /path/to/reviewed-assets /path/to/new-release
```

The manifest detects transfer corruption, not a malicious release publisher.
Verify the release and installer provenance through the same reviewed delivery
channel. The staging command copies only the fixed asset set and refuses an
existing destination. The install command verifies every asset digest before
host mutation. Installed release files and directories are read-only, with
root ownership and symlink checks; replacement files and directory entries are
fsynced before proceeding. Previous release content is checked against its
content-addressed identity before it can become a rollback target. Native crash
recovery is still a separate acceptance gate.

Before installation, provision the dedicated `verity-egress-control` group and
review the Server's membership, control-directory bind mount, and matching control
key configuration. Root-owned mode-0600 regular files
`/etc/verity-egress/control.key`, `authority.json`, and `relay.json` must already
exist; the authority and relay schemas are defined by the host implementation.
Enable packet enforcement in the relay configuration. Do not paste credentials
into a command line or public deployment document. Establish persistent bpffs
mounting and creation of the root-owned mode-0700
`/sys/fs/bpf/verity_egress_deadline` directory at boot. The candidate does not
modify fstab, service users, Docker daemon settings, or Server mounts.

On the separately authorized target Linux host, use the read-only preflight:

```sh
sudo python3 project-egress-install.py preflight
```

It accepts only x86_64 little-endian Linux and requires systemd >=249 as PID 1,
Node >=26.12.1 within 26.x, rootful local
Docker 29.9.2 with live restore disabled, the reviewed `runsc-project` and
`runsc-relay` runtimes, required network/BPF utilities, Python `setns`, libnftables,
the private pin directory, and trusted configuration paths. Runtime names do not
attest their executable versions or runtime arguments; those remain a release
and native-host validation obligation. A successful preflight does not prove
boot persistence, kernel BPF compatibility, socket reachability from the Server,
or receiver-side isolation. The candidate has no accepted target-kernel profile
yet: exact kernel compatibility remains unaccepted until native-host evidence
identifies and verifies that kernel, compiled BPF objects and gVisor release
together. The architecture gate does not imply that every x86_64 Linux kernel
is supported.

After the separate installation approval, the explicit command is:

```sh
sudo python3 project-egress-install.py apply /path/to/new-release --experimental-host-install
```

Installation stops Docker and the existing controller, restores denial under the
released controller lock, atomically switches the managed bundle link, installs boot units,
reloads systemd, and starts the bootstrap, Docker and controller. Stopping Docker
prevents its `Upholds` dependency from restarting old controller code during the
update. A missing controller unit is expected on initial installation and is
not stopped. The controller's `Type=notify` startup owns readiness; the command also requires
its active state. **This operation restarts Docker and interrupts all Docker
workloads on the host**, including projects without protection; it requires an
approved maintenance window. The candidate
refuses a preexisting unmanaged `/opt/verity-egress` directory; migration from a
fixture install requires its own reviewed procedure.

A failed startup restores the previous bundle link and unit bytes only after
stopping the new controller and restoring denial. It leaves Docker and the controller
stopped and never restores unrestricted traffic. If containment itself fails,
the command stops without claiming rollback safety. Investigate the failure on
the host; after approval, reapply a previously verified staged release through
the same command. Retained release files do not authorize garbage collection,
removal of fence rules, or deletion of registry/BPF state. Uninstalling protection
requires a separate container migration and deactivation procedure; removing
units alone is not a safe uninstall.

Before enabling protection for real projects, record successful final-commit
native boot/restart/outage and revocation evidence, verify the Server reports the
host available, and separately approve activation. Re-run the application-path
positive controls after installation, including package download and managed
HTTP/WebSocket previews. Neither this candidate nor its unit tests closes these
gates.

## Preview ingress limitation

Protected generations currently have **no supported preview ingress route**.
The existing local/public connector joins the legacy project network; attaching
it to a protected network or adding a broad firewall exception would bypass the
attested boundary. Local HTTP/WebSocket previews and static-folder shares are
therefore unavailable for protected containers. Creation returns a descriptive
409 conflict before creating an edge or connector. Managed dev servers may still
run inside the container; their local-access detail explains this limitation.

When reconciliation observes that an existing target moved to a protected
network, it revokes the public edge or closes the local edge and removes the
connector. Dormant local share intent is revoked instead of being restored onto
the legacy network. This applies to static-folder connectors as well, whose
read-only filesystem mounts must not become an independent data path around the
protected generation. Ordinary project/session ownership and generation checks
continue to apply to supported, unprotected previews.

These unit and lifecycle guards establish fail-closed behavior, not protected
HTTP/WebSocket connectivity or a measured revocation deadline on a real host.
Supporting protected previews requires a narrow, attested ingress adapter bound
to project, generation and the authorized target port, with stream teardown and
receiver-side tests for cross-project access, generation retirement and restart.
No direct grant or DNS approval creates that ingress route.
