# Project egress CI experiment

This is a disposable runtime feasibility experiment, not a production firewall,
package broker, consent API or deployment. Run it only through the dedicated
[workflow](../../../.github/workflows/project-egress.yml) on a disposable GitHub
Actions runner. It reuses the checksum-verified runtime image from
[`deploy/gvisor-ci.Dockerfile`](../../../deploy/gvisor-ci.Dockerfile).

## Boundary under test

```text
Disposable privileged Docker host (controller, nftables, conntrack)
  pe-a bridge ── project A / runsc-project / volume A
  pe-b bridge ── project B / runsc-project / volume B
  pe-r bridge ── synthetic receiver and second destination / runc
  host input  ── synthetic gateway receiver
```

Projects have the same numeric UID, different volumes and network attachments,
no added capabilities and no Docker socket, host PID namespace, controller files
or evidence mount. Both remain running during the A/B tests. Interface and fixed
source-address bindings determine identity; request labels have no authority.

An nftables table in the outer daemon network namespace filters project traffic
before Docker's forwarding chains. All three disposable bridges use
`gateway_mode_ipv4=nat-unprotected` and `gateway_mode_ipv6=nat-unprotected`
with masquerading disabled: Docker's default raw ingress drops would otherwise
block the positive path before the experimental fence. Separate forwarding accepts deliberately make
the receiver reachable when policy permits it: Docker bridge isolation alone
cannot produce a false success. The input hook also filters gateway access.
IPv6 neighbor discovery is narrowly exempted to keep the link usable.

The test controller refreshes exact interface/destination/protocol/port grants
with a one-second **kernel** timeout. It never installs an established-connection
bypass. Explicit revocation clears the sets and conntrack entries. New grants also
invalidate previous connection tracking; TCP loose tracking is disabled so old
buffered streams cannot revive on a later grant. This is a test mechanism, not a
production choice of firewall technology or grant lifetime.

On every daemon boot, `host-entrypoint.sh` installs an empty fence **before**
Docker starts restart-policy containers. The test kills the policy process,
lets a lease expire normally, restarts a project, and restarts the entire outer
Docker container/daemon. Project restart is mediated by the trusted harness,
which revokes before restart; unexpected project replacement outside that
supervisor is not certified. The two-second closure criterion applies to each existing TCP/UDP socket under
IPv4/IPv6. A single command submits all four probes; the final receiver snapshot
provides a conservative elapsed-time upper bound for each, including command
and observation overhead. It is a test bound,
not a production latency promise or an exact measurement of the kernel transition.

## Required evidence

`verify.py` owns the required case manifest. Missing IPv6, QUIC, controls, runtime
attestation, cases or mutation evidence fails the result; no runtime case may be
skipped. An unavailable Docker embedded resolver therefore fails its required
positive control; it is not counted as proof of the fence. Cases include:

- IPv4/IPv6 TCP, UDP, DNS over UDP/TCP and actual QUIC streams, with positive
  controls for both projects and both receiver destinations.
- A allowed, A at a second destination denied, B at either destination denied,
  then B explicitly granted and revoked.
- Shell and synthetic installation-hook children, forged project labels,
  redirects and a DNS answer changing the target to the second destination.
- Docker embedded DNS access with a granted positive control through the same
  `127.0.0.11` resolver, gateway input, synthetic metadata/foreign-project
  addresses, private volume/socket checks and PID 1 visibility. Metadata and
  foreign-project network tests temporarily DNAT synthetic addresses to the
  controlled receiver, with a working positive control; they never contact a
  real metadata service or another user's project.
- Existing TCP/UDP sockets and new attempts after revoke, expiry and controller
  crash, followed by controller, project and actual daemon restarts. B is still
  denied while A obtains a fresh post-restart grant.
- A real firewall-removal mutation, which must deliver the nominally denied
  marker and be rejected, and suppressed positive observation, which must also
  be rejected. Mutation results are kept separately from normal passing cases.

