# Brokered Secrets — Threat Model and Security Invariants

**Status:** Phase 0 draft · **Date:** 2026-07-17
**Decision:** [ADR 0009](adr/0009-brokered-secrets-and-secret-job-executor.md)
**Plan:** Brokered Secrets Phase 0 (`docs/BROKERED_SECRETS_PHASE_0_PLAN.md`, not in the public
snapshot)

## 1. Scope

This document defines the security boundary for discovering and using project-authorized secrets
through Verity. It covers:

- project Sandboxes and agent-controlled workspace code;
- the Verity tool gateway, Server, and encrypted settings store;
- provider bindings and Doppler;
- the Secret Job Orchestrator and Secret Job Executor;
- Snapshot Exporter, policy proxy, redactor, event persistence, and artifact quarantine;
- target APIs and external resources created by a job.

It does not claim to protect secrets from a fully compromised Verity Server administrator or from
the target provider itself. Those actors already administer the credential or the operation it
authorizes.

## 2. Assets

| ID | Asset | Required protection |
| --- | --- | --- |
| A1 | Global Doppler Service Account token | Never enters a project Sandbox or Executor job |
| A2 | Project-scoped or provider-issued token | Never enters a project Sandbox; job-scoped exposure only |
| A3 | Secret values fetched from a provider | Available only inside the authorized Executor job trust domain |
| A4 | Project broker capability | Not available as a reusable workspace bearer token |
| A5 | Single-use run grant | Integrity, audience binding, short expiry, replay prevention |
| A6 | Executor secret envelope | Confidentiality, job identity binding, one-time redemption |
| A7 | Alias/profile/policy configuration | Integrity, versioning, project binding, approval provenance |
| A8 | Workspace snapshot | Reproducible content identity; no capability or path escape |
| A9 | Raw child output | Must be redacted before external visibility or persistence |
| A10 | Audit history | Complete safe provenance without secret values |
| A11 | Structured results and artifacts | Integrity, provenance, explicit trust classification |

## 3. Trust domains

### T1 — Project Sandbox

Contains the agent backend, repository worktree, local development tools, and potentially malicious
repository code. This domain is not trusted with provider credentials or secret values. It may know
non-secret aliases and profile metadata.

### T2 — Verity control plane

Contains the Server, encrypted settings access, authorization logic, provider clients, lifecycle
state, and audit writer. It is trusted to resolve credentials and authorize calls. It does not run
repository commands or secret-bearing child processes.

### T3 — Secret Job Executor control service

Accepts only authenticated, versioned job requests from T2 and provisions isolated job instances.
It has no database, Doppler, or long-lived provider credential.

### T4 — Ephemeral Executor job

Runs one authorized secret-bearing operation. The injected value is considered visible to every
process and kernel surface inside this job trust domain. The instance is not trusted with another
job's data or reusable broker authority.

### T5 — Policy proxy

Terminates or parses supported outbound protocols and enforces the versioned execution profile. It
is trusted to prevent generic egress for `restricted` jobs.

### T6 — External provider and target service

Doppler or another provider supplies credentials or values. The target service receives the
authorized request. Provider and target compromise are residual supply-chain risks, not boundaries
Verity can eliminate.

## 4. Data flow

```text
Project Sandbox
  │ alias/profile request + snapshot manifest
  ▼
Verity tool gateway ──► authorization + single-use run grant
  │                                      │
  │ immutable snapshot                   │ provider lookup
  ▼                                      ▼
Secret Job Orchestrator             Doppler/provider
  │ start authenticated job              │ secret value
  ▼                                      ▼
Ephemeral Executor job ◄──── encrypted one-shot envelope
  │
  ├─ raw stdout/stderr ─► in-domain redactor ─► sequenced safe frames ─► Server
  ├─ typed request ─────► policy proxy ────────► allowed target
  └─ structured result ─► schema validation ──► Server
```

No raw output or secret value may bypass the in-domain redactor and envelope path respectively.

## 5. Attacker models

### M1 — Accidental disclosure

A legitimate CLI prints its token, includes it in an error, or emits it across output chunks. Exact-
match redaction is intended to mitigate this model.

### M2 — Malicious or prompt-injected agent

The agent intentionally requests unauthorized aliases, changes parameters after approval, replays a
grant, selects hostile workspace content, or tries to use output/network/artifacts as an exfiltration
channel.

### M3 — Malicious repository or dependency

