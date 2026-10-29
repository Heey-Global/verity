# Project egress routing and consent

Status: target contract for implementation; no firewall, role, connector or UI
behavior is enabled by this document. Network destination permissions are shared
by all sessions and background processes of a project. Account, secret and action
permissions retain their own identities and scopes. This supersedes session-only
network grant proposals in [the foundation contract](pre-egress-security-contract.md)
for the first version; it does not broaden existing grants automatically.

## Two independent decisions

Routing chooses **direct**, **broker**, **system**, or **blocked**. Authorization
chooses **covered**, **ask**, **setup required**, or **deny**. “Ask” is not a network
route. A broker can act without another card when valid permission already covers
the operation; a direct connection can require a card for its destination.

The trusted runtime/channel supplies project identity and generation; server
context supplies the initiating user or service sponsor. Adapter-owned schemas
supply canonical actions, resources and provider bindings. Agent explanations,
process names, environment labels and arbitrary caller headers cannot establish
identity or waive broker requirements.

| Route   | Eligibility                                                                                                              | Enforcement and failure                                                                                                                            |
| ------- | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Direct  | Public destination with no mandatory broker classification; an exact project destination rule is valid                   | External network boundary controls resolution, destination IP, protocol and port; absent rule blocks payload and requests consent                  |
| Broker  | Managed connection/secret, constrained package retrieval or a supported action requiring account/resource/content checks | Adapter validates identity, resource, action and provider; narrow broker transport rule supplies network access; no direct fallback                |
| System  | Necessary model/control traffic on a separately configured, limited path                                                 | Trusted configuration defines destinations and operations; broken setup disables the affected function instead of requesting broad Internet access |
| Blocked | Foreign-project authority, host control, metadata endpoints or bypass of a mandatory broker                              | No ordinary card can override this boundary                                                                                                        |

An intentional private service requires a separately configured connector or
administrative private-target rule. It is **setup required**, not a public-target
exception. Internal broker endpoints are reachable only through their authenticated
interface; allowing that interface never grants general host-network access.

### Decision order

1. Resolve trusted project/runtime and user/service identity; reject invalid,
   foreign, retired or unauthorized identities before creating a card.
2. Apply non-overridable destination/resource exclusions. Match mandatory broker
   and system classes before considering any direct destination grant.
3. For broker/system traffic, verify configured route and the appropriate existing
   authority checks. An unavailable broker or expired account never falls back to
   a direct socket. System-policy updates are not ordinary agent approvals.
4. For eligible direct traffic, normalize the exact hostname or IP, transport and
   port; reject userinfo, ambiguous target syntax and disallowed address classes.
   Resolve through controlled infrastructure and validate all selected addresses.
5. Match project, policy revision, target, scope, validity and revocation state.
   Covered means no new card; missing/expired consent means blocked pending a new
   explicit decision. DNS query payload must not escape first.
6. Revalidate decision authority and policy at approval and network admission.
   Destination changes/redirects require a new evaluation; approved source hosts
   do not approve their redirects. Network grants cannot override adapter checks.

Direct means no service-level broker, **not** unrestricted networking. TLS does
not expose arbitrary operation semantics to a packet filter. Any allowed direct
target may receive data in URLs, requests or an encrypted stream. Do not label a
host grant “read only” or promise that it excludes self-supplied credentials.

Protected and public operations can share a hostname. If the external boundary
cannot separate them, the target receives no blanket direct exception: provide
an operation-constrained broker or keep it blocked. This applies even when code
uses its own token instead of a Verity-managed credential. A service-specific
hostname list alone is not the classification model.

## Public package retrieval defaults

The target scope includes every ecosystem below; it is not limited to an initial
npm/PyPI subset. Public package metadata, package search and package downloads
through an operation-constrained artifact broker require no additional network
consent. Existing installation/protection checks remain independent. This is a
design decision, not a statement that these adapters exist or are enabled.

| Clients              | Public source covered by the target design             |
| -------------------- | ------------------------------------------------------ |
| npm, pnpm, Yarn, Bun | Public npm registry and validated package artifacts    |
| pip, uv, Poetry      | Public PyPI metadata and validated package files       |
| Cargo                | crates.io metadata and validated package files         |
| Go Modules           | Public Go module proxy and checksum service            |
| Maven, Gradle        | Maven Central metadata and artifacts                   |
| NuGet                | Public NuGet registry metadata and artifacts           |
| RubyGems, Bundler    | rubygems.org metadata and artifacts                    |
| Composer             | Packagist metadata and validated distribution archives |

