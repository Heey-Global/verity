# Authorization foundation for session egress

Status: integration contract and evidence map, not an enabled network policy.
Baseline: merged commit `ceb7048d36f2d5bb0ee542e45e4d5ceca04ac4dd`.
This document separates existing enforcement from requirements for the next
network implementation. It does not introduce a generic approval bypass or
claim that all execution paths already use a common authorization kernel.

## Decision and readiness

The existing gateway and broker seams are suitable starting points for egress
integration. The bounded contract work can finish without migrating every
adapter into a new framework. **Protected session egress is not ready to enable.**
The remaining implementation gates are:

1. Prove an unforgeable session/runtime identity at the network enforcement
   boundary. A project capability or a user/project container alone does not
   distinguish two concurrent sessions belonging to that user.
2. Enforce denial outside the sandbox for every covered traffic path, including
   DNS, direct IP, IPv6 and UDP. Project bridge egress is currently open.
3. Connect server-originated requests and long-lived services to explicit
   principals and permission lifetimes, and define narrow control-plane traffic.
   Local packet filtering cannot police destinations fetched by a remote model
   provider; those features require separate authorization, disabling, or an
   explicit exclusion from the protection claim.

These are concrete implementation gates, not evidence that another complete
security audit must precede the runtime experiment. No new production policy
violation was reproduced by the focused tests accompanying this document.
That statement is limited to those tests; it is not an all-adapter clearance.

## Shared contract

The trusted server or external runtime supervisor supplies the acting user or
service principal, project, session and turn when applicable, and runtime
identity/generation. A model argument, request header from the sandbox,
environment variable or shared writable file cannot select those identities.
Project-wide services must declare their owner/sponsor rather than borrow the
last active session. Existing unauthenticated local operation is an explicit
compatibility mode, not authenticated multi-user isolation.

Each adapter owns a canonical action and resource, its applicable account or
provider identity/version, the exact approved request, permitted consent scope,
policy version and expiry rules. The decision records its authenticated
approver and origin (card, standing grant or product policy), request identity
and safe audit correlation. A transport retry retains its invocation identity;
a different operation must not acquire the old receipt. Do not log credentials,
plaintext secrets or bearer capabilities.

Authorization requires all applicable checks: current execution permission,
action permission, account/provider use, resource policy, secret permission,
and, when implemented, network permission. Network permission cannot satisfy
any of the other checks. A connection capability is not a message-send approval.
Explicit project sharing remains distinct from personal ownership; this
contract does not silently change the existing sharing policy.

Maintain separate lifecycles:

| Object               | Meaning and boundary                                                                                                               |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Pending consent      | Exact displayed action/resource, ending in approval, denial, expiry or cancellation; edits need a new decision.                    |
| Standing grant       | Reusable only within its declared identity, action/resource and lifetime; revocation and expiry are distinct from request timeout. |
| One-time reservation | One durable winner for the adapter's declared operation identity; uniqueness alone does not prove current permission.              |
| Execution            | Reserved, dispatched, succeeded, failed or outcome unknown; transport failure must not silently mint a second operation.           |

Revalidate applicable authority after approval waits and at the adapter's final
local authorization point before a new effect. Document that point rather than
claiming a transaction across a database and a remote service. Revocation after
external acceptance cannot undo the effect. Existing streams require a specified
termination mechanism; polling is not instantaneous cancellation. An unavailable
authority check denies new work in protected paths.

Recovery must preserve original identity and request scope. Pending work must
not become approved after restart. Grants cannot widen during migration or
rollback; incompatible generations require rejection or fresh approval. Existing
provider identity comparisons that permit change-away-and-back remain distinct
from historical revocation counters.

## Evidence and adapter matrix

Paths below are relative to the repository. “Existing” names inspected test
coverage; it does not mean every listed suite was rerun for this document.
“Unproven” is a limit on the evidence, not a demonstrated exploit. Runtime
network identity remains unproven for all rows until the external experiment.

