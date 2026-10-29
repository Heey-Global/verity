# Host-owned project egress adapter

Status: adapter implementation and disposable CI validation; not wired into
production provisioning, no protected-mode activation or boot-time guarantee.

`packages/server/src/project-egress-fence.ts` owns generation-specific nftables
tables in the host namespace. It is not a sandbox-facing HTTP/Unix API. Callers
must be trusted lifecycle code with the durable project/generation binding and
current policy. A project never receives the Docker socket, nft executable
capability or adapter control channel.

The adapter verifies the exact container, network and endpoint IDs, explicit
bridge name and IPv4/IPv6 addresses using trusted Docker inspection. Each new
generation requires a fresh bridge. Retiring a generation preserves its deny-only
tables; stale refreshes and bridge reuse are rejected. Cleanup of retired bridges
and tables is a separate trusted lifecycle operation, not an implicit opening.

Every refresh first atomically replaces the old grants with denial. It checks
current authority and attachment, classifies the destination, resolves only
explicitly granted hostnames, rejects nonpublic/transition addresses and invokes
the host/project exclusion check. It rechecks attachment and current authority
immediately before installing leases. Each kernel lease is bounded by both grant
expiry and one second, so controller death cannot leave permanent permission.
Failed resolution, classification or inspection leaves access denied. The host
executor invokes a fixed nft binary without a shell and has a one-second timeout.

The dependency callbacks are enforcement prerequisites, not optional defaults:
`directTargetAllowed` must reject mandatory-broker/system overlap;
`destinationAllowed` must reject host and all project networks even if public
ranges were configured; `policyCurrent` must recheck the durable revision,
generation and sponsor authority; the resolver belongs to the trusted host.
No production provider for these dependencies is enabled by this increment.

Forwarded IP traffic has source guards and exact destination/protocol/port
matches. Host input is denied except IPv6 neighbor discovery. A separate bridge
forward hook denies same-bridge traffic, including the relay path until its later
operation-constrained integration. There is no established-connection exception.
See the [nftables bridge documentation](https://wiki.nftables.org/wiki-nftables/index.php/Bridge_filtering)
and [nftables manual](https://www.netfilter.org/projects/nftables/manpage.html).

## Evidence and remaining gates

The dedicated `project-egress` workflow bundles the actual TypeScript adapter,
then runs it in the existing disposable privileged DinD host. Two unprivileged
gVisor project containers send markers to independent receivers; synthetic public
addresses exist only inside this isolated host. Controls cover dual-stack TCP/UDP,
A-only admission, B denial, lease expiry, explicit revocation and same-bridge
receipt/denial. Deleting the actual tables must restore receipt, detecting a
fixture whose network is broken independently of the tested fence. Admission probes run after acknowledged renewal, avoiding the intentional
deny-first gap. Positive controls allow up to five attempts; negative controls
never retry away an observed receipt. Expiry and revocation probes do not renew
leases. This is reachability evidence,
not a loss-free availability guarantee.

`adapter-result.json`, receiver logs and the host ruleset form its evidence. This
smoke observes fresh connections after expiry/revoke; it does not yet prove the
two-second closure bound for retained sockets or continuous startup isolation.
The existing reduced 184-case experiment remains a separate regression baseline.

Production integration must install a deny-only boundary before any untrusted
process starts, restore denial before dockerd restart policies run, and provide
authenticated host control, generation lifecycle cleanup, controlled DNS and
server-originated/broker route enforcement. Docker attachment inspection alone
cannot be used as a pre-start gate when endpoints are assigned only on start.
Until these gates and real Runner/relay tests pass, protected mode is unavailable.
