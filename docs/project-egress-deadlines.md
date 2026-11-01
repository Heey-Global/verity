# Experimental packet deadline contract

Status: experimental adapter integration under native verification. No production
installation or activation. Passing primitive probes do not certify the complete
adapter or the retained-flow and stopped-executor acceptance matrix.

A temporary direct-network grant carries two independent limits: its absolute
authority expiry and at most 1000 ms of controller lifetime. The trusted host
captures wall-clock and suspend-aware BOOTTIME values before any asynchronous
admission work. The resulting deadlines are immutable: commit latency consumes
the remaining budget instead of starting a new relative timeout. Expired input
must remain ineffective even when a stalled executor subsequently commits it.

Authority is scoped to the existing project, generation, container/network
attachment, policy revision and host boot identity. Sandbox labels, supplied
timestamps and source headers are not authority. Reboot, replaced generations
and reconstruction begin denied; cached grants cannot restore access. A fresh
authorized decision is required to renew permission. No new kind of destination
or route is authorized by this work.

Each admitted data packet must pass both the exact destination/identity rules
and the kernel deadline checks, in both directions. Return traffic and
established conntrack state confer no independent permission. Re-admission must
not revive a previous flow. A forward clock step must not be undone by a later
backward step to revive a permission already observed expired. Expiry accounting
must include actual guest suspend; process timers, garbage collection, relative
nftables timeout cleanup and a resume-time userspace callback are insufficient.

The candidate implementation combines an absolute nftables wall-time predicate
with a TC eBPF BOOTTIME gate. Both software hooks must be attested before
admission. A missing guard, incompatible kernel, hardware/flow offload bypass,
changed interface or failure to initialize denied state prevents admission;
there is no less restrictive fallback. Existing bounded relay service paths
retain their own authority semantics rather than acquiring implicit direct grants.

The direct-grant adapter requires the root-owned Python helper and its compiled
TC program under `/opt/verity-egress`, a private bpffs pin directory and a
rootful x86_64 Docker host. The helper inspects the actual endpoint and veth,
attests both software hooks and refuses nftables flow offload. It stores the
capture high-water mark before arming, rejects replay and invalidates captures
made before revocation. Errors while preserving expiry evidence leave the
generation unusable; recovery requires a fresh generation, not a weaker guard.

Each refresh captures its immutable lease before DNS or executor work. Both
directions also require exact nftables target tuples and the current admission's
fresh 128-bit conntrack label. Only an unlabelled initial TCP SYN or unlabelled
new UDP flow may acquire that label. An existing label is never rewritten on
renewal. This does not make a UDP socket identity stronger than conntrack's flow
identity after its entry is destroyed.

Overlapping grants conservatively share the earliest absolute authority expiry
for the current admission, while each represented temporary expiry receives its
own persistent BOOTTIME mapping and kernel tombstones. Both directions latch
all represented expired authorities before any earlier-expiry drop. Tombstones
use the fixed project address, so multiple destinations cannot exhaust their
single identity slot or evade a previously observed expiry.
nftables date syntax rounds that expiry down to a whole UTC second, so access
may close up to one second early. Kernel-observed wall expiry is latched in
expiry-specific dynamic sets in either direction. These sets survive all rule
updates for the entire generation, including writes by packets already past TC
when a refresh began. The helper also persists observed expired timestamps and
refuses later admission with them, even after a backward clock step. The helper
bounds each generation to 1000 distinct authority expiry values; exhaustion
requires a fresh generation. Different grants sharing an expiry
are conservatively denied together. Missing or unreadable tombstones prevent
admission. This direct-grant guard is not installed on the separate permanent
relay service paths by this increment.

The first BOOTTIME mapping of every represented absolute authority expiry is retained
for the generation and can only decrease. Renewing a controller lease after
wall-clock rollback cannot move that original authority budget into the future,
including quiet intervals with no expiry packet. A request exceeding the saved
budget is rejected rather than rewritten at commit.