Workspace code, hooks, plugins, package scripts, interpreters, or dependencies attempt to read a
Sandbox capability, replace an allowed executable, manipulate a snapshot, or exfiltrate a value
received by a `trusted` job.

### M4 — Compromised project Sandbox

An attacker controls every unprivileged process and agent-writable file in one project Sandbox.
They attempt cross-session, cross-project, host, control-plane, or Executor access.

### M5 — Compromised Executor job

The child process controls all user-space behavior inside one job. It tries to escape its namespace,
reach metadata/control-plane endpoints, inspect runtime credentials, persist data for later jobs, or
forge safe frames.

### M6 — Sibling project or job

A different project Sandbox or Executor job attempts to discover aliases, redeem grants, read
snapshots, attach to streams, access quarantined artifacts, or reuse another job's residual state.

### M7 — Network attacker or malicious endpoint

An attacker performs DNS rebinding, redirects, certificate substitution, proxy chaining, alternate
IP encoding, or abuses an otherwise allowed SaaS endpoint to receive arbitrary payloads.

### M8 — Crash and partial-failure attacker

Server or Executor restarts, lost acknowledgements, partial frames, cleanup failure, token rotation,
or ambiguous provider responses cause duplicate execution, raw logging, replay, or orphaned remote
resources.

### M9 — Control-plane administrator

A fully privileged Verity administrator can decrypt configured credentials and modify policy. This
actor is trusted by the current architecture. Verity must still audit administrative changes and
minimize plaintext lifetime, but ADR 0009 does not claim protection from this actor.

## 6. Security invariants

Every invariant is normative. Phase 1 must map it to at least one automated test.

### Credential location and lifetime

- **I01 — No Sandbox provider credential:** A newly provisioned project Sandbox contains no global,
  project-scoped, or minted Doppler/provider token in environment, files, process arguments,
  container metadata, or inherited descriptors.
- **I02 — Server-only provider binding:** The global provider credential is decrypted only inside an
  authorized Server operation and is never returned by an API or stored in an Executor definition.
- **I03 — Just-in-time resolution:** A secret value is resolved only after alias/profile approval,
  immutable snapshot binding, run-grant creation, and Executor workload authentication.
- **I04 — Job-scoped plaintext:** Plaintext exists only inside the Server provider call and the
  authorized Executor job trust domain for the bounded job lifetime.
- **I05 — No orchestration metadata secret:** Plaintext never appears in Docker/Kubernetes
  specifications, command arguments, orchestrator environment, persistent queues, runtime logs,
  traces, or crash reports.
- **I06 — Revocation convergence:** Rebinding, project deletion, or migration records every token
  slug and drives revocation to a durable terminal state or an actionable alert.

### Authorization and anti-replay

- **I07 — Alias is metadata:** Knowing or guessing an alias grants no authority and does not confirm
  the existence of an unauthorized provider source.
- **I08 — Project boundary:** Every provider binding, alias, profile, grant, job, snapshot, result,
  and artifact belongs to exactly one project trust domain.
- **I09 — Unforgeable initiating-call channel:** Authorization is tied to a structured native/MCP
  tool event carried by a Verity Runner-owned channel outside the agent child. Workspace processes
  cannot invoke or inherit that channel; an ordinary Sandbox CLI, PATH wrapper, shared Unix socket,
  or prompt instruction is insufficient.
- **I10 — Immutable decision:** A run grant binds request ID, session, project, alias and profile
  versions, parameters, snapshot, approval actor, audience, expiry, and nonce.
- **I11 — Single execution:** The same request or grant can create and redeem at most one job and one
  secret envelope despite retries, concurrency, or lost acknowledgements.
- **I12 — Fail-closed change:** Alias, provider binding, profile, policy, approval, snapshot, or
  Executor-identity changes invalidate the old grant rather than silently changing its meaning.
- **I13 — Least privilege:** Rate, concurrency, runtime, and target-system scopes are enforced in
  addition to Verity authorization.

### Executor isolation

- **I14 — Separate execution boundary:** Secret-bearing code never runs in the Server process or the
  ADR-0006 Session Runner.
- **I15 — No shared Sandbox namespaces:** An Executor job shares no mount, PID, IPC, or network
  namespace with a project Sandbox and cannot access its worktree or broker runtime.
- **I16 — No ambient host authority:** Jobs receive no host socket, service-account token, metadata
  credential, extra Linux capability, privilege escalation, ptrace, core dump, or swap-backed secret
  storage.