The receiver independently records unique payload markers. Client timeout/error
is never sufficient evidence of a block. All receipts are checked again at the
end, including delayed delivery after a subsequent grant. QUIC uses synthetic
self-signed TLS; it is not inferred from a generic UDP test. The implementation
uses the [aioquic asyncio API](https://aioquic.readthedocs.io/en/latest/asyncio.html).

Artifacts include the resolved image IDs/digests, pinned runtime version and
binary checksum, sanitized launch profiles, firewall snapshots, daemon/controller
logs, receiver JSONL and `result.json`/`verification.json`. No real credentials or
provider data are used. Fixture image building downloads test dependencies before
the experiment; the actual probes contact only synthetic destinations.

## Local verification

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover \
  -s scripts/probes/project-egress -p 'test_*.py' -v
bash -n scripts/probes/project-egress/ci.sh
sh -n scripts/probes/project-egress/host-entrypoint.sh
sh -n scripts/probes/project-egress/install.sh
```

The unit suite runs without Docker. Install `aioquic==1.3.0` in a disposable Python
virtual environment to include its loopback QUIC check; without it that **unit**
check is explicitly skipped. The runtime fixture installs aioquic and its QUIC
cases are mandatory. Local tests exercise receiver, lease-controller and evaluator
failure paths, not external packet filtering or gVisor.

For a retained runtime result:

```sh
python3 scripts/probes/project-egress/verify.py /path/to/result.json
```

The CI launcher requires GitHub Actions, an isolated privileged Docker fixture and
sufficient available memory; it ignores inherited Docker/builder configuration.
It limits the outer fixture to one CPU and at most 3 GiB, with per-container caps,
bounded commands and a job timeout. Cleanup removes only its own host container,
anonymous daemon volume and tagged images. The workflow has read-only repository
permissions, no secrets and no production-daemon access. It runs on matching PR
changes or a manual workflow dispatch; merely creating the local files runs no CI.

## Production differences and limits

The reference launcher is
[`packages/server/src/provisioner.ts`](../../../packages/server/src/provisioner.ts),
particularly `RUNNER_BROKER_CAPABILITIES` and the container create specification.
The existing runtime smoke is
[`deploy/bin/verity-gvisor-smoke`](../../../deploy/bin/verity-gvisor-smoke).

| Aspect            | Experiment                                                                        | Production comparison                                                                                                     |
| ----------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Runtime           | Pinned `runsc-project`, systrap, sandbox networking, host UDS creation            | Same registered runtime arguments, verified against `versions.env`                                                        |
| User/capabilities | UID 65532; drop all capabilities                                                  | Real Runner supervisor may add CHOWN, SETUID, SETGID, KILL and SETPCAP; this fixture does not certify that larger profile |
| Networks          | Dedicated dual-stack bridges and external receiver                                | Real project relay/DNS, connector and preview topology is not reproduced                                                  |
| Mounts/processes  | One private volume per project; minimal Python PID 1                              | Real homes, worktrees, Runner sockets and supervisor are not reproduced                                                   |
| Lifecycle         | Trusted harness revokes before project restart; daemon boot restores empty policy | Production generation binding, provisioning and restart integration still required                                        |
| Grants            | Fixed synthetic IPs/ports and one-second renewable kernel leases                  | No domain canonicalization, user approval, durable policy store or real provider authorization                            |
| Packages          | Synthetic lifecycle-hook child                                                    | No real npm/pip/other registry adapter or installation support claim                                                      |

The earlier [session experiment](../../../docs/session-egress-experiment.md) and
its inherited/transferred-descriptor demonstrations remain unchanged. They were
intentional capability injections, not demonstrated theft. This fixture verifies
private mount/socket visibility and launch configuration; it does not reproduce a
production supervisor handing an already connected socket into a project. That
handoff and all real shared IPC paths remain integration gates.

A successful CI run supports this specific reduced project-boundary prototype.
It does not authorize enabling protected egress, declare the real Launcher secure,
or implement the [routing contract](../../../docs/project-egress-routing.md).