The disposable pause probes stop the actual Node controller and run the unchanged
helper with a Python trace that stops immediately before its positive map write.
A separate process records `/proc` state `T`, requires a live lease at stop, waits
at least two seconds beyond capture, and resumes after the immutable deadline.
These tracing and signal helpers are fixture-only and are not host-helper API
options. The independent verifier requires raw map observations and fresh
receiver controls after both recoveries.

Acceptance distinguishes the kernel decision timestamp from external receipt:
no packet may be admitted after its applicable deadline, while independently
observed closure must meet the existing two-second bound. Buffered data and
transport delay are reported separately from enforcement and recovery. Positive
controls must cross the installed guards before each negative scenario, and
removed checks must produce an observable failure. Actual Controller/Executor
pause, delayed commit, guest suspend, VM pause, wall-clock changes, both traffic
directions and retained-flow renewal need runtime evidence before this contract
can be claimed implemented.

The existing native boot proof remains a separate regression baseline. General
transport/package/UI work, other attack surfaces and production activation stay
outside this increment.

## Experimental relay packet class

The TC program also contains an independently classified relay path to support
future composition on a shared project veth. Its `relay_transport` array starts
disabled. The experimental host service selects trusted configuration only when
its root-owned relay policy explicitly sets `packetEnforcement: true`. Production
installation and activation remain disabled.

When configured by trusted host code, the class must still match the guard's
registered interface index, exact Sandbox/relay IPv4 and MAC pair, and TCP service
port 8080 or 8443 (8444 only under the explicit Codex flag). The reverse direction
matches the service source port. Only the same pair's well-formed ARP requests and
replies receive the neighbour-discovery exception. VLANs, IPv6, UDP, IP options,
fragmented packets and other ports receive no relay exception. Existing nftables
interface, MAC, service and fresh conntrack-label rules remain mandatory; a TC
classification alone never authorizes a packet through those rules.

Relay admissions have their own `relay_observations` counters. The existing
deadline observations continue to measure direct-class admission, so permitted
relay traffic cannot conceal post-expiry direct traffic in acceptance evidence.
Unprivileged tests compile and execute the actual C matcher with constructed
frames. These tests do not establish BPF verifier acceptance, native packet-path
coverage or production readiness. Trusted map configuration, lifecycle clearing,
combined nftables rules and independent native controls are still required before
the relay exception may be selected.

The disposable KVM job also runs the relay packet matrix through
`BPF_PROG_TEST_RUN` against the compiled, verifier-loaded TC program. It uses
a zero direct lease, checks both directions and the interface/reserved binding,
and clears the synthetic relay policy after each case. `relay-kernel.txt` retains
the matrix result, including failures. This proves kernel program execution when
the job succeeds; it does not prove end-to-end relay delivery or install trusted
relay policy on a supported host.

### Experimental host relay configuration

The uninstalled root-only deadline helper accepts `configure-relay` with a
registered relay container ID, endpoint ID and Boolean Codex flag. It accepts no
caller-selected addresses or MACs. The trusted host must validate the relay's role,
image and mounts before registering these IDs; Docker labels are not authority.
The helper derives both endpoints from the daemon, requires exactly that pair on
the project network, checks both namespace/veth attachments and bridge membership,
and verifies network/container address and MAC agreement. The binary policy is
bound to the original generation and endpoints; changing either identity, address,
MAC or the Codex flag requires a fresh generation.

Configuration clears the relay map before inspection, attests the TC hooks, saves
the immutable registration, installs the policy, and repeats inspection and
attestation. A failed post-install check clears the map. `clear-relay` explicitly
disables the system exception while retaining its immutable registration.
Generation `prepare` clears it as well. Direct `revoke` preserves the system class;
subsequent direct admission rechecks its registered endpoints and clears the relay
map if they changed or attestation fails. Map-write failures are fatal and must
prevent the lifecycle owner from claiming successful configuration or revocation.

