# Remote Control v1: transport, enrollment and upgrade contract

Status: revision 5, proposed for joint Core/Uplink review, not frozen or implemented.
Incorporates the Uplink reviews through revision 3 against `6e6136802f04858414a0cfccd1e3349582b3b17e`
(runtime base `2a925eb47e73b2138d451ad954fca20f2fcf8d0e`). Private implementation
observations below are attributed to that review, not independently verified by
Core. Proposed requirements are not claims of existing runtime support.
This draft covers first administrator enrollment, paired administrator access,
team enrollment and member access, and Uplink upgrades of existing pairings. It
does not activate Remote Control or team sharing. Normative language below describes
requirements for the proposed profile, not claims about existing implementations.

## Scope and evidence

The [base channel protocol](../UPLINK_CHANNEL_PROTOCOL.md) owns control leases,
entitlements, ticket attachment and stream semantics. This profile fills in remote
admission, bounded byte transport and access lifecycles. The
[team proposal](uplink-team-sharing-v1.md) owns team invitations, membership grants
and service assertions; this profile defines how those flows use the same tunnel.
Both proposals must be frozen together for team access. A team grant cannot
bypass the hosted transport lease.

The public preview codec currently accepts only `http` and `ws` opens. Add a
separate remote adapter/validator; do not silently reinterpret preview traffic.
The Uplink feasibility response reports remote forwarding and atomic, one-use,
60-second tickets, but no admission flow that issues paired tickets. Its source
revision is `2a925eb47e73b2138d451ad954fca20f2fcf8d0e`; Core has not inspected
that private source directly.

The native mock-WSS prototype in `scripts/remote-control-tunnel` passed its macOS
and iOS simulator steps in Core CI run `36031419560` at `4b300dc7cacbf49ab1520a52ca53e0a647498321`.
It tests raw binary WSS, not this JSON/base64 profile, hosted admission or the
public gateway. This is evidence for a candidate adapter, not production readiness.

## Identity and routing

Pairing records the logical Core HTTPS origin, its existing certificate trust/pin
material, a device credential and an opaque installation handle. The handle must
contain at least 128 bits of cryptographic randomness; it is routing information,
not proof of device identity. Uplink supplies this random routing value as `welcome.handle`; publish that value
as `installationHandle`. Persist the separate UUID `welcome.installationId` as
the service installation identity, never as the routing handle. Reissue of either
value invalidates the descriptor binding; neither replaces Core trust. Publish it only
through the authenticated descriptor or enrollment invitation. Existing profiles
without it use authenticated direct refresh or the route-only import below,
never enumeration or replacement pairing.

Outer WSS verifies the configured Uplink origin using normal TLS validation.
Inner TLS preserves Core's logical hostname and existing pin/chain verification.
The device bearer appears only inside inner TLS. Uplink can observe handles,
stream IDs, timing and sizes, but must not receive Core HTTP credentials or TLS
private keys. Tickets are secrets: never place them in URLs or logs.

Each app-side TCP socket maps to one remote stream. The Core connector dials one
administratively configured local Core TLS listener. Neither admission nor stream
metadata accepts a destination host, port, path or URL. A native loopback proxy
binds only loopback, restricts destinations to the paired logical Core origin,
and exists only for its owning transport session. It must not become a general
proxy. The local Core listener retains normal TLS and API authentication.

## Negotiation and endpoints (new proposal)

Keep the existing base `protocolVersion`. Extend `hello` with optional
`capabilities: string[]` and retain `channels: string[]`; `welcome` advertises
the service's supported arrays in the same fields. Example additional fields:

```json
{"capabilities":["remote-control-v1"],"channels":["http","ws","remote"]}
```

These are additions to the base hello/welcome envelopes, not complete messages.
Each array contains at most 32 unique nonempty ASCII names of at most 64 bytes;
wrong types, duplicates or exceeded bounds reject the handshake. Unknown names
are ignored when intersecting peer support. Absent capabilities means `[]`;
empty capabilities is valid and selects no profile. Absent channels retains the
base `["http", "ws"]` fallback; explicit empty channels is invalid. Each peer
computes the intersection of its advertisement and the other peer's advertisement.
Remote requires both `remote-control-v1` and `remote` in those intersections plus
current `remote-control` entitlement. App `connect.capabilities` follows the same
bounds and must offer the profile; `connect.ready.capability` confirms selection.
No new session messages go to an older peer without explicit selection. The
service parser and serializer need changes; existing code discarding these fields
cannot negotiate remote v1. Existing preview sessions remain independent.

Propose an app admission WSS endpoint `/remote-control`, alongside existing
`/control` and `/data`. All endpoints use the configured Uplink origin; never
follow a server-supplied ticket destination onto another origin. Admission uses
JSON text messages with `type`; stream frames also use `type`, matching Uplink's
existing `/data` wire envelope. Core's preview codec uses `kind` internally;
a separate remote adapter must map explicitly without changing preview framing. No device bearer or
subscription key is sent on app admission. The installation's existing authenticated
control socket is the sole source of `session.accept` and `session.refuse`.

Every ordinary admission socket carries exactly one connect request. Team recovery
uses the explicit reserve-then-connect exception defined below. IDs are nonempty ASCII
`[A-Za-z0-9_-]` strings of at most 128 characters, generated with at least 128 bits
of randomness. Uplink generates `sessionId`; the app generates `requestId`.
Times are integer Unix milliseconds; Uplink's clock decides ticket expiry.

App to admission socket:

```json
{"type":"connect","requestId":"request_example","installationHandle":"handle_example","capabilities":["remote-control-v1"]}
```

Uplink to installation control, then installation reply (exactly one):

```json
{"type":"session.request","requestId":"request_example","sessionId":"session_example","capability":"remote-control-v1","decisionExpiresAt":1800000000000}
{"type":"session.accept","sessionId":"session_example"}
{"type":"session.refuse","sessionId":"session_example","code":"unavailable"}
```

Acceptance means Core can reserve a connector, not that it authenticated a device.
Core refuses when remote access is disabled or local capacity is exhausted.
It must not prompt for each unauthenticated admission request.

After acceptance, Uplink atomically creates two different tickets and sends:

