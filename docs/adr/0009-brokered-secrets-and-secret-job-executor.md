# ADR 0009 — Brokered Secrets and the Secret Job Executor

**Status:** Proposed · **Date:** 2026-07-17

## Context

Verity currently materializes project Doppler credentials into parts of the project runtime so
existing CLIs can authenticate. This is convenient, but any process in that runtime can read and
reuse those credentials. Expiring a token reduces duration; it does not remove the credential from
the agent's trust domain.

[ADR 0002](0002-credential-and-isolation-architecture.md) established project-scoped credential
bindings and a target credential-broker boundary. [ADR 0006](0006-runner-in-sandbox-extraction.md)
established the **Runner** as the Sandbox-local supervisor for durable agent turns. Git signing
already uses true action brokering, while the GitHub helper currently returns a short-lived,
repo-scoped token to a Sandbox process.

Verity also needs to support changing third-party CLIs that require a credential locally. Building
one specialized broker for every CLI is not practical. Conversely, injecting a secret into an
arbitrary command and filtering its output does not hide that secret from the command: it can encode
the value, write it to a file, or send it over the network.

The detailed design and threat-model discussion live in
[Brokered Secrets](../BROKERED_SECRETS_KONZEPT.md). This ADR records the architectural decisions that
other implementation work may rely on.

## Decision

### D1 — Hybrid execution and on-demand discovery

Commands that require no secret continue to run directly in the project Sandbox. The initial agent
context only advertises the feature. An agent discovers currently authorized aliases through the
non-secret catalog interface and invokes brokered work through a Verity-controlled model tool
outside the Sandbox. User-facing transcripts may render this tool as `verity secrets list` and
`verity secret-run`, but `secret-run` is not an authenticated ordinary Sandbox executable or socket.

Direct Sandbox commands receive neither secret values nor provider credentials. Secret aliases are
non-secret metadata and convey no authority by themselves.

### D2 — Three explicit trust modes

Verity exposes three modes and must display the selected mode in user-facing authorization and audit
surfaces:

- **`trusted`:** a generic command receives the secret. Just-in-time injection and exact-match
  redaction provide secret hygiene, not isolation from that command.
- **`restricted`:** a versioned execution profile binds an immutable executor image, absolute
  executable and digest, typed arguments, sanitized environment, input set, protocol-aware egress,
  resource limits, and a structured result contract. Free shell strings, PATH lookup, workspace
  executables, arbitrary interpreters, plugins, hooks, and opaque agent-readable artifacts are not
  permitted.
- **`action`:** a specialized broker accepts domain parameters and performs the authenticated
  operation without passing a universal credential to an agent-controlled process.

If Verity cannot enforce every required `restricted` binding, the profile is rejected or classified
as `trusted`. High-privilege and recurring workflows should migrate toward `action`.

### D3 — A separate Secret Job Executor

Secret-bearing commands never run inside the Verity Server process or the ADR-0006 Session Runner.
A separately deployable **Secret Job Executor**, outside the project Sandbox, creates one isolated
job instance per call. The term **Runner** remains reserved for the Sandbox-local agent supervisor
defined by ADR 0006.

The Executor:

- has no PostgreSQL, Doppler, or long-lived provider credential;
- shares no mount, PID, IPC, or network namespace with the project Sandbox;
- cannot access the session worktree, Sandbox broker runtime, host sockets, metadata services, or
  sibling jobs;
- uses a pinned image, an unprivileged identity, no extra Linux capabilities, and a job-scoped
  encrypted write layer;
- is destroyed after a terminal state and independently reconciled by a reaper.

The Verity Server remains the control-plane database and lifecycle authority. The Executor is a
distinct, versioned service boundary, even when an initial deployment places both services on the
same host.

### D4 — Three authorization objects

One bearer token must not authorize the entire path. Verity separates:

1. **Project broker capability:** the rotatable binding of a project Sandbox to its server-side
   broker configuration, consistent with ADR 0002's per-project trust domain. It is not a provider
   credential and is not exposed as an ordinary workspace environment variable or file.
2. **Single-use run grant:** a short-lived delegation bound to session ID, request ID, alias and
   profile versions, typed parameters, immutable snapshot ID, approval, audience, expiry, and nonce.
   The broker enforces replay and concurrency controls.
