# Managed Network protection provisioning

Network protection is configured through the instance-wide switch under Settings
→ App & Server. Installation and managed updates own host preparation, control
socket/key wiring and configuration. No user-managed environment variables or
host configuration files are part of that workflow. The switch remains off by
default and applies to project containers on their next start; changing it does
not recreate running projects.

## Delivery and trust boundary

The release image contains the bundled host controller, its Node executable,
compiled BPF objects, fixed systemd templates and a checksum manifest under
`/opt/verity-install/egress-release`. The initial installer prepares persistent
control paths before managed startup and finalizes policy after database
migration. A managed update independently verifies the target image signature
using the installed image before admitting the fixed provisioning helper.
Only fixed host destinations are writable. Firewall operations execute in the
host's systemd service context, not the provisioning container's network
namespace. The helper does not receive `NET_ADMIN` or privileged Docker mode.

The host retains its private control key under `/etc/verity-egress`; a separate
server-only projection is readable by the control group. The runtime directory
and key survive ordinary upgrades. The server receives only the runtime and key
projection as read-only directory mounts. Managed deployment authority is
checkpointed before adding these mounts and their internal environment sources,
so active, standby and recovery specs use the same contract.

Relay policy comes from the release's immutable relay image and the deployment's
data volume, UID/GID and fixed broker/model socket subdirectories. The separate
`verity_egress_host` PostgreSQL role receives only connection/schema usage and
SELECT/INSERT/UPDATE on `project_egress_policy`. Configuration generation inspects
the unique running database on the sealed deployment network; it does not publish
a database port or reuse Docker-only DNS names in the host process. A private
locator allows controller startup to refresh that endpoint after database
replacement. Database credentials and resolver configuration remain private.

## Safety and recovery

Preparing a release never changes the app switch or project network membership.
Unsupported hosts stage private assets and publish an unavailable reason without
installing active Docker dependencies or firewall rules. Before activation, the
installer rejects reserved `vep*` interfaces that cannot be attributed to durable
host reservations and inspected Docker networks.

The managed installation path does not stop or restart Docker. Controller
replacement preserves denial, restores the previous release/configuration on
failure and leaves protected traffic fenced until verified recovery. It never
flushes host firewall tables, discards the registry or removes kernel deadline
state as a rollback shortcut. Unprotected projects and unrelated host workloads
must keep their existing connectivity. Existing protected generations can lose
connectivity during controller renewal; successful recovery requires fresh
authenticated admission, not replay of an old grant.

The earlier experimental offline installer remains a separate fixture tool. Its
Docker-stop transaction is not used by automatic provisioning. An installation
created with its `Upholds` dependency requires a separately verified migration;
silently treating it as a managed installation is refused.

## Availability and acceptance boundary

Installed files are not evidence of usable protection. The server authenticates
a read-only health operation and checks protocol and packet enforcement before
enabling the switch. Display status may be cached briefly; enabling uses a fresh
check. Missing keys/sockets, authentication/permission failures, protocol errors,
timeouts and unsupported runtime/install failures have sanitized reason codes.
No raw command output, database URL or control token is returned to the app.
Disabling remains possible during a host-service outage.

**Native production acceptance remains pending.** The accepted native-profile set
is intentionally empty. Consequently staging and wiring alone do not make the
switch available on a production host. Do not populate that set merely to pass
preflight. Accept an exact kernel, Docker, gVisor and BPF artifact combination only
after real host install/update/reboot/crash/daemon-restart/rollback tests, with
independent packet observations and positive controls for protected traffic and
unrelated projects, relays, gateways, previews and runners. Unit tests establish
orchestration and error handling, not kernel isolation or uninterrupted host
connectivity. Supported dependency provisioning and protected application routes
must be verified on that same profile before declaring the switch ready.