```json
{"type":"session.ticket","sessionId":"session_example","ticket":"installation_ticket_example","expiresAt":1800000060000,"capability":"remote-control-v1"}
{"type":"connect.ready","requestId":"request_example","sessionId":"session_example","ticket":"app_ticket_example","expiresAt":1800000060000,"capability":"remote-control-v1"}
```

The first goes only to installation control; the second only to the requesting
admission socket. The expiry is 60 seconds after issuance, not after request.
Both parties open `/data` and send `{"type":"attach","ticket":"…"}` as their
first message. The proposed remote-profile response is
`{"type":"attached","sessionId":"session_example","capability":"remote-control-v1"}`.
Send `attached` to both only once both tickets have been consumed and checks pass;
no stream traffic is allowed before it. This readiness barrier is new behavior
and must be scoped to this negotiated profile, preserving existing attachments.

Admission failure is `connect.error` with the original `requestId` and `code`.
Attachment failure is `reject` with `reason`. Allowed admission codes are
`unavailable`, `rate_limited`, `limit_reached`, `protocol_unsupported`, `timeout`,
`cancelled`, `internal`. Unknown/offline handles, disabled access and lack of
entitlement all map to `unavailable` on the unauthenticated app socket. No account,
subscription or device details appear in errors. `rate_limited` may include
`retryAfterMs`, bounded to 1000–60000. Core refusal codes are `unavailable` or
`limit_reached`. Invalid protocol messages close the offending socket with 1008,
matching existing control/data policy. Attach retains `invalid_ticket`,
`expired_ticket` and `not_entitled`; generic `unavailable` is confined to app
admission, not a replacement for established `/data` ticket errors.

## Reservation, cancellation and lease lifecycle

1. Uplink validates and rate-limits before notifying Core. Initial proposed
   ceilings: 10 connect attempts/minute/handle, 30/minute/source IP, four pending
   reservations/installation, and one connect request/socket (including the bounded recovery sequence). Bound the global pending
   table and limiter cardinality as specified below; exhausted capacity fails closed.
2. A decision expires 15 seconds after receipt of `connect`. Only the live
   authenticated installation control connection identity owning the request can answer.
   A duplicate acceptance never issues another pair. Late answers are ignored.
3. Tickets bind installation, transport session (not a verified user), party, control connection identity, selected
   profile and expiry. Consume atomically once; swapping parties, replay, or using
   a ticket on another session fails. Party is assigned by the ticket, not by a
   client field. Concurrent consume attempts yield at most one success.
4. Expiry or failure of either attachment invalidates its sibling and closes any
   attached peer. A consumed ticket is never restored. Bound attach-first-message
   wait to five seconds. Both attachments must finish before ticket expiry.
5. Keep admission open until the app receives `attached`. App cancellation is
   `{"type":"connect.cancel","requestId":"request_example"}`; socket loss
   before activation has the same effect. Uplink sends Core
   `{"type":"session.cancelled","sessionId":"session_example","code":"cancelled"}`
   and releases tickets, sockets and capacity. After activation the admission
   socket may close normally; cancellation then closes app data. Activation and
   cancellation are serialized: cancellation before activation wins; after
   activation it closes both data sides. The app closes any late data attachment.
6. Entitlement and live control lease are checked before issuance, at attach and
   before every forwarded frame. Control loss/replacement, revoke or lease expiry
   cancels pending sessions and closes active pairs. Schedule lease expiry directly;
   do not rely only on traffic. A proposed maximum 30-second revalidation interval
   bounds idle detection of external entitlement changes.
7. Each data connection loss closes its sibling and resets all session streams.
   Release timers, pending buffers and connector sockets on every terminal path.
   Persist only ticket hashes and lifecycle records, never plaintext ticket secrets.
   Do not restore active sessions after process restart; follow the cleanup rules below.

Do not interpret the base protocol's unresolved 4001/4003 close-code collision as
an authorization decision. Record socket role and structured reason; a bare close
means transport loss. No new shared 4000-range mapping is frozen here.

## Stable control binding, atomic issuance and activation

Uplink assigns a new, cryptographically random, at least 128-bit
`controlAdmissionId` to each accepted control socket and persists it with the
control row. It is distinct from the existing 48-bit process-local logging
`connectionId` and from the epoch incremented on renewal. Neither is authority
for remote sessions. The admission identity is stable until that socket closes
or is replaced and need not be exposed to the app. Reservations, session records and both ticket hashes bind to
it, not to the service epoch incremented on renewal. A successful renewal on the
same socket updates its lease/feature snapshot atomically without changing this
binding or dropping valid pending/active sessions. It does not extend ticket TTL.
Replacement fences the old identity before accepting new admissions; old answers,
tickets and data sockets fail even if a previous lease has time remaining.

A session progresses through `requested -> issued -> waiting-peer -> active ->
terminal`; either attach order is allowed. Expiry, cancellation, control loss or
failure can terminate any nonterminal state. Transitions, ticket consumption and session invalidation are serialized against
renewal, replacement and revocation using this persisted installation/control
binding in the authoritative store, not a process-local logging lookup.

Acceptance performs one database transaction: compare-and-set the unexpired
`requested` reservation for the live control identity, reserve capacity, insert
both independent ticket hashes with unique `(sessionId, party)` constraints and
set `issued` plus the common expiry. Rollback leaves neither ticket usable. A
unique session/request association prevents a duplicate acceptance minting a new
pair. Retain plaintext only in the live process's bounded delivery state until
initial delivery; never in database rows, diagnostics or durable outboxes.

A duplicate acceptance observes the existing outcome and sends no newly minted
tickets. If delivery fails or `connect.ready`/`session.ticket` is lost, the peer
waits at most until the original expiry, then the entire pair becomes terminal.
There is no ticket-result recovery API: a fresh admission gets a new session and
pair. Detected socket loss cancels immediately. A committed transaction followed
by process failure never authorizes restoration. This deliberately favors safe
retry over recovering an undelivered ticket secret.