| Family and production enforcement                                                                                                                                                                                                                                         | Trusted context and last local check                                                                                                                                                                                                               | Existing evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Deliberate semantics / remaining evidence limit                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Gateway / Conductor: [packages/server/src/mcp-gateway.ts](../packages/server/src/mcp-gateway.ts), composition in [server.ts](../packages/server/src/server.ts); [packages/session/src/conductor.ts](../packages/session/src/conductor.ts)                                 | Turn bearer resolves session/turn; current initiator permission and bearer are checked after approval; authority snapshot is passed into the adapter.                                                                                              | [mcp-gateway.test.ts](../packages/server/src/mcp-gateway.test.ts): edited request, retired/reassigned bearer, authority drift, denied card; [google-calendar-gateway.test.ts](../packages/server/src/google-calendar-gateway.test.ts): removed/disabled initiator; Conductor tests cover stored queues and provider binding forwarding.                                                                                                                                                                                                                  | Gateway admission is not the effect itself. Native SDK permissions are a separate path. Conductor queue recovery does not prove restoration of every provider-specific consent.                                                                                                                  |
| Secret HTTP / trusted CLI: [brokered-http-tool.ts](../packages/server/src/brokered-http-tool.ts), [trusted-cli-tool.ts](../packages/server/src/trusted-cli-tool.ts), [brokered-http-grants.ts](../packages/server/src/brokered-http-grants.ts)                            | Trusted turn-bound executor carries approved provider binding; binding rechecks surround consumption before HTTP authorization or CLI dispatch.                                                                                                    | [brokered-secret-gateway.test.ts](../packages/server/src/brokered-secret-gateway.test.ts): positive controls and provider changes during approval/invocation/resolution/consumption; [brokered-http-grants.test.ts](../packages/server/src/brokered-http-grants.test.ts): session/project isolation, expiry and prior-policy grants; [brokered-http-consumption.test.ts](../packages/server/src/brokered-http-consumption.test.ts): durable replay fence.                                                                                                | Reservation is not a standing-grant revocation check. Lookup-to-effect revocation remains a bounded unproven candidate; do not substitute the consumption fence for current consent. Deterministic provider binding restoration is existing policy.                                              |
| Catalog / workers: [catalog-secret-authorization.ts](../packages/server/src/catalog-secret-authorization.ts), [secret-grant-broker.ts](../packages/server/src/secret-grant-broker.ts), conditional composition in [embedded.ts](../packages/server/src/embedded.ts)       | Authenticated approval actor, immutable profile/aliases/bindings and attested worker recipient; transactional issuance, one-attempt redemption, final configured permission consumption before sealing; worker validates recipient/context/expiry. | [catalog-secret-authorization.test.ts](../packages/server/src/catalog-secret-authorization.test.ts): actor/claims checks, approval deadline and issuance revocation; [secret-grant-broker.test.ts](../packages/server/src/secret-grant-broker.test.ts): context, revocation and concurrent redemption; [secret-worker-channel-auth.test.ts](../packages/server/src/secret-worker-channel-auth.test.ts): proof tampering/replay/expiry; [secret-envelope-crypto.test.ts](../packages/server/src/secret-envelope-crypto.test.ts): expiry and AAD mismatch. | Conditional wiring is not deployment proof. Broker captures time at redemption; opener checks expiry independently. Slow resolution through the complete deployed worker path remains unproven. Custom resolver configurations do not necessarily install the Doppler final-permission callback. |
| Remote MCP: [http-mcp-proxy.ts](../packages/server/src/http-mcp-proxy.ts) and server connection resolver                                                                                                                                                                  | Project listener and turn bearer; enabled binding/current connection on admission and serialized rechecks during streams.                                                                                                                          | [http-mcp-revocation.test.ts](../packages/server/src/http-mcp-revocation.test.ts): binding/credential revocation, slow lookup, valid stream and explicit project-sharing control.                                                                                                                                                                                                                                                                                                                                                                        | Stream revocation is polling-based. Explicit enabled project bindings may be used by other executing members; not a personal-owner bypass finding. Restart continuity of active streams is not claimed.                                                                                          |
| Google: [google-calendar-tool.ts](../packages/server/src/google-calendar-tool.ts), [google-contacts-tool.ts](../packages/server/src/google-contacts-tool.ts), [google-drive-authority.ts](../packages/server/src/google-drive-authority.ts) and service-specific adapters | Gateway initiator plus session/project account authority; mutation snapshots/claims and credential checks before provider calls where implemented.                                                                                                 | [google-calendar-gateway.test.ts](../packages/server/src/google-calendar-gateway.test.ts): account/project mismatch, authority replacement and initiator revocation; [google-drive-gateway.test.ts](../packages/server/src/google-drive-gateway.test.ts) and [google-contacts.test.ts](../packages/server/src/google-contacts.test.ts): service-specific access; other Google suites remain separate evidence.                                                                                                                                           | Calendar evidence does not certify Gmail/Drive/Docs/Sheets/Slides wholesale. Session/project account inheritance is not proof of personal ownership. Resource/version checks stay adapter-owned.                                                                                                 |
| Forge / Git signing: [brokered-forge-proxy.ts](../packages/server/src/brokered-forge-proxy.ts), [git-sign-route.ts](../packages/server/src/git-sign-route.ts)                                                                                                             | Project listener/capability bound to container generation; operation/host/repository or signing namespace validated before credentials/signing.                                                                                                    | [brokered-forge-proxy.test.ts](../packages/server/src/brokered-forge-proxy.test.ts): foreign capability/generation/repository rejection and redirect containment; [git-sign-route.test.ts](../packages/server/src/git-sign-route.test.ts): wrong project/generation, retired TCP bearer and signing namespace.                                                                                                                                                                                                                                           | Project/container capability permits constrained repeated operations; it is not per-session consent or proof of personal upstream ownership. Runtime identity mapping is required before session network grants apply.                                                                           |
| Matrix: [matrix-tool.ts](../packages/server/src/matrix-tool.ts), [packages/store/src/matrix-outbound.ts](../packages/store/src/matrix-outbound.ts)                                                                                                                        | Exact card-approved room/content and turn invocation; queued dispatch revalidates access, binding and lease.                                                                                                                                       | [matrix-tool.test.ts](../packages/server/src/matrix-tool.test.ts): duplicate/tampered sends, project/session isolation, revocation while awaiting dispatch, restart-like offline movement and lease/acknowledgement recovery.                                                                                                                                                                                                                                                                                                                            | Dispatch lease expiry is not consent expiry. Lost acknowledgement keeps a stable transaction ID. External acceptance after revocation is recorded honestly, not undone.                                                                                                                          |
| Automations: [automation-executor.ts](../packages/server/src/automation-executor.ts), [automation-routes.ts](../packages/server/src/automation-routes.ts), scheduler composition in [server.ts](../packages/server/src/server.ts)                                         | Sponsor or confirming user, current execution permission before script/prompt and queued admission.                                                                                                                                                | [automation-sponsor-authority.test.ts](../packages/server/src/automation-sponsor-authority.test.ts), [automation-executor.test.ts](../packages/server/src/automation-executor.test.ts), [automation-routes.test.ts](../packages/server/src/automation-routes.test.ts): inactive/removed sponsor, failed authority checks and admission controls.                                                                                                                                                                                                         | Already-running scripts are not cancelled. Network service ownership/lifetime still needs an explicit integration; schedule permission is not unlimited network permission.                                                                                                                      |
| Managed servers: [managed-dev-server-manager.ts](../packages/server/src/managed-dev-server-manager.ts), routes and secret resolver                                                                                                                                        | Displayed provider snapshot compared on approval; stored binding checked before resolution and launch/recovery.                                                                                                                                    | Manager/routes tests and mobile approval tests: stale/missing metadata, provider changes, recovery, refreshed explicit confirmation and unchanged-provider controls.                                                                                                                                                                                                                                                                                                                                                                                     | Existing processes are not stopped on permission change. Provider comparison is identity, not change history. A managed server needs a declared network principal independent of whichever session last changed project settings.                                                                |
| Native agents / shell / local MCP: backend adapters, [features/verity-sandbox-toolkit/bin/verity-script-sandbox.c](../features/verity-sandbox-toolkit/bin/verity-script-sandbox.c), [packages/server/src/docker.ts](../packages/server/src/docker.ts)                     | Backend permission mechanisms and runtime confinement; no demonstrated general session network identity.                                                                                                                                           | Existing backend/sandbox tests are not a proof of complete network denial. [docker.ts](../packages/server/src/docker.ts) explicitly creates an outbound-open project bridge.                                                                                                                                                                                                                                                                                                                                                                             | Shell children, arbitrary binaries, package lifecycle scripts and local MCP can use direct sockets. This is an explicit blocker to claiming protected session egress, not covered by gateway cards.                                                                                              |