Managed direct authority starts closed. After native preflight, the installer
persists a root-owned inventory contract before controller activation. Servers
serialize endpoint mutations with synchronization, but require host fencing only
once that contract exists. Unsupported staging and legacy manual authorities
therefore retain configuration access. The contract survives rollback; a missing
or unreadable contract after it was observed cannot disable synchronization in
that Server process. The installer cannot infer configured
broker/model/MCP destinations from deployment environment variables. The Server
must synchronize bounded endpoint metadata through the authenticated control
protocol before the host can report readiness. Configuration changes must fence
existing direct corridors before persistence; unchanged snapshots renew a bounded
lease without periodically interrupting traffic. Controller restart or stale
synchronization closes readiness. Static installation destinations remain part
of both hostname classification and protected-address resolution. Explicit IP
endpoints are included too. Conservative hostname and observed public-IP history
survives controller restart so cached clients cannot bypass system-destination
classification after an endpoint changes. Malformed endpoint metadata keeps
admission closed; repairing it can require a Server restart to retire cached
clients.

Automatic host package/runtime/bpffs preparation is restricted to exact
release-owned native profiles. See [native profile delivery](project-egress-native-profiles.md).
An empty accepted profile set is a production blocker, not a request for manual
host setup. Package names alone or a matching kernel release cannot establish
acceptance.

Older installed updaters cannot execute provisioning code they do not contain.
Release compatibility parsing/admission first, then require the new provisioning
contract in a subsequent release when necessary. Retain a compatible controller
and its denial state when an older server cannot safely manage protected
generations; a server image downgrade alone is not an egress uninstall.

Related contracts: [host controller](project-egress-host.md),
[packet deadlines](project-egress-deadlines.md),
[enforcement](project-egress-enforcement.md), and
[managed update authority](adr/0008-verity-server-self-update.md).

## Retrofitting installations that crossed the compatibility release

An update from an image without `org.verity.project-egress-deployment=1` cannot
admit the privileged provisioning step. It first installs the compatibility
contract. The next targeted repair update uses that now-installed image to
verify the signed target and admit the bounded helper. Missing admission is not
permission to run the target helper directly. No manual host command is part of
this recovery path.

The updater logs whether provisioning was skipped because the installed image
cannot admit it or because the target does not implement it. Managed servers
without socket wiring report `provisioning_pending`; self-managed servers keep
`not_configured`. This is an outage explanation, never evidence of readiness.
Root-owned installation diagnostics may also explain an in-progress operation,
unsupported runtime, incomplete inventory or controller failure. A successful
provisioning job still requires a fresh authenticated health check before the
switch can be enabled.

On the repair update, provisioning precedes standby creation and sealed socket
and key mount migration. The update does not enable the switch or recreate
project containers. Accepted native profiles and complete destination inventory
remain release prerequisites: this repair does not certify either by itself.
After release and an authorized live update, verify the running release digest,
active host unit, authenticated health, socket, key permissions and read-only
server mounts, then use an isolated project to verify allowed and denied traffic
while observing existing workloads. Preserve independent dual-stack packet
evidence. A passed image smoke test is not this production acceptance.


## Protected relay generations during updates

Host policy accepts the new immutable relay image and at most one retained
immutable image for existing protected generations. Configuration generation
inspects the private host registry and the referenced Docker containers; only
images already admitted by the installed policy may be retained. Socket mounts,
volume, UID/GID and execution restrictions remain exact. After stopping the old
controller and establishing denial, activation re-inspects the registry and
containers before replacing the policy. A relay started after the earlier
configuration snapshot must still retain its admitted image. Unused prior images
are pruned only from this stopped-controller snapshot. An update requiring more than one retained
image, an unknown image or a changed execution contract fails before replacing
controller authority; it must not silently orphan or weaken protected generations.

## Boot recovery and runtime revalidation

Before activation writes its transaction journal, the installer durably installs
an immutable recovery helper and dependencies ordering it before Docker and the
bootstrap fence. Recovery acquires the installation lock and establishes denial
before restoring snapshots. It does not authorize a new runtime, remove state or
flush rules. Controller startup separately revalidates the exact native profile
before refreshing database authority and starting service. Tests of mocked
systemd commands do not establish native boot ordering or packet continuity.

## Installed-updater timeout compatibility

New updaters allow up to 750 seconds for the bounded provisioning container; the
host oneshot has a separate 720-second bound. An already-installed 4.80 updater
still enforces its original 110-second caller limit. Target code cannot expand
that installed limit. If package preparation exceeds it, the update may fail
while its owned host oneshot continues to its own bound and persists its result.
That is a recoverable failure, not completed provisioning or a completed update.
The old-updater repair path must be tested natively, including disconnected
callers and retries, before a release promises one-update completion.