Each attach atomically consumes its party's hash and registers its socket under
the session lock. Recheck expiry, live control identity, lease and entitlement at
each attach **and again at activation**; Uplink time must be strictly before the
common expiry at activation. First attach receives no `attached`. After both
succeed, reserve bounded output space and enqueue `attached` to both sockets
before allowing any stream forwarding. Per-socket FIFO ensures the barrier is
observed before any data. The server cannot atomically deliver two network
messages: if either enqueue/send fails, terminate both; a peer seeing `attached`
then close must retry fresh. A first peer whose sibling expires/cancels is closed
and never receives an active session. Admission loss after server activation is
normal; explicit cancellation still terminates the pair.

Ticket hashes remain for replay prevention until their expiry plus five minutes;
terminal pending-session records remain at least until the same retention bound.
Delete expired records in bounded batches at least once per minute. Active records
live until termination. Restart marks records owned by the dead service process
terminal and invalidates its tickets before serving attachments; other processes
must not recover those sockets. Distributed deployments need an exclusive owner
fence or fail-closed ownership check, not an assumption that memory survived.

## Admission budgets and trusted ingress

The current singleton service has hard ceilings of 256 total WebSockets,
64 pending WebSockets and 320 total HTTP sockets, with advertised
`maxConcurrentSessions: 5` per installation. Remote v1 must fit inside these
existing shared ceilings; it does not authorize multiple service instances or
larger advertised capacity.

Proposed initial remote-only sub-budgets are 32 active sessions, 16 pending
sessions and 16 pre-request admission/attach sockets, with at most five active
sessions per installation (or a lower advertised limit). Count admission and both
data sockets against the shared limits. A pending session can occupy three
WebSockets; an active session can retain its admission socket, so budget three
per session rather than assuming the app promptly closes admission. The remote
maximum is therefore 160 WebSockets including pre-request sockets, leaving at
least 96 of the 256 slots outside the remote allocation. Existing control/preview
usage can still force earlier rejection. Reserve slots before upgrade/attachment;
the shared 64 pending-WebSocket and 320 HTTP-socket ceilings always take priority.
These are conservative proposals requiring Uplink load evidence before freeze,
not a guaranteed minimum capacity or an approved scaling design.

Keep 65536 combined limiter entries and a 16 KiB UTF-8 admission/control session
message cap as proposed new bounds. Count pending sessions until activation or
terminal cleanup, and reserve active capacity atomically at activation. Bound
first admission message wait to five seconds. Existing per-handle/IP limits still
apply. Lower deployment limits may reject earlier; larger targets need a separate
scaling decision, implementation/advertised-limit changes and load evidence.

Derive source IP from the socket peer unless it belongs to an explicitly configured
trusted ingress chain. Only then consume the ingress-overwritten forwarded source;
walk the trusted chain from the server side and stop at the first untrusted hop.
Ignore client-provided forwarding headers. Canonicalize addresses before limiting.
Unknown handles share bounded admission accounting and the same public refusal
shape; they cannot allocate an unbounded key per guess. On limiter capacity
exhaustion reject new keys rather than evicting active limits and permitting a
bypass. Enforce global counters across replicas, fail closed if unavailable, and
verify trusted-proxy configuration in staging. Known and unknown handles pass the
same rate limiting before any control notification.

## Byte framing and bounded producers

Remote opens once, from app to Core, with empty metadata. Core never sends a
reverse open. These are illustrative envelope examples; `AQID` is placeholder
bytes, not a TLS handshake:

```json
{"type":"stream.open","streamId":"stream_example","channel":"remote","meta":{}}
{"type":"stream.data","streamId":"stream_example","seq":0,"payload":"AQID"}
{"type":"stream.end","streamId":"stream_example"}
{"type":"stream.reset","streamId":"stream_example","code":"timeout"}
```

Each direction starts `seq` at zero and increments by one per data frame. Require
safe nonnegative integers and canonical padded base64. Gaps, repeats, data after
end, duplicate opens or unknown stream IDs are protocol errors. Stream IDs are
never reused in a session. Stream boundaries are independent of TLS records and
HTTP messages: concatenate decoded bytes exactly, with no decoding of inner TLS.
Only the four shown frame types are allowed. Reject unknown fields: open has
exactly `type, streamId, channel, meta` with `meta: {}`; data has exactly
`type, streamId, seq, payload`; end has exactly `type, streamId`; reset has exactly
`type, streamId, code`. Remote data/end/reset have no metadata. Reset codes used
here are `protocol_error`, `concurrency_limit`, `upstream_error` and `timeout`.
Keep a bounded used-ID set: after 4096 opens over a session lifetime, reject new
opens with `concurrency_limit` and require fresh admission. Never evict IDs in a
way that permits reuse. This strict validator applies only to remote v1.

Proposed fixed v1 ceilings, enforced at app, connector and relay:

| Resource | Ceiling / behavior |
| --- | --- |
| Decoded data chunk | 64 KiB; split larger native reads before encoding |
| JSON text frame | 96 KiB UTF-8 before parsing; binary WSS messages rejected |
| Streams per session | 8 active; excess open resets `concurrency_limit` |
| Pending decoded bytes per stream/direction | 256 KiB |
| Aggregate encoded queues per data connection | 1 MiB including queued/in-flight application sends |
| Local TLS dial | 10 seconds; failure resets `upstream_error` |
| No byte progress while a queue is nonempty | 30 seconds; reset `timeout` |

These limits deliberately sit below reported service maxima (1 MiB chunks,
64 streams and 2 MiB slow-reader disconnection). Both sides must explicitly agree
them; they are not inferred from existing `welcome.limits`. This profile uses
bounded producers and fail-on-overload, **not lossless end-to-end credit flow**.
Pause source reads before queue exhaustion, resume below half the ceiling, allow
only one outstanding native receive per stream, and account for base64 expansion
and the next frame before accepting another read. Bound receive queues before
allocating/decoding payloads. Keep platform socket buffers bounded as well.

A blocked local sink resets only that stream (`upstream_error` at Core,
`upstream_error` at app). A relay/aggregate queue reaching its hard ceiling closes
both data connections; never silently drop bytes. Fair scheduling must prevent a
busy stream starving others. Sustained slow traffic may terminate rather than
resume: that is an explicit v1 limitation to test. If lossless multiplexed flow
control is required, negotiate a new capability with credits; do not add
unrecognized `stream.window` frames to this profile.