### Coverage limits by lifecycle dimension

The source/test links above identify the evidence for each row. A limit here
must not be silently converted into a passing claim when adding network access.

| Family                   | Identity                                        | Revocation                                                                         | Expiry                                                                  | Replay                                                          | Recovery / restart                                                              |
| ------------------------ | ----------------------------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Gateway / Conductor      | Turn/session and current initiator              | Post-wait rechecks                                                                 | Bearer lifetime and card deadline are separate                          | Stable invocation identity; adapter owns effect deduplication   | Queue recovery exists; universal consent restoration unproven                   |
| Secret HTTP / CLI        | Turn and approved provider                      | Provider drift covered; standing-grant lookup-to-effect race unproven              | Grant lookup expiry covered                                             | Durable HTTP consumption; CLI-specific controls remain separate | Store recreation covered; process-crash end-to-end proof absent                 |
| Catalog / workers        | Claims, workload proof and recipient            | Issuance and configured final-permission checks                                    | Redemption and envelope-open checks; full slow-resolution path unproven | One-attempt capability and proof replay rejection               | Durable store implementation exists; complete worker recovery not verified here |
| Remote MCP               | Project binding and live turn                   | Active stream polling                                                              | Bearer/stream lifetime                                                  | Streaming proxy is not a once-only business operation           | Active-stream restoration not claimed                                           |
| Google                   | Service-specific account/session snapshots      | Calendar initiator/account controls; no blanket service certification              | Credential checks do not establish one common consent TTL               | Service-specific mutation claims                                | Full per-service recovery matrix unproven                                       |
| Forge / signing          | Project/container generation                    | Capability/binding validation; ongoing transport cancellation not established here | Generation capabilities are not per-action expiring consent             | Deliberately reusable capability                                | Old-generation rejection covered; complete deployment restart not exercised     |
| Matrix                   | Room/content/session invocation                 | Queued and dispatch-time checks                                                    | Lease lifetime differs from consent lifetime                            | Stable transaction and payload mismatch checks                  | Lost acknowledgement, expired lease and offline movement controls               |
| Automations              | Sponsor/confirming user                         | Before script, prompt and queued admission                                         | Schedule/claim lifetime is not network-consent expiry                   | Scheduler claim semantics remain separate                       | Queued admission rechecks; complete runtime restart not rerun                   |
| Managed servers          | Command, mappings and displayed provider        | New starts/recovery; no cancellation of running processes                          | No new consent TTL introduced                                           | Approval is reusable configuration, not one launch              | Provider-bound recovery controls                                                |
| Native shell / local MCP | No proven external per-session network identity | No general network revocation boundary                                             | No general network grant expiry                                         | Arbitrary sockets are not gated by tool replay fences           | No protected network-grant restoration claim                                    |