The KVM packet fixture uses the host map writer, including its disabled encoding.
Host configuration tests mock daemon and kernel responses; they do not certify
actual Docker/TC composition. Production installation remains disabled. The opt-in experimental host lifecycle
now composes the helper operations with startup, relay and direct nftables rules;
complete supported-host acceptance remains a separate gate.

The kernel test API initializes protocol metadata before invoking TC. Synthetic
inputs shorter than an Ethernet plus base IPv4 header are therefore zero-padded
to 34 bytes. The ordinary C matrix still exercises the exact short lengths; the
kernel matrix's sub-34-byte cases cover padded malformed inputs, not actual short
skbs. API failures remain errors and are never counted as classifier denials.

### Opt-in host lifecycle composition

`/etc/verity-egress/relay.json` may explicitly select `packetEnforcement: true`.
This is an experimental host selection, not an installer default or a project
request field. The host verifies the registered relay role, image and mounts,
then derives both endpoint identities from Docker. Under the existing startup
fence it prepares the denied TC guard and direct nftables chains, installs the
exact relay exception, repeats inspection and only then acknowledges connected
readiness. A failed configuration leaves the generation denied; failure to
restore denial also attempts to stop its containers.

The startup tables provide a corridor for the bound sandbox's routed IPv4/IPv6
addresses only after its direct fence exists. `return` continues through the
later direct fence; it does not authorize a destination. Same-bridge forwarding
still permits only the inspected relay pair and ports. Gateway neighbour discovery
is bounded to the inspected sandbox identity and gateway addresses. The direct
fence preserves that same relay exception before evaluating direct expiry and
target tuples. A direct revoke does not clear the relay class; prepare, retirement
and shutdown close both paths.

Optional `/etc/verity-egress/authority.json` supplies `databaseUrl`, explicit
`dnsServers`, a reviewed `directHosts` route inventory and `projectSponsors`
(project ID to sponsor user ID). Both configuration files must be root-owned,
private regular files with trusted ancestors and no symlink traversal. The
route inventory must contain only destinations classified as direct: broker,
model/control and other mandatory mediated routes are not direct destinations.
Unclassified hosts remain unavailable. This bounded inventory does not replace
the remaining transport-adapter integration work.

The host reads the authoritative PostgreSQL egress policy and rechecks sponsor
execute permission and policy revision around admission. Control requests accept
only project and generation references, never grants, addresses, revisions or
sponsor overrides. Missing authority configuration or sponsorship cannot open
direct access. Destination inspection excludes host interface addresses and all
Docker network subnets, including publicly addressed project networks.

After a connected acknowledgement with direct authority, the Server lifecycle
refreshes sequentially, waiting 250 ms after each completed refresh; the kernel
lease still lasts at most 1000 ms from its original clock capture. Refresh errors
stop renewal and attempt direct revocation. Prepare, retirement and Server close
cancel renewal; the host does not renew on behalf of a lost Server. Renewal does
not revive expired connection epochs or extend temporary grant budgets. Unchanged
policy and resolved tuples retain their conntrack label only when a host-only
BPF test-run program confirms that the previous kernel lease is still live.
The handoff compares the expected deadline and interface in the kernel before
updating the lease; a failed handoff closes direct access. Changed targets,
revocation and expired leases require a fresh connection epoch. The lease is
also capped by the earliest DNS/tuple budget.

Host records bind packet-enforced generations to the host boot ID. Every daemon
pre-start restore retires old packet generations before Docker starts; a new
host boot likewise retires them before readiness. Service-only reconstruction
within one boot retains the binding but starts denied and preserves expiry
state. A stopped sandbox wakes through the existing cold replacement path,
retaining project data while allocating a fresh generation and network. Endpoint
or immutable relay-policy changes require replacement rather than in-place repair.