`stream.end` is a TCP sending half-close after queued bytes drain, not the end of
an HTTP request. Preserve the reverse direction until its end; TLS close-notify
remains TLS bytes. Reset immediately cancels both directions and releases queues.
Only both ends or a reset releases the stream slot. Idle streams with empty
queues may remain open while the lease and WSS heartbeat remain valid. Add a data-socket heartbeat for this profile: Uplink sends WSS ping every
15 seconds and closes the pair if no matching pong arrives within 45 seconds of
the oldest unanswered ping. Application data does not acknowledge a ping. Clear
heartbeat timers on terminal close. This is new service work, not existing data
socket behavior.

## Reconnect and application authorization

A reconnect starts a new admission, new tickets, streams and TLS connection.
Never replay ciphertext, stream sequence state or application writes. Retry
transient connection establishment with full jitter, starting at one second and
capped at 30 seconds; stop on cancellation or an explicit nonretryable refusal.
Honor `retryAfterMs`. Invalid/expired tickets are discarded, not resubmitted.
A TLS pin/hostname failure is terminal and requires trusted identity repair, never
an automatic re-pair or disabled validation.

Core checks the existing device credential inside TLS on each normal API request
and WebSocket authorization. An admitted but unpaired client receives no remote
authority. Apply existing local authentication throttles to remote connections.
Device revocation must also close its authorized application WebSockets, without
requiring Uplink to learn device identity. Reconnection does not automatically
retry a potentially committed HTTP mutation; use an application idempotency
mechanism or report an unknown outcome. Session/event replay is an application
concern, never a tunnel responsibility.

## Joint acceptance vectors (required, not yet executed)

| ID | Stimulus | Required observation |
| --- | --- | --- |
| RC01 | Missing capability, channel or entitlement | No remote session; existing preview behavior unchanged |
| RC02 | Two personal devices connect | Independent sessions, tickets and TLS credentials |
| RC03 | Concurrent ticket replay, party swap, expiry | At most one consume; no cross-session attachment; sibling cleanup |
| RC04 | Late/duplicate acceptance; cancel races both attaches | No duplicate pair or orphan socket/timer/reservation |
| RC05 | Wrong inner pin/hostname or outer trust | Connection fails; no credential reaches an untrusted endpoint |
| RC06 | HTTPS GET, upload/download and WSS over real JSON frames | Exact bytes and normal Core authorization through native app and connector |
| RC07 | Slow sink, sustained transfer, eight busy streams | Measured queue ceilings; pause/resume or specified reset; no unbounded memory |
| RC08 | Invalid base64, seq gap/replay, oversize, pre-attach data | Bounded rejection; no crash or forwarding of invalid bytes |
| RC09 | Half-close with pending reverse response | Reverse bytes drain completely; reset cancels immediately |
| RC10 | Control loss, lease expiry, revoke, idle entitlement withdrawal | Both parties close within specified deadlines; all capacity reclaimed |
| RC11 | Disconnect after a mutation, then reconnect | Fresh TLS/tickets; no automatic mutation or ciphertext replay |
| RC12 | Unknown-handle flood, admission flood and slow attachment | Bounded global/per-source/per-installation state and generic refusals |
| RC13 | Host/port injection and invalid device token | No arbitrary target dial; Core refuses API access inside TLS |
| RC14 | Hosted gateway plus real connector, macOS and iOS device/simulator | Outer TLS/ATS, frame limits, timeouts and lifecycle verified beyond loopback |

After joint schema approval, create shared machine-readable fixtures, then pin
the schema revision and fixture digest together. Run each on Core
and Uplink. Before trusting guards, deliberately break the corresponding bound,
pin, sequence or cleanup behavior and observe the guard fail. Synthetic credentials
only; no ticket, bearer, subscription key or private certificate key in artifacts.

## Paired implementation packages and freeze gate

| Package | Core deliverable | Uplink deliverable | Exit evidence |
| --- | --- | --- | --- |
| RC-A: contract | Strict remote codec/schema and native mapping review | Review admission wire shapes, ticket binding and proposed limits | One approved contract revision and matching fixtures |
| RC-B: admission | Capability negotiation, handle pairing storage, reservation and outbound connector | Admission endpoint, bounded reservations, paired ticket issuance and barrier | RC01–04, RC10, RC12 |
| RC-C: byte path | JSON/base64 native adapter, fixed TLS target, bounded queues and cleanup | Remote-profile validation, queues, lifecycle and fair forwarding | RC05–09, RC11, RC13 |
| RC-D: integration | App transport selection and actionable failures, direct path retained | Staging gateway configuration and operational bounds | RC14 plus full paired fixture run |

Before implementation freeze, Uplink must confirm or return explicit deltas for
capability negotiation, `/remote-control`, readiness barrier, cancellation,
handle provisioning, limits and errors. Pin the reviewed Core commit and matching
Uplink contract commit plus fixture digest in both handbacks. Until then this is a
reviewable proposal, not a cross-repository agreement. No private service source,
billing or brokerage implementation belongs in this public repository.

Implement and validate the common transport first, then the enrollment and upgrade
packages below before declaring the complete access contract implemented. The
preview feature rename to `preview-sharing` remains a separate agreed change;
this profile introduces no alias for old `sharing` and does not resolve the team
V01/signature/deadline questions by implication.

## Access modes and authorization boundary

| Flow | Trusted starting material | Core authority after completion |
| --- | --- | --- |
| First remote administrator enrollment | Installation-issued one-use invitation and Core identity | Initial administrator device, only while initialization is unclaimed |
| Paired administrator reconnect | Existing Core trust and device credential | Existing administrator permissions |
| Team invitation redemption | Inviter-issued invitation and Core identity | Only locally committed project membership and device binding |
| Paired member reconnect | Existing Core trust and member device credential | Current project membership, permissions and valid team grant |
| Existing pairing gains Uplink | Descriptor fetched through authenticated pinned Core connection | Exactly the existing identity and permissions |