- **I17 — No cross-job reuse:** Phase 1 never reuses a job instance or mutable job storage for a
  different request.
- **I18 — Complete process termination:** Cancel, timeout, or policy failure terminates the complete
  process cgroup and prevents descendants from surviving outside it.
- **I19 — Cleanup observability:** Job-local and provider-side cleanup has durable state, bounded
  retries, an SLO, metrics, alerting, and an administrative recovery path.

### Restricted-profile integrity

- **I20 — Immutable executable:** A restricted profile pins image and executable digests and uses an
  absolute path with no PATH lookup or workspace override.
- **I21 — Typed parameters:** Restricted calls accept only schema-validated parameters mapped by the
  profile to fixed argument positions or request fields; no free shell or argument string exists.
- **I22 — Sanitized execution:** Dynamic-loader overrides, proxy variables, hooks, plugins,
  interpreters, package-manager shims, and descendants are denied unless explicitly modeled.
- **I23 — Honest downgrade:** If executable behavior, arguments, inputs, egress, or output cannot be
  constrained, Verity rejects the profile or marks the entire call `trusted`.
- **I24 — Approval-version binding:** User approval displays and binds the exact trust mode, profile
  version, operation, target, inputs, output contract, and credential aliases.

### Snapshot integrity

- **I25 — No live worktree mount:** Executor jobs never mount the session worktree directly, even
  read-only.
- **I26 — Atomic regular-file export:** Snapshot traversal is fd-relative, no-follow,
  no-mount-crossing, bounded, regular-file-only, and resistant to rename/link races.
- **I27 — Complete manifest semantics:** Revision, uncommitted and untracked files, deletions,
  renames, modes, exclusions, counts, sizes, and content hashes have versioned semantics.
- **I28 — Capability exclusion:** Snapshot export denies broker runtimes, credentials, VCS metadata,
  sockets, devices, submodules, and other unsupported special content by construction.
- **I29 — Content binding:** The Executor verifies the received manifest and bytes; the immutable
  snapshot ID is included in the run grant and audit record.

### Network confinement

- **I30 — No generic restricted egress:** A restricted job has no general DNS, raw TCP, UDP, or
  direct Internet route.
- **I31 — Protocol-aware policy:** Allowed traffic binds protocol, destination and certificate
  identity, operation, and required request fields.
- **I32 — Bypass resistance:** Direct IP, IPv6, DNS rebinding, redirects, CONNECT, proxy chaining,
  private ranges, metadata, and control-plane targets fail closed.
- **I33 — Arbitrary payload downgrade:** If an allowed destination can receive an
  attacker-controlled payload carrying transformed secret data, the workflow is not `restricted`.

### Output, persistence, and artifacts

- **I34 — Redaction inside trust domain:** Raw child output passes through the byte-oriented
  cross-frame redactor before leaving the Executor job trust domain.
- **I35 — Safe persistence:** Event store, transport spool, Server logs, telemetry, model backends,
  mobile notifications, and crash paths receive only redacted frames.
- **I36 — Bounded deterministic redactor:** Secret count/length, buffering, output size,
  longest-first overlap, binary frames, truncation, backpressure, flush, and abort behavior are
  versioned and bounded.
- **I37 — No transformation guarantee:** Documentation and UI state that exact-match redaction does
  not detect encoding, hashing, semantic fragmentation, network, files, timing, or side channels.
- **I38 — Structured restricted output:** Agent-readable restricted results are schema-decoded,
  validated, and reserialized by trusted Executor code.
- **I39 — Opaque means trusted:** Any agent-readable opaque artifact, archive, or binary makes the
  workflow `trusted`, regardless of path allowlisting or exact-match scanning.
- **I40 — Quarantined artifacts:** Trusted artifacts are content-addressed, integrity-checked,
  provenance-labeled, retained for a bounded period, and never automatically written to the
  worktree.

### Durable lifecycle and audit

- **I41 — Detach is not cancel:** Client or Server disconnect leaves an authorized running job under
  its absolute timeout and permits restart-safe attach.
- **I42 — Sequenced replay:** Only redacted frames receive contiguous sequence numbers; replay is
  idempotent and a terminal result follows the complete prefix exactly once.
- **I43 — Explicit control:** Cancel and other control commands have stable IDs, acknowledgements,
  replay behavior, and an explicit ambiguous state where atomicity is impossible.