### Historical findings

PR #1966 addressed the reproduced ongoing Remote-MCP stream revocation cases.
PR #1971 addressed initiating-user revocation, automation sponsor authority,
managed-server provider checks and the displayed-provider approval race. These
must not be counted as unresolved failures from the earlier audit. The tests
remain regressions; deployment and physical-device validation are separate.
The prior Secret HTTP/CLI snapshot work is likewise represented by its composed
regression suite, not reopened solely because the architecture is heterogeneous.

The standing-grant revocation race and slow Catalog expiry remain candidates,
not confirmed vulnerabilities. They do not justify an unbounded audit cycle.
Before attaching either path to protected egress, its current consent/expiry
check must be located at the declared boundary and composed with the network
check. A reproduced violation there blocks that adapter's protected integration.

## Network adapter contract (not implemented here)

An external authority derives principal, project, session/service owner and
runtime generation from an authenticated channel. It normalizes hostname or IP,
protocol and port, and binds the network decision to that identity and policy
version. Sandbox-provided identity labels are never sufficient.

- **Once:** one admitted connection, not one HTTP operation. Reuse, streams and
  multiplexing must be explicit; an operation-level limit needs protocol-aware
  enforcement. The first implementation must define the UDP flow unit before
  offering once for UDP; unsupported units are denied.