All flows use the same pinned inner TLS byte transport. Admission, possession of
an installation handle, a paid Uplink account, subscription key, or a ticket
confers no Core role. Core resolves the authenticated device to its local user
and checks current permissions; an app-supplied role is never authoritative.
A member cannot access instance administration, the control-plane project or
another project by choosing an administrator flow. Membership removal, device
revocation and team-grant suspension fence active member work as specified by the
team contract, including already authorized WebSockets.

## First administrator enrollment from installation

The installer may accept an optional Uplink subscription key through a hidden
interactive prompt or a protected secret file. Do not accept a literal key in
command-line arguments, print it in diagnostics, or embed it in an invitation.
The key must already exist: obtain it through the separate protected Uplink
account/provisioning process. Neither installer nor `hello` issues a subscription
key. Persist it only in installation-controlled secret storage with restricted access;
rotation replaces the control credential without replacing Core identity or app
pairings. Installation without Uplink remains supported. Failed provisioning must
not leave the ordinary API unauthenticated or silently advertise remote readiness.

After control authentication, handle provisioning, entitlement checks and remote
capability negotiation succeed, an unclaimed Core can create a remote setup
invitation. Proposed defaults: 256 random secret bits, ten-minute lifetime, one
active invitation, with regeneration invalidating its predecessor. The installer
presents the invitation QR/link through the trusted installation terminal, never
CI logs or telemetry; unattended installation writes a restricted output file.
The invitation is a bearer secret and must be deliberately transferred to the app.

The invitation carries a version, configured Uplink origin, installation handle,
logical Core origin, Core trust material, invitation ID, expiry and purpose
`initial-admin`. The exact encoding and binding to the existing signed pairing
identity must be reviewed before freeze. A fingerprint alone is insufficient if
the existing delegate requires certificate/chain material. Uplink must not provide
a replacement trust anchor. Secrets in links must stay out of HTTP requests,
referrers and analytics; link/QR encoding and app-link handling are freeze gates.

The app uses ordinary remote admission to establish pinned inner TLS, then proves
invitation possession and binds its device using the reviewed pairing handshake.
The invitation secret and any resulting credential travel only inside inner TLS.
While unclaimed, the configured local TLS target exposes a join-only listener:
only bounded enrollment operations are available and normal APIs remain denied.
After atomic claim, Core transitions that listener to normal authenticated access;
neither `session.accept` nor any app routing field selects an administrator API. This restriction is enforced by Core, not by a routing
hint or by expecting Uplink to inspect TLS.

Core atomically checks expiry, purpose and unclaimed installation state, consumes
the invitation and creates the initial administrator/device binding. Concurrent
local and remote setup attempts compete for the same initialization transaction:
only one can succeed. Once claimed, restart, restore of a transport connection,
subscription upgrade and invitation replay cannot reopen initial setup. Additional
administrator devices require existing authenticated administrator authorization.
Recovery from a lost completion response requires proof of the same device key
and enrollment operation; it must not issue credentials to a second claimant.
Credential storage/delivery and recovery transcript are handshake freeze gates.

## Team enrollment and subsequent Remote Control

Team invitation issuance, reservation, `team.join.pending`, local commit and
outbox acknowledgement follow the team proposal. The trusted inviter supplies
Core identity and the bootstrap secret; Uplink learns only the specified public
commitment and routing metadata. Reuse the common TLS transport, but keep the
team reservation and the transport session as separate state machines.

The joining app establishes inner TLS and presents the reserved redemption proof
to Core. Core binds that proof, invitation purpose `team-member`, intended project,
permissions and proved device to the enrollment transaction. Ordinary transport
admission cannot substitute for that reservation or bypass its checks. Before
commit, only enrollment is permitted. The proposed binding is explicit: after reservation, the app adds only
`redemptionId` to `connect` (no bootstrap secret or device bearer). Uplink atomically
binds that unbound live reservation to the generated `sessionId` and forwards
`redemptionId` in `session.request`. Core accepts only a matching locally pending
`team.join.pending` reservation. Both ticket hashes inherit this immutable binding.
The connector supplies session/redemption context out of band to Core's enrollment
handler, never through an app-controlled HTTP header. Inside TLS, the app proves
the invitation and device; Core checks that proof against that exact context.
A bare redemption ID grants no authority. A pre-commit transport failure makes the
binding terminal; a new reservation requires the team redemption/recovery flow,
never rebinding an old ticket. Local commit uniquely consumes the redemption and
records session, invitation and device with its outbox receipt. Post-commit recovery
requires the same device proof and receipt; it cannot create a second membership.
This additive wire/context proposal needs joint review with team V08–V13 before
freeze, including the same-device recovery transcript.

Team redemption can never create an administrator credential, including on an
unclaimed installation. Recheck inviter authority, local invitation state, grant
validity and cancellation at commit. Lost acknowledgement and retries reuse the
same redemption/device binding, as specified by the team outbox protocol.

After enrollment, member devices use ordinary remote admission and their own
Core credentials inside TLS. Core checks current membership and project rights
on each operation. Team eligibility and `remote-control` transport eligibility
are independent: neither implies the other. Entitlement loss closes the hosted
transport; direct member access follows the team contract's signed-grant rules.

### Proposed reservation and locally authenticated connector context

Add a versioned team reservation response to the team bootstrap endpoint:
`{type: "team.join.reserved", invitationId, redemptionId, expiresAt}`. Issue it
only after the team's invitation/redemption eligibility checks; it contains no
Core secret or bearer. The exact endpoint and invitation/device proof remain
team handshake freeze items. Persist the reservation as `reserved` with its
installation, invitation, expiry and redemption identity. `team.join.pending`
carries those same fields to Core. Core persists the pending record before it
can accept a matching session request; a delivery race returns a retryable refusal,
never an unbound acceptance.

At `connect`, Uplink compares the supplied redemption ID with that authoritative
record and atomically changes `reserved -> bound(sessionId)` while creating the
session request. Reject expired, cancelled, foreign-installation or already bound
records; the app's ID alone is not evidence. An attacker who learns the ID can
at most consume a reservation attempt, not prove the inner invitation or device.
Rate limits and bounded fresh reservations prevent unlimited attempt allocation.