- **I44 — Safe audit completeness:** Audit stores safe IDs and versions for request, binding, alias,
  profile, policy, snapshot, image, executable, approval, egress, redactor, result, and cleanup, but
  no secret value or raw secret-bearing argument.
- **I45 — Protocol compatibility:** Server and Executor support at least N/N-1 compatibility and
  reject unknown security-critical fields or versions rather than ignoring them.

## 7. Trust-mode guarantees

| Property | `trusted` | `restricted` | `action` |
| --- | --- | --- | --- |
| No provider credential in project Sandbox | Required | Required | Required |
| Child can read secret value | Yes | Yes, inside bounded job | No universal child credential |
| Exact-match output redaction | Required | Required | As applicable |
| Arbitrary command/arguments | Allowed by project policy | Forbidden | Forbidden |
| General egress | Possible and disclosed | Forbidden | Broker-specific |
| Opaque agent-readable artifacts | Possible and disclosed | Forbidden | Broker-specific |
| Secret isolation from child | No | No absolute guarantee | Strongest available boundary |

`restricted` constrains what a secret-bearing child can do; it does not make the value invisible to
that child. The target system and the allowed operation remain part of the residual risk.

## 8. Required adversarial test families

1. Capability theft, replay, cross-project substitution, concurrent redemption, and lost start ACK.
2. Alias/profile/provider-binding changes between discovery, approval, grant, and redemption.
3. Executable replacement, PATH shim, dynamic loader, interpreter, plugin, hook, and descendant
   execution.
4. Snapshot symlink/hardlink/mount races, special files, oversized trees, Unicode/case collisions,
   submodules, and LFS.
5. DNS rebinding, redirect, direct IPv4/IPv6, metadata access, CONNECT, proxy chaining, and allowed-
   target payload abuse.
6. Raw, split, overlapping, binary, truncated, backpressured, and crash-interrupted output.
7. Inspection of orchestration specs, environment, logs, traces, core-dump settings, swap, and
   persistent spools.
8. Encoded/file/network exfiltration attempts proving unsafe workflows are downgraded or denied,
   rather than falsely claimed safe.
9. Server and Executor restart, detach/attach, duplicate cancel, absolute timeout, reaper failure,
   and provider-resource cleanup.
10. Cross-project/job namespace, storage, artifact, stream, and metadata-service access.

## 9. Invariant-to-test ownership matrix

| Invariants | Planned automated suite | Primary owner |
| --- | --- | --- |
| I01–I06 | Provider migration integration tests; runtime/spec/log canary scan; durable revoke tests | Server/runtime |
| I07–I13 | Authorization property tests; replay/substitution/concurrency integration tests | Server/security |
| I14–I19 | Executor isolation tests; namespace/metadata escape tests; cleanup chaos tests | Runtime/platform |
| I20–I24 | Profile compiler schema tests; executable/argv/env negative tests; approval snapshot tests | Domain/security |
| I25–I29 | Snapshot Exporter property tests and filesystem race harness | Sandbox/runtime |
| I30–I33 | Policy-proxy conformance and network bypass testbed | Network/security |
| I34–I40 | Redactor fuzz tests; persistence/log canary scans; result/artifact contract tests | Executor/storage |
| I41–I45 | Restart, replay, control ambiguity, audit completeness, and N/N-1 protocol tests | Server/Executor |

Every suite must exercise a generated unique canary rather than a production-format fixture alone.
The Phase 0 protocol packages will attach individual test-case IDs to each invariant before ADR 0009
moves to Accepted.

## 10. Residual risks

- A `trusted` command can disclose or misuse every value injected into it.
- A restricted executable or allowed target may contain a vulnerability or intentionally abuse the
  narrowly permitted operation.
- A fully privileged Verity administrator can access configured credentials.
- Kernel, container-runtime, hypervisor, provider, or hardware compromise is outside the application
  boundary and requires platform hardening.
- Exact-match redaction is hygiene, not data-loss prevention.
- A broadly scoped provider credential retains its provider-side blast radius; short lifetime and
  target-system RBAC remain mandatory.

## 11. Review gate

Before ADR 0009 can become Accepted, Security must review:

- the invariant-to-test matrix;
- selected Executor and policy-proxy technologies;
- run-grant and secret-envelope protocols;
- both pilot profile definitions;
- the Doppler migration and revocation runbook; and
- measured evidence that no raw credential reaches the current logging and persistence stack.