- **Destination for this session:** exact normalized hostname/IP, protocol and
  port; no implicit wildcard/subdomain permission. Scope ends with the owning
  session/runtime or explicit revocation.
- **Public Internet for this session:** public destinations only, no implicit
  loopback, private, link-local, metadata or control-plane permission. It never
  grants account, secret, write or message permissions.

Controlled DNS must not forward attacker-selected payloads before authorization.
Resolution, redirects, rebinding and direct-IP paths must enforce destination
policy consistently, including IPv6 and UDP/QUIC. Narrow required bootstrap and
model-control traffic uses separately reviewed destinations and operations;
there is no generic fail-open exception for an unavailable approval service.

Deny, cancel, expiry, revocation, gateway outage and unknown generations prevent
new admissions. The implementation must terminate revoked ongoing connections
with a tested, documented bound. Restart must not revive stale decisions;
rollback must not reopen unrestricted egress in a claimed protected mode.

Server-side MCP, HTTP connectors, secret workers, Git brokers and other outbound
services must reach the same decision boundary through their trusted context.
Background services receive their own declared owner and lifetime, never the
most recently active session's grant. Provider-hosted search/fetch is separately
controlled or explicitly excluded; no local firewall coverage is implied.

## Runtime experiment and exit gate

Use the actual supported gVisor/runc configurations and two concurrent sessions,
including two sessions of the same user/project. Grant session A a synthetic
endpoint and deny B. Try B's own sockets, forged identity, shared writable state,
process access, inherited/transferred descriptors, reused connections and DNS.
Cover direct IPv4/IPv6, UDP/QUIC, shell/package children and local MCP; verify a
positive control for A. Rotate generation, revoke, restart and stop the gateway.
No unapproved attacker-controlled DNS or request payload may leave.

A per-user/project container is not proof of per-session separation. Choose
nested namespaces, separate containers or another enforcement design only after
these tests; if a supported runtime cannot enforce the boundary, protected mode
must be unavailable there. Record effects on shared workspaces, previews and
background jobs before changing container topology.

Proceed to this bounded experiment once the contract is accepted. Proceed to
enabling protected egress only when the experiment and all covered integration
paths satisfy the gate. No further generic framework rewrite is a prerequisite.

## Focused verification

The accompanying tests extend existing harnesses rather than introduce a new
approval engine: gateway session/turn reassignment with unchanged-caller control;
concurrent durable consumption, changed-request replay and store recreation;
Catalog grant-ID mismatch and malformed workload identity. Malformed input is
rejected before capability consumption; a well-formed mismatched grant consumes
the attempt. Store recreation is not an operating-system crash/restart test.

Controlled negative checks removed the session comparison, made the consumption
fence report success twice, and removed the grant-ID comparison. Each selected
guard failed as intended; production checks were restored. No live credentials,
provider requests, deployment or network-policy changes are part of this work.

The focused baseline run passed **174 tests in 10 files**:

```sh
TMPDIR=/work npx --no-install vitest run --maxWorkers=1 \
  packages/server/src/mcp-gateway.test.ts \
  packages/server/src/brokered-http-consumption.test.ts \
  packages/server/src/secret-grant-broker.test.ts \
  packages/server/src/brokered-secret-gateway.test.ts \
  packages/server/src/catalog-secret-authorization.test.ts \
  packages/server/src/secret-worker-channel-auth.test.ts \
  packages/server/src/secret-envelope-crypto.test.ts \
  packages/server/src/git-sign-route.test.ts \
  packages/server/src/matrix-tool.test.ts \
  packages/server/src/http-mcp-revocation.test.ts
```

This is selected local verification, not the full repository suite or proof of
live deployment. The other matrix entries describe existing evidence and its
limits rather than a fresh certification of those adapters.

Static verification passed:

```sh
npx --no-install tsc -b packages/server
npx --no-install eslint --no-warn-ignored --no-cache packages/server/src/mcp-gateway.test.ts packages/server/src/brokered-http-consumption.test.ts packages/server/src/secret-grant-broker.test.ts
npx --no-install prettier --ignore-path /dev/null --check docs/pre-egress-security-contract.md packages/server/src/mcp-gateway.test.ts packages/server/src/brokered-http-consumption.test.ts packages/server/src/secret-grant-broker.test.ts
git diff --check
```