Propose a dedicated Unix-domain socket between the connector and Core enrollment
handler. The connector here is the **Core-side outbound connector**, not the
hosted Uplink service. For this proposed deployment profile it runs inside Core
or as a Core-supervised process under the same dedicated, non-root Core service
UID. Hosted Uplink never receives local filesystem access or that identity.
A connector running under a different UID is unsupported by this profile; do not
silently widen access with a shared group, ACL or public proxy.

Core's enrollment handler alone creates, owns and listens on the socket in a
Core-owned 0700 runtime directory, with socket mode 0600. The numeric UID is
selected at deployment, not hard-coded; the allowed peer UID is exactly the
listener's dedicated effective UID in the same OS user namespace. Check the
kernel-reported peer credentials before reading the preface and reject other
UIDs, including root peers, or unavailable credentials. No untrusted app, agent
runner or project process may run under this dedicated UID. UID equality defines
the trusted service boundary, not a claim to distinguish processes sharing it.

After restart only the same supervised connector identity may reconnect. Core
recreates the listening endpoint after ensuring no other Core listener owns it;
never unlink a live socket or follow a substituted path. Previously claimed
session contexts cannot be reused. A listener or connector restart terminates
in-flight enrollment transports; fresh connections require fresh admitted context
and the reservation/recovery rules below. They do not restore old socket claims.
The connector first writes a four-byte big-endian length plus
at most 4096 UTF-8 bytes of strict JSON containing exactly `version: 2`,
`sessionId`, `installationId`, `purpose`, `redemptionId`, `recoveryReservationId`.
Core matches the full tuple to its accepted control record and claims it once, then returns a one-byte
success acknowledgement. Only then does the connector forward the raw TLS bytes
on that socket. Failure closes it before a TLS exchange. The internal preface is
never part of an app-visible TLS stream, public TCP endpoint or HTTP header.
Core terminates TLS normally and associates the enrollment request with that
socket's immutable context. No generic connector destination is app-selectable.
This is a proposed additional trusted local interface requiring joint review;
platforms without the required OS peer checks cannot enable team enrollment.

Pre-commit transport failure terminates that reservation/session binding, not
the invitation. A fresh, rate-limited reservation for the still-valid invitation
may proceed; the old redemption cannot rebind. Core serializes new reservation
acceptance with cancellation and local commit. If the old attempt already committed,
no fresh membership is created: only the same proved device may recover the
existing result using the persisted receipt. `team.join.commit` outbox retries
retain the original redemption ID. Uplink records late committed receipts without
reviving terminal transport sessions or issuing a second seat. Core's transaction
remains authoritative for whether the invitation was consumed. The exact
same-device proof/recovery transcript still requires handshake approval.

## Upgrade an existing pairing to Uplink

Activating Uplink, or a subscription upgrade that enables `remote-control`, causes
Core to provision the route and publish an updated transport descriptor through
its existing authenticated, pinned API. Proposed endpoint:
`GET /api/remote-control/descriptor`, accessible to an authenticated device for
its own connection. The response has a strict versioned schema with `version: 1`,
monotonic persisted `generation`, `enabled`, the service `installationId`,
the configured `uplinkOrigin`,
`installationHandle`, unchanged `coreOrigin`, and negotiated `capabilities`.
An unavailable/disabled descriptor omits routing fields. No tickets, subscription
keys or new Core trust anchors belong in this response. Core emits a descriptor
change notification on the authenticated application event connection; clients
also fetch on authenticated reconnect, so missed notifications are harmless.
Endpoint naming and event envelope are proposals to confirm against Core routes.
### Event-driven entitlement activation (new proposal)

The selected product behavior is push activation over the existing authenticated
control socket. After Uplink commits an effective entitlement change, it sends a
full snapshot without waiting for the next client renewal. Billing notification
receipt alone is not sufficient: the effective service entitlement must already
be committed and admission must enforce it. This is new service work, not current
behavior. Keep the existing renewal cadence; do not introduce 30-second client
polling for upgrade detection.

For peers negotiating `remote-control-v1`, propose this control message:

```json
{"type":"entitlement.changed","installationId":"installation_uuid","handle":"routing_handle","entitlementRevision":42,"features":["remote-control"]}
```

The exact field set is shown above. `features` is the complete current base-protocol
feature set, not an additive delta; an empty set removes all features. Validate
identity and handle using their base schemas. `entitlementRevision` is a persisted,
positive safe integer, incremented atomically for each effective entitlement
change within the service installation binding. It is separate from renewal
epoch, stable control admission identity and Core descriptor generation. Include
the same revision and full feature snapshot in negotiated `welcome` and `renewed`;
`renewed` also carries the current `installationId` and `handle`. Revisions advance
on state changes, not every renewal. Do not send the new event to unnegotiated peers.
Apply the same 16 KiB session-control message bound; field/schema additions require
joint wire review before freeze.

Core accepts snapshots only from its current authenticated control connection
and matching installation/handle binding. Ignore older revisions; equal revision
with identical content is idempotent, while equal revision with different content
is a protocol failure that disables the remote route and reconnects for a fresh
snapshot. Newer revisions replace the complete state, so a revision gap needs no
delta replay. Persist the accepted revision and snapshot; update descriptor state
atomically before publishing its change notification to connected apps. The app
fetches that authenticated descriptor and probes the new route as described below.
Neither this event nor a revision advance renews the lease, changes negotiated
capabilities, grants a Core role or rotates a trust anchor. Admission and forwarding
continue checking current service entitlement independently of Core's snapshot.

Persist a change-delivery intent atomically with the entitlement update (or an
equivalent durable transactional mechanism), then wake the control dispatcher from
the committed change. Retain at most the latest undelivered snapshot per binding;
serialize delivery with connection replacement and bound output queues. A lost
wake-up or dispatcher failure cannot lose the committed state: recover pending
intent on restart and reconcile at ordinary renewal/reconnect. No correctness
claim depends on an in-memory billing callback alone. Successful enqueue is not
proof Core applied the event; every successful renewal returns the latest snapshot.
For a subscription change, determine **every affected installation binding** in
the authoritative store. In the same transaction as the effective change, advance
each affected binding's persisted `entitlementRevision`, store its complete latest
snapshot, and upsert its delivery intent. A subscription-only outbox record without
those per-binding updates is insufficient. Commit all affected bindings together
or roll back; do not publish a partially applied subscription change. Transaction
size is bounded by the enforced installations-per-subscription limit; load-test
that maximum. A future batched rollout needs a separately reviewed consistency
protocol rather than weakening this atomic requirement.

