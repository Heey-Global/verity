# ADR 0017 — Docker Policy Gateway

**Status:** Proposed · **Date:** 2026-09-14

## Context

The self-hosted Verity Server provisions sibling containers through the host
Docker daemon. The reference deployment mounts the daemon's Unix socket into
the Server. Possession of that socket is host-root-equivalent: Docker permits
its client to create a privileged container or mount arbitrary host paths.

[ADR 0003](0003-runner-image-and-deployable-packaging.md) retained the mounted
socket as the simple default and described `tecnativa/docker-socket-proxy` as an
opt-in hardening measure. That proxy authorizes coarse Docker API families. It
does not inspect the resource identity or body of an allowed request. Verity
must use `POST /containers/create` and container exec, so an endpoint allowlist
still lets a compromised Server create a container with hostile mounts or exec
in an unrelated container. It reduces unused API surface, but it is not a
meaningful boundary for the host-root threat.

The design has also moved since ADR 0003. Brokered Secret Jobs use an
authenticated Docker attach channel over a local Unix socket. The worker is
networkless, and the Server intentionally rejects an HTTP Docker base URL for
this path. Switching to the generic TCP proxy would therefore disable Secret
Jobs. Project relays, per-project networks, devcontainer builds, garbage
collection, and managed updates also need resource-aware policy rather than a
growing list of globally enabled Docker endpoints.

## Decision

Verity will not present a generic endpoint-filtering Docker socket proxy as a
supported security boundary. A hardened deployment requires a Verity-specific
**Docker Policy Gateway** that understands both the requested operation and the
resource it targets.

The raw Unix-socket deployment remains the supported reference topology until
the gateway and its migration checks are implemented. This is an explicit
temporary trust decision, not a claim that the Server is isolated from the
host.

### D1 — Local Unix-socket interface

The Server connects to the gateway through a Unix socket on a private named
volume. The gateway alone mounts the host Docker socket. Neither socket is
published on a TCP port.

Keeping a Unix transport preserves the Secret Job attach invariant. The gateway
must proxy Docker's HTTP upgrade/hijack semantics without terminating or
reinterpreting the framed Secret Job protocol.

### D2 — Deny by default and validate request bodies

The gateway denies every Docker operation without an explicit Verity policy.
Path and method filtering is insufficient. Container creation validates the
complete decoded request before it reaches Docker, including:

- an immutable allowlisted image or a Verity-owned locally built image;
- the expected unprivileged user, dropped capabilities, `no-new-privileges`,
  resource limits, runtime, and read-only settings for the workload class;
- mounts from an exact workload-specific allowlist, with fixed targets, modes,
  and volume subpaths;
- no privileged mode, host namespaces, devices, arbitrary socket mounts, or
  additional capabilities;
- only Verity-owned networks and expected port bindings; and
- reserved labels whose values derive from gateway-held authority rather than
  being trusted because the caller supplied them.

Exec is body-validated the same way, not merely target-scoped: `User`,
`Privileged`, `Env`, and `Cmd` in exec creation are checked against the target's
workload class. A privileged exec, or a root exec where the class forbids it,
undoes the container hardening D2 just enforced at creation, so target ownership
alone (D3) is not sufficient authorization for exec.

Unknown fields, unsupported Docker API versions, ambiguous encodings, duplicate
JSON keys, and policy/schema drift fail closed.

For every non-hijacked request the gateway parses once, validates the canonical
form, and re-serializes what it sends to Docker; it never forwards the caller's
original bytes. This removes the request-smuggling class (path traversal inside
versioned paths, chunked-encoding tricks, parser disagreement between gateway
and daemon) wholesale instead of enumerating its instances. Only a stream the
policy has already approved for hijack is spliced through unmodified.

### D3 — Resource ownership, not caller-supplied labels

Mutating and sensitive operations apply only to resources the gateway knows
Verity created under the matching deployment. The gateway records or can
cryptographically verify creation provenance. A label on a foreign container
is not sufficient proof of ownership.

This covers inspect where it exposes sensitive configuration, start, stop,
wait, remove, rename, attach, logs, and exec. Exec and attach also bind to the
expected workload class. Verity may not exec into the database, gateway,
Updater, another Compose service, or an unrelated host container.

### D4 — Separate workload policies

The gateway uses versioned policies for at least:

- project Sandboxes and their relay/network topology;
- devcontainer build helpers and resulting images;
- one-shot Secret Job workers and authenticated attach;
- image pulls and Verity-owned image cleanup;
- Verity-owned volume enumeration and garbage collection; and
- managed update operations, if they remain on this daemon boundary.

Adding a Docker operation is a reviewed policy change with a regression test,
not an environment flag that globally opens an API family.

### D5 — Builds and daemon-wide operations need explicit treatment