The broker constructs requests from validated ecosystem operations and bounded
package identifiers, versions and search terms. It does not forward arbitrary
URLs, headers, request bodies, credentials or workspace files. Exact endpoint
rules, metadata-derived artifact validation and redirect handling must be defined
and tested for each ecosystem before activation. A registry response is untrusted:
it cannot authorize arbitrary archive hosts, private addresses or redirects.
Composer archives and other off-registry artifacts need constrained retrieval;
a reference to GitHub, for example, does not grant general GitHub access.

Publishing, login/account mutations, private registries, arbitrary Git dependencies,
custom mirrors, telemetry and additional browser/model/binary downloads are not
covered by this default. They need an appropriate separately configured or
explicitly authorized path. A missing artifact adapter reports unsupported/setup
required; it never silently opens direct access to the registry. Every listed
ecosystem remains part of the target scope until its adapter is verified.

Local lifecycle/build scripts may run under existing execution policy, but package
retrieval gives them no direct network permission. They remain subject to the same
project fence as other processes. Separately approved direct targets remain usable
and bidirectional; package retrieval does not revoke those explicit permissions.

Retrieval still transmits identifiers, versions and search terms. Syntax validation
alone cannot prove that these fields contain no encoded confidential information.
The contract limits operations and payload surfaces; it does not promise zero
information leakage. Arbitrary project-derived search text is not automatically
safe merely because it is sent to a registry. Public web browsing is outside this
package-default decision.

## Existing paths and target changes

All source links describe existing code, not a claim that every deployment uses
that path. Remaining implementation gaps are explicit.

| Path                                 | Existing enforcement / consent                                                                                                                                                                                                                 | Target route                                                                                    | Gap to close                                                                                                                                                       |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Shell, downloads, arbitrary binaries | [Docker bridge](../packages/server/src/docker.ts) permits outbound traffic; tool permissions do not constitute packet filtering                                                                                                                | Direct only under a target rule                                                                 | External deny-by-default boundary, controlled DNS and project attribution                                                                                          |
| Package installation / artifacts     | [Wrapper](../features/verity-sandbox-toolkit/bin/verity-package-install.mjs) consults [package broker](../packages/server/src/package-install-route.ts) for supported install/protection setup, then spawns the real manager                   | Existing install checks plus mandatory constrained artifact broker for default public retrieval | Package-age approval is not network approval; unwrapped binaries, Git dependencies, mirrors, tarball redirects and lifecycle children need the same external fence |
| Forge Git/API                        | [Forge proxy](../packages/server/src/brokered-forge-proxy.ts) with project capabilities and adapter host/operation/resource checks; not every operation asks                                                                                   | Broker for protected operations                                                                 | Prevent direct replacement paths; explicitly classify public content and redirected assets without giving the whole host a bypass                                  |
| Google service actions               | [Gateway](../packages/server/src/mcp-gateway.ts) and [Drive authority](../packages/server/src/google-drive-authority.ts) plus service-specific adapters                                                                                        | Broker                                                                                          | Preserve each service's current account/resource/action rules; do not infer all Google methods are authorized from one network target                              |
| Secret HTTP / CLI                    | [HTTP tool](../packages/server/src/brokered-http-tool.ts), [CLI tool](../packages/server/src/trusted-cli-tool.ts), [standing grants](../packages/server/src/brokered-http-grants.ts): approved request/provider binding and consumption checks | Broker; CLI execution still needs a controlled destination path                                 | Do not turn injected secrets into unconstrained subprocess egress; direct-target approval does not confer secret access                                            |
| Remote MCP                           | [Proxy](../packages/server/src/http-mcp-proxy.ts) checks connection/turn authority and rechecks live streams                                                                                                                                   | Broker for credential-bearing configured connections                                            | Explicit project sharing remains deliberate; arbitrary local MCP processes remain subject to direct network rules                                                  |
| Messages / publication               | [Matrix tool](../packages/server/src/matrix-tool.ts) and gateway preserve exact send approval; other publishers have their own rules                                                                                                           | Broker                                                                                          | Retain adapter-specific card/idempotency rules; destination consent must not suppress them                                                                         |
| Model traffic                        | [Claude](../packages/server/src/claude-egress-policy.ts), [Codex](../packages/server/src/codex-egress-policy.ts), [OpenCode](../packages/server/src/opencode-egress-policy.ts) policies                                                        | Narrow system path                                                                              | Provider-side fetching requires separate capability control or an explicit coverage exclusion; not locally observable destination filtering                        |
| Automations / managed servers        | [Automation executor](../packages/server/src/automation-executor.ts) checks sponsor; [server manager](../packages/server/src/managed-dev-server-manager.ts) checks approved provider on launch/recovery                                        | Same project network rules; broker for managed resources                                        | Preserve owner/sponsor attribution; permission survives neither expiry nor revocation merely because a process is already running                                  |