Serialize this fanout with installation creation, ownership/key replacement and
binding removal. A newly created or reassigned binding must take its initial
snapshot from the current committed subscription state under the same authority
check. Removed bindings have their old sessions fenced and pending delivery
cancelled. At dispatch, resolve each binding's live current `controlAdmissionId`
again; never send an old owner's event to its replacement connection. Schedule
delivery to every affected live current control socket. Offline bindings retain
their latest state for welcome/reconnect reconciliation; one disconnected or
slow installation cannot block another binding's dispatch. Coalescing multiple
changes preserves the newest per-binding snapshot and revision. Replacement may
receive that current state through welcome instead of a stale queued event.

Downgrades fence affected sessions at the service immediately on effective change,
regardless of event delivery. Lease expiry and the separately proposed 30-second
external-revocation revalidation remain fail-closed safeguards requiring load tests.

If a new welcome changes installation ID or handle, invalidate the old route and
its revision namespace before accepting the new binding under the lifecycle rules
below. An unexplained revision rollback within the same binding is not silently
accepted: keep remote disabled pending the jointly reviewed recovery procedure.

Healthy connected peers activate after commit, dispatch, descriptor notification
and successful route probe, without waiting for periodic renewal. There is no
zero-latency or offline-delivery guarantee. Record commit-to-dispatch and
commit-to-app-ready latency under the agreed capacity test; Uplink must confirm a
measured target before freeze. Lost events converge on ordinary renewal/reconnect,
whose actual cadence and resulting recovery bound must also be recorded. Offline
apps still follow the existing route-discovery limitations below.

A reissued installation handle, key replacement or subscription ownership change
invalidates the old route: fence old remote sessions, advance the persisted
descriptor generation and publish the new enabled/disabled snapshot. Core must
verify the new binding through its authenticated control connection; a paid-account
change cannot change local users or Core trust. Database loss at Uplink must not
silently leave the previous handle authoritative. This is required new lifecycle
work, not current service behavior.

The app retains its existing server profile, credential, role and trust material.
It rejects a descriptor with a different Core identity or an older generation;
trust rotation uses the existing trusted identity-rotation procedure separately.
Persist descriptor generation with the installation identity, including across
restart. Backup restore and full-host rollback are unsupported in v1, as scoped
in the enrollment companion. No automatic pairing deletion or credential reset
is introduced. Normal stale-descriptor rejection and authenticated binding-change
reconciliation remain required; a restart or upgrade is not a restore trigger.

When enabled, the app automatically tests admission and pinned TLS through Uplink
using a harmless authenticated read. After success, select Uplink for new requests
and reconnect event streams from their application cursor. Drain in-flight direct
requests; never resend an uncertain mutation on the new route. Keep direct access
as an available fallback. If the new route fails, retain a working direct route
and report remote unavailability without asking for new pairing. Pin failures are
terminal for that route, never a reason to relax trust. A disabled descriptor or
revocation removes Uplink as a selectable route without deleting the pairing.

An offline app with a previously trusted descriptor may try its stored route;
Uplink still enforces current entitlement and Core current device authorization.
An app that has never received routing information cannot securely discover it
from a subscription upgrade alone. In v1 it must reconnect directly once or import
a route-only QR/link generated by an authenticated administrator. Treat imported
routing as an untrusted candidate: require user confirmation of the Uplink origin,
preserve the stored Core identity/pin and credential, and authenticate Core before
adopting it. This import grants no role and cannot create another server profile
or replace pairing trust. Automatic account-based discovery is outside v1 and
requires a separately approved identity/discovery design.

## Additional acceptance vectors and implementation packages

| ID | Stimulus | Required observation |
| --- | --- | --- |
| RC15 | Fresh installation with protected Uplink key input | Remote setup works without direct app contact; no key or enrollment secret in logs |
| RC16 | Concurrent local/remote admin claim, replay, expiry, restart | One initial administrator claim; expired/used invitation cannot reopen setup |
| RC17 | Team invitation used for admin setup or another project | Rejected; no broader rights or administrator device created |
| RC18 | Team cancellation/removal/grant revocation races join and active work | No stale membership resurrection; authorized streams/work fenced |
| RC19 | Paid upgrade while paired app is online | Same profile/identity; descriptor fetched, route probed and new requests switched automatically |
| RC20 | Upgrade while app offline, with/without stored descriptor | Stored route revalidated; otherwise direct refresh or explicit route-only import required |
| RC21 | Hostile descriptor/import, stale generation, changed pin | No credential sent before Core trust succeeds; no trust or role replacement |
| RC22 | Route change during mutation or event stream | No duplicate writes; uncertain outcome reported; events resume with application cursor |
| RC23 | Downgrade, handle/key rotation, missed notification | Hosted route revoked/refreshed appropriately; pairing and direct authority preserved |
| RC24 | Lost enrollment response retried by original versus different device | Original device can recover safely; second claimant cannot obtain credentials |

| Package | Core/app deliverable | Uplink deliverable | Exit evidence |
| --- | --- | --- | --- |
| RC-E: first admin | Installer secret input, invitation, atomic claim and recovery | Provisioned route and generic transport, no admin minting | RC15–16, RC24 and reviewed handshake |
| RC-F: team access | Scoped enrollment, project authorization and revocation | Team reservation binding and grant lifecycle | RC17–18 plus team acceptance vectors |
| RC-G: upgrade | Descriptor API/events, route selection and route-only import | Activation/revocation reflected in admission, handle lifecycle | RC19–23 |

Freeze requires agreement on all three access modes and the upgrade behavior,
not only byte transport. Core and Uplink must resolve enrollment proof/encoding,
team reservation binding, descriptor schema/events, handle rotation and generation
recovery explicitly. These are implementation blockers, not permission to infer
new cryptography or ship a partially specified authorization path.

## Revision 4 review handback and targeted fixtures