Docker builds can request powerful behavior and consume host resources. The
implementation must define whether builds use BuildKit with a separate
restricted worker, which entitlements and contexts are allowed, and how output
becomes a Verity-owned image. Generic `BUILD=1` is not an accepted policy.
BuildKit's session channel (`/session`, `/grpc`) is named explicitly: it is a
hijacked gRPC stream with file access to the build context — exec-grade
authority in build clothing — and stays denied until that build-worker design
exists.

Daemon-wide inspection, network administration, volume listing, prune, and
image deletion remain denied unless a narrower resource-owned form is defined.
Where Docker exposes no safe resource-scoped primitive, Verity must redesign
the operation or state the residual risk explicitly.

### D6 — Observable denial and compatibility

Every denial produces a stable policy reason suitable for diagnostics without
logging secrets or complete container specifications. Gateway and Server
advertise a policy protocol/version and refuse incompatible combinations.

The Server is not the gateway's only client, and policy compatibility is
defined against all of them. Today the deployable reaches Docker through the
internal HTTP client (`packages/server/src/docker.ts`), the official `docker`
CLI (`project-runtime.ts` runs agent turns via `docker exec`;
`devcontainer-lifecycle.ts` likewise), and the `@devcontainers/cli` build path
— each with its own wire behavior (`/_ping`, version negotiation, exec
create/start/resize/inspect, hijack framing). The implementation enumerates
every Docker client shipped in the deployable, pins its version, and carries a
per-client wire-level regression test; D2's unknown-field fail-closed rule is
evaluated against those pinned clients, so a client upgrade is a reviewed
policy change rather than a silent source of new denials.

Health checks cover the gateway and its Docker connection. Failure is
fail-closed and never causes fallback to the raw socket.

### D7 — Migration is gated by end-to-end tests

The reference deployment may switch only after automated tests cover:

1. fresh install, pairing, and Server restart;
2. Sandbox creation, agent execution, attach, stop, and removal;
3. custom devcontainer build and cache reuse;
4. project relay and network creation;
5. Secret Job start, attach, cancellation, recovery, and cleanup;
6. image and volume garbage collection;
7. managed update, rollback, and generation handoff where applicable;
8. rejection of privileged containers, hostile host mounts, foreign-container
   operations, label spoofing, and unsupported requests;
9. gateway loss and restart without raw-socket fallback; and
10. adoption of pre-gateway resources: after cutover on an existing
    deployment, previously created sandboxes, volumes, and networks are
    inventoried and either owned or explicitly orphaned — GC still collects
    the adopted set, and nothing outside the inventory is blessed.

Cutover on an existing deployment includes that adoption step as a first-class
migration phase: every resource D3 will later gate must acquire a provenance
record from a host-side inventory taken while the operator still owns the raw
socket, because after cutover the gateway has no authority of its own to decide
which pre-existing containers were Verity's. Skipping it fails one of two ways
— denied garbage collection on legacy volumes, or an adoption pass generous
enough to claim a foreign container — and both are cutover bugs, not runtime
policy decisions.

The installer verifies topology and policy version before cutover. No running
Server may receive both the gateway socket and raw Docker socket.

### D8 — The gateway hardens itself

Once deployed, the gateway is the most valuable target on the host: it parses
hostile input from a possibly compromised Server and is the one component
holding the daemon socket. It therefore runs with the discipline it enforces —
minimal image, read-only root filesystem, `no-new-privileges`, dropped
capabilities, and no network besides its two Unix sockets. Its strict parser
(the one D2's duplicate-key and unknown-field rules require, which standard
JSON parsers cannot provide) is fuzzed as a release gate, not once during
development. A gateway that fails these checks is a build failure, because a
parser bug here converts back into the raw-socket trust this ADR exists to
remove.

## Non-goals and residual risk

- The gateway does not make Docker or the kernel a multi-tenant boundary.
- Code in a permitted Sandbox retains that Sandbox's declared authority.
- A policy bug can still grant host-impacting authority.
- On the managed topology the Updater keeps the raw daemon socket and runs as
  root: after the Server's cutover, one host-root-equivalent component remains
  until managed update authority is modeled under D4 and passes D7. The
  gateway narrows the Server, not the deployment, until that happens.
- This ADR does not activate the gateway. Implementation and default cutover
  are separate changes guarded by D7.

## Consequences

- The generic `tecnativa/docker-socket-proxy` example is retired as a supported
  hardening option.
- The eventual reference stack gains another service and policy/version
  lifecycle, trading simplicity for enforceable reduction in Docker authority.
- Until implementation, documentation states that the mounted socket makes a
  Server compromise equivalent to a host compromise.

## Relationship to prior decisions

- This ADR supersedes ADR 0003 R2 only where R2 characterizes the generic proxy
  as a hardened boundary. Its mounted-socket default remains operationally
  current.
- It preserves ADR 0009 D3/D5/D9's Secret Job isolation and authenticated
  attach requirements.
- It does not change ADR 0008's managed-update authority; implementation must
  model that authority explicitly under D4 and D7.