The same project rule applies to an install script and an interactive command.
An install script cannot reach additional destinations, but it **can** use targets
already allowed to the project. Default public package retrieval uses an artifact-specific broker and grants no
direct registry exception. An executable name is not trustworthy authority.

## Consent and authority

For new network target rules the proposed server check is
`hasProjectPermission(userId, projectId, 'manage')`. The implementation in
[store.ts](../packages/store/src/store.ts) requires an active user and membership
with `can_manage`; control-plane projects have additional restrictions. `execute`
is separate and does not imply `manage`. Role names alone are not sufficient.

[Paired route policy](../packages/server/src/paired-route-policy.ts) leaves unlisted
routes administrator-only and explicitly declares member-accessible resource
permissions. New network routes must declare and enforce project `manage`, check
origin/authentication through the existing route infrastructure, and repeat the
permission check when applying a delayed decision. This permission does not
currently configure egress: routes, storage and enforcement are implementation
gaps. Do not relax unrelated project settings or add an unauthenticated approval
fallback as part of this feature.

| Decision                                  | Who may decide?                                                                                | Scope / lifetime                                                                                      |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Direct target already covered             | No new person/card                                                                             | Exact existing project rule, until its expiry or revocation                                           |
| New direct target                         | Current project `manage`; a valid executing user/service may request but cannot self-authorize | Exact target/protocol/port, all project sessions/background processes; default one hour from decision |
| Broker action not covered                 | Person authorized by that adapter, with current account/resource rights                        | Exact action/resource/provider; retain existing once/standing-grant rules                             |
| Missing connection or insufficient rights | Account owner or authorized administrator through setup; no approval substitution              | No effect until actual setup/rights exist                                                             |
| Permanent network rule                    | Project `manage`, through explicit project settings                                            | Exact target until explicit revocation; never the default card action                                 |
| Hard-blocked target/bypass                | No ordinary approver                                                                           | Denied; any architecture/system-policy change is a separate administrative operation                  |

A default one-hour rule is a target product decision, not an existing TTL. No
silent renewal occurs. Existing session grants must not migrate to broader project
grants. Runtime restart must reauthenticate the project/generation and load only
still-valid policy; it must not resurrect revoked or pending consent.

Mandatory action and network checks remain distinct even if a UI groups them.
A broker's configured restricted transport should not prompt for an additional
general direct-host grant. Approval cannot repair a missing sponsor, revoked user,
wrong account or unavailable broker. Unknown state denies new effects.

## Concrete decision cases

`M` = current project manager (`manage`); `A` = adapter-authorized approver;
`S` = authorized setup administrator/account owner. “None” means no new consent,
not absence of authentication. Each row describes expected behavior to verify in
the future implementation, not an executed firewall test.