The experimental service requires a mounted bpffs and an existing root-owned
0700 `/sys/fs/bpf/verity_egress_deadline` directory. Its writable paths include
only that pin subtree and the existing private service state. Deadline evidence
is stored under `/var/lib/verity-egress/deadline`, independently of the control
socket runtime directory, and survives service restarts and host reboot; boot-ID
checks still require a fresh generation after reboot. Both `project-egress-deadline.bpf.o` and `project-egress-renew.bpf.o`
are required beside the fixed helper. Missing helper/object, unsupported kernel,
missing pins or failed attestation prevent packet-enforced startup. These
requirements do not authorize installation on an existing host.

The disposable Runner/relay fixture now exercises the combined Docker, TC and
nftables path with an independent dual-stack receiver, fresh direct controls,
lease expiry, retained TCP across automatic Server renewal, SIGKILL of the
renewal process, direct revoke and unchanged relay controls.
`composed-proof.py` independently checks receiver receipts, raw TC observations
and sender heartbeat evidence; forged late receipts, missing positive controls
and late kernel admission are rejected by its tests. These checks supplement the
existing controller-reconstruction and generation-replacement fixture. The
disposable boot fixture selects combined TC/nftables enforcement and requires
fresh generation replacement after Docker restart and host reboot. Acceptance
requires successful raw-evidence verification on the current runtime pin;
legacy startup-fence results alone do not satisfy this requirement.

The host controller owns a single root-only Python deadline worker over private
pipes. It accepts bounded, sequential, explicitly requested operations, holds the
trusted state lock per operation, and never renews authority autonomously. A
whole-request watchdog includes queue time; transport failures kill the worker
process group and reject pending and future operations without replay or
automatic replacement. Explicit controller reconstruction is required before
fresh authorization. Linux parent-death
signaling kills the worker with its controller. All authority, endpoint and hook
checks remain fresh, and absolute lease capture still precedes asynchronous
admission work. The compare-and-renew program is prepared against the exact
deadline map while denied, removing its load from the first live handoff.

## Kernel inspection readers

The supported little-endian x86_64 host uses `libnftables.so.1` JSON output for
fixed ruleset/table reads, BPF object-info syscalls for pinned program identity,
and read-only rtnetlink dumps for links and ingress/egress classifiers. The
implementation follows the Linux UAPI layouts in
[`rtnetlink.h`](https://github.com/torvalds/linux/blob/master/include/uapi/linux/rtnetlink.h),
[`if_link.h`](https://github.com/torvalds/linux/blob/master/include/uapi/linux/if_link.h)
and [`pkt_cls.h`](https://github.com/torvalds/linux/blob/master/include/uapi/linux/pkt_cls.h).
Python must provide `os.setns`; disposable image and VM preparation check this
and the library before starting protected fixtures. Missing capabilities fail
closed without a CLI fallback. Provisioning-only loaders remain unchanged.

Each route socket is private to one fresh query. Replies require the kernel
sender, matching sequence/port, complete multipart termination, valid lengths
and supported classifier attributes. Interrupted dumps, offload, unexpected
hooks, duplicate attributes and truncated messages are rejected. Reads allow at
most 2 MiB and 4,096 route records with a one-second socket deadline. Nft output
is capped at 2 MiB and 10,000 entries and rejected after a one-second elapsed
read; the outer helper operation watchdog terminates a stuck library call within
five seconds. These limits never extend a kernel lease.

Namespace inspection opens only the daemon-derived namespace, checks its
network-namespace type, and restores the saved host namespace descriptor on
success or failure. Failed restoration terminates the resident helper. No
inspection facts or namespace descriptors persist across requests.

The previous native baseline, run 41321104315 at c4ad67059, failed continuous
handoff despite the resident Python helper and Docker API reads: approximately
415 ms after the first capture plus the next inspection, validation and failed
453 ms kernel phase exceeded the immutable 1,000 ms lease. Replacing readers
requires new native continuity, failure and combined recovery evidence; local
parser tests alone do not establish acceptance.
