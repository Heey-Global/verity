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