| ID  | Request and state                                                                    | Route                                     | Decision / approver                                                   | Scope or reason                                                     | Required enforcement                                       |
| --- | ------------------------------------------------------------------------------------ | ----------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------- |
| 01  | Public download, exact valid project target rule                                     | Direct                                    | Covered / none                                                        | Rule target/protocol/port and remaining TTL                         | External project fence                                     |
| 02  | Same download, no target rule                                                        | Direct                                    | Ask / M                                                               | New one-hour project target rule                                    | Hold before payload and uncontrolled DNS                   |
| 03  | Same destination, different port or protocol                                         | Direct                                    | Ask / M                                                               | Old rule does not match                                             | Canonical target matcher                                   |
| 04  | Public package metadata/search/download in any listed ecosystem; valid install setup | Broker                                    | Covered / none if install policy also covers                          | Default bounded artifact operation; no direct target grant          | Artifact schema, source/redirect checks and external fence |
| 05  | Install child contacts a new telemetry host                                          | Direct                                    | Ask / M                                                               | No inherited exception from package install                         | Process-independent external fence                         |
| 06  | Install child attempts upload to a default public registry                           | Blocked direct route                      | Deny / none                                                           | Package retrieval permits no upload or direct registry exception    | Artifact operation allowlist and mandatory-broker fence    |
| 07  | Private repository read, valid configured capability                                 | Broker                                    | Covered / none if adapter permits                                     | Exact project/repository/operation                                  | Forge adapter and credential boundary                      |
| 08  | Git push or workflow operation lacks required authority                              | Broker                                    | Ask / A only if adapter supports consent; otherwise deny              | Existing operation policy decides, not a generic new allow card     | Adapter check; never direct fallback                       |
| 09  | Same protected API called with an agent-provided token                               | Blocked direct route                      | Deny / none                                                           | Cannot evade mandatory broker route                                 | Protected-destination exclusion                            |
| 10  | Document read with valid account/resource grant                                      | Broker                                    | Covered / none if adapter permits                                     | Exact authorized resource and account                               | Connector checks                                           |
| 11  | Document publish/share requires fresh confirmation                                   | Broker                                    | Ask / A                                                               | Display exact resource, recipient/visibility and operation          | Adapter snapshot and final check                           |
| 12  | Document read with missing/disconnected account                                      | Broker                                    | Setup required / S                                                    | Card is not an account grant                                        | Connection resolution                                      |
| 13  | Secret HTTP request within valid standing scope/binding                              | Broker                                    | Covered / none                                                        | Alias, target, action and provider all match                        | Secret broker and target-constrained transport             |
| 14  | Same request after provider replacement                                              | Broker                                    | Ask / A after refreshing valid metadata                               | Old approval cannot cover replacement                               | Provider revalidation; no automatic replay                 |
| 15  | Arbitrary public API without managed credentials, no rule                            | Direct                                    | Ask / M                                                               | Target grant permits sending data, not just reading                 | External project fence                                     |
| 16  | Remote MCP configured and authorized for project                                     | Broker                                    | Covered / none for connection; tool consent stays separate            | Existing sharing and operation semantics                            | MCP connection/turn checks and stream revocation           |
| 17  | Missing MCP connection or broker outage                                              | Broker                                    | Setup required or unavailable / S if setup needed                     | No direct fallback, no broad Internet repair                        | Fail closed at connection resolver                         |
| 18  | Background job, valid sponsor and target rule                                        | Direct or required broker                 | Covered / none                                                        | Project rule includes background activity; sponsor remains separate | Sponsor plus route checks                                  |
| 19  | Same background job after network rule expiry                                        | Direct                                    | Ask / M; block meanwhile                                              | Service cannot renew its own project rule                           | Expiry and existing-stream termination                     |
| 20  | Redirect to another public target                                                    | Reclassify target                         | Ask / M if eligible and uncovered                                     | Original grant does not transfer                                    | Redirect-aware broker or new-connection admission          |
| 21  | Redirect/DNS resolution selects metadata or private address                          | Blocked or explicit private-service setup | Deny / none for normal public rule                                    | Public approval never permits private/control targets               | DNS/IP validation, including rebinding                     |
| 22  | Project B presents project A's rule                                                  | Blocked                                   | Deny / none                                                           | Trusted project identity mismatch                                   | External identity binding                                  |
| 23  | Network rule revoked while card is open                                              | Re-evaluate                               | Reject stale decision; fresh explicit request / M                     | Policy revision changed                                             | Atomic decision-version check                              |
| 24  | Approver loses manage before deciding                                                | No route admission                        | Deny / none                                                           | Prior card visibility does not retain authority                     | Current permission check on apply                          |
| 25  | Two sessions ask for the same eligible target                                        | Direct pending                            | One pending request / M                                               | Projectwide scope, visible requester list                           | Server-side deduplication                                  |
| 26  | Required model-control route is misconfigured                                        | System                                    | Unavailable / S                                                       | No general target card or public Internet fallback                  | Narrow system policy                                       |
| 27  | Intentionally configured private API                                                 | Broker or explicit administrative route   | Covered only within setup / S                                         | Exact private service; not ordinary public grant                    | Isolated private-target configuration                      |
| 28  | Denied request repeated by another project process                                   | Direct blocked                            | No new automatic card                                                 | Same project/target/policy denial                                   | Persistent suppression; human-initiated reconsideration    |
| 29  | Private registry, custom mirror or arbitrary Git dependency                          | Broker or reclassified configured path    | Setup required / S; action consent / A where supported                | Outside public package default; no inherited host permission        | Source configuration and account/resource checks           |
| 30  | Registry metadata redirects an artifact to an unapproved archive host                | Broker blocked                            | Deny / none under default; configure restricted source separately / S | Metadata cannot expand trusted destination rules                    | Validate every artifact and redirect hop, DNS/IP included  |
| 31  | Listed ecosystem has no verified artifact adapter                                    | Broker unavailable                        | Setup required / S                                                    | Target scope includes it, but no direct fallback is enabled         | Activation gate and explicit unsupported response          |
| 32  | Package publish requested                                                            | Broker                                    | Ask / A if supported and not already authorized; otherwise deny       | Download default grants no publication authority                    | Exact account/package/version/action checks                |