3. **Executor secret envelope:** a one-time encrypted envelope addressed to the authenticated
   workload identity of one job instance.

The request path must not rely only on possession of a Sandbox-readable bearer value. Verity
registers `secret-run` as a native backend tool or an MCP tool whose transport and credentials are
owned by the Verity Runner/tool gateway, not by the agent child or workspace. Repository processes
cannot connect to, invoke, or inherit this tool channel. The gateway binds the backend's structured
tool-call event to the active turn and mints the run grant; descendants of the secret-bearing child
receive no broker capability.

A convenience binary inside the Sandbox may list cached non-secret catalog metadata or print usage,
but it cannot start a secret job. A backend that cannot expose an unforgeable model-tool boundary
does not support Brokered Secrets. Prompt instructions, PATH wrappers, Unix peer credentials shared
with workspace processes, and inherited file descriptors are explicitly insufficient.

### D5 — One-shot secret delivery inside the Executor trust domain

Only after the job instance authenticates does the broker resolve the current provider value and
send the job-bound envelope over a mutually authenticated encrypted channel. Plaintext must not
appear in a container or Pod specification, command line, orchestrator environment, persistent
spool, platform log, trace, or crash report.

The Executor unwraps the value in memory, an anonymous file descriptor, or non-persistent tmpfs and
injects it according to the profile. Core dumps, ptrace, swap, raw runtime logging, and unnecessary
descriptor inheritance are disabled. The value is considered visible to the complete Executor job
trust domain, not only to one process.

### D6 — Immutable snapshots, never a shared writable worktree

A secret job never mounts the session worktree directly. A Sandbox-side Snapshot Exporter produces
an immutable, content-addressed manifest using safe fd-relative traversal. The manifest records the
Git revision, selected uncommitted and untracked changes, deletions, renames, modes, exclusions,
hashes, and size limits.

Only regular files from the allowed worktree mount are accepted. Symlinks, hardlinks, sockets,
devices, mount crossings, broker runtime paths, credentials, VCS metadata, submodules, and LFS
content are denied unless a later version defines a dedicated contract. The Executor verifies the
manifest and content hash, and the run grant binds the snapshot ID.

Secret scanning is defense in depth, not proof that an input snapshot is secret-free.

### D7 — Protocol-aware egress for `restricted`

`restricted` jobs have no general DNS or raw TCP access. Network traffic traverses a fail-closed,
protocol-aware policy proxy. A profile binds scheme or RPC protocol, destination identity, port,
certificate identity, allowed operations, and where necessary request fields.

The proxy blocks direct IP bypasses, private and metadata networks, unauthorized IPv6, redirects,
CONNECT tunnels, and DNS rebinding. If traffic can only be mediated as generic TCP, or an authorized
destination can accept arbitrary agent-controlled payloads, the profile is `trusted`.

### D8 — Redaction precedes every externally visible or persistent channel

The Executor performs byte-oriented, cross-frame exact-match redaction before output can reach the
Server, event store, WebSocket, model backend, logs, traces, crash reports, telemetry, push
notifications, or artifact metadata. Only redacted, sequenced frames leave the Executor trust
domain.

The protocol bounds active secret count, secret length, buffering, output size, and backpressure.
It defines safe flush, truncation, binary-frame, and abort behavior. Exact-match redaction does not
detect encoding, hashing, fragmentation into semantic fields, files, network exfiltration, timing,
or other transformations; product copy must not claim otherwise.

### D9 — Restart-safe, idempotent job lifecycle

Secret jobs reuse the lifecycle semantics of ADR 0006 without sharing its process boundary:

- the Server allocates a stable `jobId` and idempotent `requestId` before start;
- start never creates a second job for the same request;
- redacted frames carry contiguous sequence numbers and can be replayed;
- client or Server disconnect means detach, not cancel;
- attach resumes from the last acknowledged sequence;
- cancel is explicit, acknowledged, and idempotent;
- Executor and Server support at least N/N-1 protocol compatibility;
- terminal state and cleanup state remain independently observable.

Absolute profile timeouts, cgroup termination, tombstones, retries, provider-specific cleanup hooks,
reconciliation, metrics, and alerts handle abandoned local and remote resources.

### D10 — Restricted outputs are structured