This revision adopts the Uplink review's `type` envelope, stable connection binding,
transactional paired issuance, two-sided activation barrier, hash retention,
existing data rejection/1008 semantics and `upstream_error`. It also specifies
strict remote validation, bounded lifetime stream IDs, data heartbeat, global
budgets, trusted ingress, protected pre-existing key provisioning, join-only admin
setup and redemption/session binding. Revision 3 corrects `welcome.handle` versus
`welcome.installationId`, requires persisted `controlAdmissionId` rather than the
logging ID, fits proposed remote sub-budgets within current singleton ceilings,
and specifies a protected Unix-domain connector context. Product direction now
selects event-driven entitlement activation, with normal renewals as reconciliation
rather than increased polling. The new event and budgets still require Uplink approval.

Extend the RC matrix with these explicit fixtures before pinning:

| ID | Scenario | Required result |
| --- | --- | --- |
| RC25 | Renew same control socket with pending and active sessions | Lease updates; session/ticket binding survives; ticket expiry unchanged |
| RC26 | Replace control socket then use old accept/tickets/data | Old identity fenced; all old paths denied/closed |
| RC27 | Pair transaction commits; either ticket response is lost | No duplicate issuance; sibling closed by expiry; retry is fresh admission |
| RC28 | First attach succeeds; second expires/cancels; activation races expiry | No early attached; activation rechecks expiry; both sides cleaned up |
| RC29 | Initial admin claim races local setup | One atomic winner; restart and replay do not reopen enrollment |
| RC30 | Handle reissued after database loss/key or ownership replacement | Old route invalidated; generation advances; Core identity preserved |
| RC31 | Team redemption replayed on another session/device | Immutable one-use binding; no cross-session join or second membership |
| RC32 | Spoofed forwarded source, limiter saturation and concurrent admissions | Trusted ingress only; deployment-wide budgets hold without eviction bypass |
| RC33 | One attached enqueue fails; slow queues; missing pong | Pair terminated; bounded buffers; 15/45 heartbeat enforced |
| RC34 | Subscription upgrade with multiple online/offline bindings at maximum subscription size | Every binding revision/snapshot/intent commits atomically; every live current socket is scheduled; app probes without waiting for renewal; measure fanout load and latency |
| RC35 | Duplicate, older, skipped or conflicting entitlement revisions | Idempotent duplicates; stale ignored; complete newer state accepted; conflicting equal revision fails closed |
| RC36 | Lost event, dispatcher crash, binding creation/removal or ownership/control replacement during fanout | No missed or partially committed binding; current owner snapshot reconciles on renewal/reconnect; slow/offline bindings do not block others; no stale-authority delivery |
| RC37 | Downgrade event lost, expired lease or revision rollback | Service fences access independently; event cannot extend lease or silently restore old rights |
| RC38 | Same-UID supervised connector, distinct UID/root peer, unavailable peer credentials, listener/connector restart or reused context | Dedicated Core UID succeeds only with fresh context; other peers fail before preface; handler alone owns listener; restart never restores a consumed claim |

Revision 4 makes the local connector's dedicated Core UID, listener ownership,
peer check and restart behavior explicit. It also requires atomic per-installation
revision/snapshot/intent fanout for subscription changes, serialized with binding
ownership and connection replacement. These are public contract proposals; no
hosted or Core runtime has been changed.

Uplink should review revision 4, especially singleton-compatible numeric budgets,
the persisted admission identity, entitlement event/snapshot schema and delivery
mechanism, and the Unix-domain redemption-to-connector context.
Remaining joint freeze blockers are the exact enrollment encoding/trust material,
reviewed device-proof and same-device recovery transcripts, descriptor event/schema
and normal binding-change reconciliation, and approval of the team binding and
lifecycle rules. Backup-restore design is deferred outside v1.
No implementation begins until both sides approve the revised contract; only then
pin the public Core commit, Uplink contract revision and machine-readable fixture
digest. Existing Apple smoke evidence does not satisfy these new fixture vectors.

## Enrollment revision 2 integration (normative proposal)

The [enrollment companion](uplink-enrollment-v1.md), revision 2 sections
“Trusted enrollment context” and “Separate post-commit recovery reservation”,
forms part of this proposed remote contract. Adopt its version-2 preface and
revised proof transcript together; no version-1 inference or fallback is allowed.
The other enrollment security decisions remain unapproved.

Enrollment `connect` adds `enrollmentPurpose` (`initial-admin` or `team-member`).
It is a routing hint, never authority. Core accepts and persists the trusted
context before replying; initial-admin has empty redemption/recovery IDs, team
commit has its ordinary redemption and empty recovery ID, and team recovery has
the original committed redemption plus a fresh recovery ID. The join-only handler
matches all fields through the protected same-UID socket before receiving TLS.
Already claimed installations can recover an eligible initial-admin receipt but
cannot make another initial claim. Normal paired transport remains unchanged.

The companion's exact schemas for `team.recovery.reserve`, `team.recovery.request`,
`team.recovery.accept`, `team.recovery.refuse`, `team.recovery.ready` and
`team.recovery.cancel` are incorporated by reference. The sole admission exception
is `team.recovery.reserve -> team.recovery.ready -> connect` on one socket.
Recovery connect supplies the purpose and recovery ID, omitting ordinary
`redemptionId`; Uplink derives original redemption/operation from its record.
Do not mix this with a fresh team-join reservation or rebind a committed redemption.

Only authenticated Core attests receipt eligibility. Uplink atomically binds the
new recovery reservation to its owning admission socket, current control identity
and fresh session; tickets inherit that binding. Apply the 15-second Core decision
bound and absolute 60-second reservation lifetime from reserve receipt. Ticket
expiry/activation cannot extend it. Count state from the reserve request in existing
pending budgets, not a separate unlimited pool. At most one live reservation per
installation/redemption/operation is allowed. Core still requires fresh same-device
proof inside TLS; routing approval discloses or creates no credential.

Loss, expiry, restart, replacement or cancellation fences the new transport, not
the original commit receipt. New recovery requires a fresh reservation. The
original `team.join.commit` outbox identity is unchanged. EN13–EN19 supplement
RC acceptance; neither set has executed evidence yet. This integration records
Uplink's transport acceptance, not joint credential/security approval or freeze.