Cases 04/08/10/16 deliberately retain adapter-specific authorization rather than
invent an across-the-board prompt. Implementation must bind them to concrete
existing operation definitions before enabling that path.

## Card text and repetition

**New network destination**

> Allow this project to connect to `downloads.example.invalid` over TCP port 443?
>
> Requested by: Build session. This allows all sessions and background processes
> in this project to send data to this destination. It does not grant access to
> accounts or secrets. Expires one hour after approval.
>
> Deny · Allow for 1 hour

For an executing user without `manage`, show “Waiting for someone with permission
to manage this project.” Do not offer an effective approval button. Do not display
raw query strings, credentials, secret values or uncontrolled model text as the
verified destination. Show normalized target and server-derived context.

**Action requiring consent**

> Publish “Release notes” using your connected account?
>
> Destination: Project documentation. Visibility: Public. This approves this
> publication only; it does not allow other documents or general network access.
>
> Cancel · Publish

The adapter must supply the real frozen resource/action/visibility. This is a text
example, not a new approval policy for all document operations.

Deduplicate pending network requests by trusted project, canonical target,
protocol/port and policy revision. Record requester contexts without broadening
the grant. Approval starts the TTL once and pending requests expire after five
minutes; this proposed deadline is separate from the one-hour grant lifetime.
Persist a denial/suppression record for that target and policy revision until a
manager explicitly reopens it; repeated attempts or a new session do not create
new cards. Expiry or revocation never silently renews a rule. Reopening changes
the request identity and requires a fresh explicit decision.

An approved target enables a fresh connection attempt, not automatic replay of
an application mutation. Do not buffer or forward unapproved request payloads.
For uncertain external outcomes, preserve the adapter's idempotency and recovery
rules. Offline approvers, timeouts and broker failure leave access blocked.

## Bounded implementation sequence and gates

1. Implement a project-policy domain with canonical target matching, separate
   routing/decision results, expiring grants, revocation revisions, deduplication
   and authenticated `manage` endpoints. Verify cases 01–03 and 22–25/28 with
   deny-by-default controls; do not advertise packet enforcement yet.
2. Prove the external project boundary on a suitable isolated runtime host:
   project A allowed, B denied; DNS, IPv4/IPv6/UDP, shared IPC/descriptors,
   generation changes, revocation and real restart/outage. Existing session
   experiment results remain evidence of descriptor hazards, not this proof.
3. Integrate the external gate and narrow broker/system routes; verify protected
   host bypass prevention and all required service-specific transport adapters.
   Classify raw public/credentialed operations sharing an origin before allowing
   direct exceptions. Implement and verify constrained artifact adapters for every
   ecosystem in the package-default table, including cases 04–06 and 29–32.
   Completion of the package scope requires all listed ecosystems; individual
   unverified paths remain unavailable in protected mode.
4. Add the cards/settings using the same authoritative domain, then enable only
   after the runtime and service-path gates pass. Rollback must not silently
   restore unrestricted traffic under a protected label.

Concrete blockers: there is no general external project fence yet; new policy
routes/storage are absent; target-overlap and broker-bypass rules need technical
coverage; server-side connectors, persistent services and provider-hosted fetching
need explicit integration or exclusion. A suitable real runtime host is still
required. None of these is solved by a domain-only policy test.

The next scoped code change is item 1, after separate implementation approval;
the runtime experiment can then use the same policy semantics. This document
changes no production behavior, existing account ownership, sharing, UI or
firewall. The earlier local experiment files are preserved unchanged.