A `restricted` job may return redacted streams and structured results that the Executor validates
against a narrow schema and reserializes. It may instead send an artifact directly to a fixed,
trusted destination without exposing its bytes to the agent.

Any agent-readable opaque file, archive, or binary can carry a transformed secret and therefore
makes the call `trusted`. Such artifacts are quarantined in Server-owned content-addressed storage,
receive a provenance manifest and retention period, and are never written automatically into the
session worktree.

### D11 — Migrate before claiming a secret-free Sandbox

Brokered Secrets cannot provide its advertised boundary while current project runtimes still receive
`DOPPLER_TOKEN` or equivalent provider values. Before enabling the feature as a security control,
Verity must:

1. stop projecting Doppler and provider credentials into agent and dev-server runtimes;
2. move provider-binding resolution to the Server;
3. reprovision existing Sandboxes;
4. revoke previously minted runtime tokens; and
5. verify that direct Sandbox commands cannot resolve configured aliases.

Compatibility mode may temporarily retain legacy injection, but the UI and audit log must label the
project as not secret-isolated.

## Consequences

### Positive

- Long-lived provider credentials leave the project Sandbox trust domain.
- Ordinary development commands retain local performance and compatibility.
- The product communicates the difference between hygiene and isolation explicitly.
- Restricted workflows become testable contracts rather than command-name allowlists.
- The design aligns durable job control with ADR 0006 while preserving a separate executor boundary.
- Specialized action brokers and the generic compatibility path share one catalog and audit model.

### Negative

- `restricted` profiles require per-workflow engineering and cannot support arbitrary CLIs.
- A new deployable Executor, policy proxy, snapshot protocol, storage path, and reaper increase
  operational complexity and cost.
- Per-job isolation adds cold-start latency; job pooling is out of scope until isolation can be
  proven across reuse.
- Generic `trusted` commands remain capable of extracting or misusing their injected secret.
- Opaque build artifacts cannot be advertised as isolated and require a trusted workflow.
- Existing Doppler injection must be migrated before the security benefit is real.

## Alternatives considered

### Inject placeholders directly in the project Sandbox

Rejected as a security boundary. Once replaced, the plaintext is readable by the agent-controlled
process and other processes in the same trust domain.

### Proxy every shell command

Rejected. It adds latency and operational load to commands that need no secret without solving the
arbitrary-command extraction problem.

### Generic external command runner with output redaction only

Retained only as `trusted`. Redaction protects accidental logs but cannot prevent transformed,
file-based, or network exfiltration.

### Build only specialized action brokers

Rejected as the only mechanism because third-party CLI diversity makes full coverage impractical.
Preferred for stable, high-risk workflows.

### Mount the session worktree into the Executor

Rejected. A writable mount provides a direct exfiltration channel, while even a shared read-only
mount complicates snapshot identity, race prevention, and audit reproducibility.

## Adoption and validation

Implementation starts with the deliverables and exit criteria in
Brokered Secrets Phase 0 Plan (`docs/BROKERED_SECRETS_PHASE_0_PLAN.md`, not in the public
snapshot). Phase 1 is limited to one or two
non-interactive `restricted` pilot profiles. The generic `trusted` fallback, interactive PTY support,
and opaque artifacts follow only after the core boundary is validated.

This ADR moves from **Proposed** to **Accepted** only after Phase 0 resolves the executor technology,
policy-proxy technology, pilot profiles, protocol schemas, migration inventory, and measurable cost,
latency, cleanup, and security test criteria.

## References

- [Brokered Secrets concept](../BROKERED_SECRETS_KONZEPT.md)
- [Brokered Secrets threat model](../BROKERED_SECRETS_THREAT_MODEL.md)
- [Current Doppler flow and migration](../BROKERED_SECRETS_DOPPLER_MIGRATION.md)
- Brokered Secrets Phase 0 Plan (`docs/BROKERED_SECRETS_PHASE_0_PLAN.md`, not in the public snapshot)
- [ADR 0002 — Credential and Isolation Architecture](0002-credential-and-isolation-architecture.md)
- [ADR 0005 — Naming and Layering](0005-naming-and-layering.md)
- [ADR 0006 — Runner-in-Sandbox Extraction](0006-runner-in-sandbox-extraction.md)
