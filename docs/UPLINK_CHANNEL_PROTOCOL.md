# Uplink Channel Protocol

Companion specification to [ADR 0012](adr/0012-subscription-uplink-for-sharing-and-remote-control.md).
It defines the connections a Verity installation opens to the Uplink to use the paid Public Sharing
and Remote Control features.

This document specifies the wire contract. It does not specify Uplink internals, billing, or the
Kubernetes resources the Uplink creates on the installation's behalf.

**Code read at:** `b03109bf5`. Every statement below about what `packages/preview-tunnel` does or
does not implement — the absent control channel, the frame validator's tolerance of unknown members,
the close codes it sends — was read at that commit, and nothing in CI holds those claims current.
Where an implementation and this document disagree, the *conformance* claims here name the
implementation as the defect; the *build-state* claims are the ones that go stale, and a reader
should re-read the named files rather than trust the marker. Two claims are exceptions in a way
worth naming: the close *codes* and the member-tolerance rule are pinned by tests — the reason texts
deliberately are not, for the reason given where they are described — and the cases covering `1007`
and member tolerance were **added by the change that published these
paragraphs**, so they postdate the marker rather than being readable at it. They are named by title
below, and a rename falsifies this document silently — which is why they are named at all.

## Scope and relationship to the MVP tunnel

`packages/preview-tunnel` currently implements a **per-share** tunnel: one `PreviewEdge` instance is
parameterised with a single `shareId`, and the connector dials that one edge. Frames are
request/response pairs whose body is a single string.

Two consequences make this an insufficient base as-is:

1. ADR 0012 D2 separates one control connection from per-share and per-session data connections, each
   attached by ticket. The current connector is share-scoped and has no control channel at all.
2. ~~The package refuses WebSocket upgrades with `426`.~~ **Landed.** The MVP's response-only
   `response-begin`/`response-chunk`/`response-end` framing has been replaced by the stream framing
   below, and the `426` is gone: an application upgrade now opens a `ws` stream. What the MVP framing
   could not express was exactly the bidirectional `channel` this document introduces, which is why
   the refusal stood until the framing was swapped rather than being bolted onto it.

The framing below therefore replaced the MVP framing rather than extending it. Everything the MVP
does around the framing — passcode and capability handling, hop-by-hop header stripping, body limits,
request timeouts, concurrency caps, proxy-hop trust — carries over unchanged and is not restated
here.

## Transport

Two kinds of outbound WSS connection, per ADR 0012 D2. No inbound listener exists on the installation
for paid features.

**Control connection** — exactly one per installation, long-lived:

- Authenticated with the subscription key (ADR 0012 D3).
- Carries only control messages: handshake, lease, share lifecycle, revocation. No payload.
- The Uplink authenticates with its TLS certificate. The installation pins the Uplink origin; TLS
  verification is never disabled.
- Heartbeat every 15 seconds, as a WSS ping whose matching pong is the reply — no protocol-level
  frame, so a heartbeat cannot queue behind application traffic. Either side may initiate; the peer's
  stack answers automatically. Three consecutive unanswered pings (45 seconds) close the connection;
  the installation reconnects with jittered backoff.
- Reconnect is always safe: no state is assumed to survive a connection. Shares are re-announced by
  the installation after `welcome`.

**Data connections** — Remote Control uses one _per participant_. Public Preview connectors dial
their assigned Edge directly and therefore do not use this ticket attachment. A Remote Control session has two, the app and
the installation, and each dials the Uplink itself: the Uplink relays between them and holds no
connection either side could reuse. A session therefore accounts for two data connections and two
tickets, which is what the admission flow below mints. Connection limits must count it that way:

- Authenticated with a `ticket` issued by the Uplink on the control connection, never with the
  subscription key. A ticket is single-use, short-lived and scoped to exactly one share or session,
  and for a session to one side of it.
- Carry the stream framing below.
- Failure is isolated: losing one data connection affects one share or one device, not the others, and
  never the control connection.

```
→ attach { ticket }
← attached {}
← reject  { reason }        invalid_ticket, expired_ticket, not_entitled
```

Concurrency follows from this rather than from the framing: several shares and several paired devices
are several connections.

## Handshake

```
→ hello   { protocolVersion, subscriptionKey, installationId?, serverVersion, channels[]? }
← welcome { installationId, features[], leaseUntil, limits{...}, channels[]? }   on success
← reject  { reason }                                                on failure, connection closed
```

`reject.reason` is one of `unknown_key`, `revoked`, `expired`, `protocol_unsupported`. The installation surfaces the reason in the app verbatim; it never retries a
`revoked` or `unknown_key` rejection on a timer.

`features` is an explicit allow-list, for example `["sharing", "remote-control"]`. An absent feature
is not enabled, and the client must not infer entitlement from anything else.

**Adding `channels[]` does not bump `protocolVersion`, and the reason is the rule for when it
does.** A version bump is for a change an existing peer cannot survive; this one is survivable in
both directions by construction — an older peer omits the field and a newer reader supplies the
default, a newer peer sends names an older reader does not know and those are ignored. So a newer
peer owes a same-version older peer exactly what the two rules already say and nothing more: honour
the absent-field default, and never open a channel the peer did not advertise. A reader must not
infer capability from `protocolVersion`; `channels[]` is the only statement of it.

**Build state: the handshake below is specified and not implemented.** `packages/preview-tunnel`
has no control channel and therefore no `hello` or `welcome` frame at all — §Scope says so from the
other direction — so `channels[]` is a new member of frames nobody has written yet, and nothing
here declares an existing implementation non-conforming. The stream framing further down *is*
implemented, which is why only that part carries a conformance claim.

Stating that in a public document is deliberate and not in tension with the material this project
withholds. What is withheld is a weakness that is live and unfixed together with the path that
reaches it; an unimplemented protocol member is the *absence* of a feature nothing depends on yet,
and naming it costs an attacker's effort nothing while saving an implementer a wrong assumption.

**Handshake frames ignore members they do not recognise**, and this has to be normative rather than
assumed, because the `channels[]` compatibility argument below rests on it entirely and because the
opposite rule governs `stream.open`'s `channel` value. A reader takes the members it knows and
leaves the rest; it does not reject the frame. The strictness in this protocol is about *values on
a closed set* — a `channel` the receiver cannot serve — not about unknown members on an extensible
frame, and a validator that conflated the two would close the connection on exactly the additive
change the version rule below permits without a bump.

**The same member rule holds on `stream.open`**, and it is stated rather than left to the contrast,
because that frame is where it will next be exercised: a future channel extends `meta`, so a
receiver ignores `stream.open` members it does not recognise exactly as it does on the handshake.
Only the `channel` *value* is closed. A reader who takes "the opposite rule governs `stream.open`"
to mean the whole frame is strict would close the connection on the additive change this section
exists to make survivable.

**This describes the shipped validator rather than changing it, with one exception the validator
already makes and this specification adopts.** `validStreamFrame` in
`packages/preview-tunnel/src/framing.ts` checks the members defined today and tolerates the rest —
its own comment says so — so nothing above declares existing code non-conforming. The exception is
in `isWsAcceptMeta`: a member that belongs to *another* meta on the same closed set (`status`,
`path`, `method`, `headers`) is rejected rather than ignored, because an acceptance carrying a
status line is not an extension but a sender that confused two channels, and reading it as an empty
accept would let that confusion through. "Unrecognised" therefore means *not defined by this
protocol at all*, not *not expected on this frame*.

**That definition is a global one and the exception it carves out is not, so the scope needs saying
in the same breath.** `isWsAcceptMeta` is the only meta that rejects a member for belonging
elsewhere. Everywhere else a defined-but-misplaced member is simply ignored: an HTTP request meta
carrying `status` passes `isHttpRequestMeta`, which checks `method`, `path` and `headers` and looks
at nothing else, and a `ws` open carrying one passes `isWsOpenMeta` the same way — the cross-meta
check only bites on the frame that would otherwise be read as an *acceptance*, where an empty accept
is a valid frame and so a confused sender is indistinguishable from a correct one. Without this
paragraph the two rules above read oppositely on `status` in a `stream.open` request meta: the
member rule says ignore, the definition says `status` is recognised and therefore outside that rule.
Ignore is the answer, and a future channel that wants the narrower rule for its own meta states it
there. Both halves are asserted in `packages/preview-tunnel/src/framing.test.ts` — *tolerates
members it does not define, on the frame and inside meta* and *rejects a misplaced member only where
the frame could be an acceptance* — so a validator tightened to reject unknown members fails the
suite instead of only breaking peers in the field, which is what the `channels[]` argument below
needs from it.

**Both frames also carry `channels[]`, the set of stream channels that peer implements**, and this
is a separate axis from `features`: `features` is entitlement, `channels` is capability. `hello`
advertises what the installation can receive, `welcome` what the Uplink can. **Neither peer may open
a stream on a channel the other did not advertise**, and an attempt is a protocol error on the
sender's side rather than something the receiver has to absorb. An absent `channels` is read as
`["http", "ws"]` — the two channels this specification makes mandatory, which is the reason the
default is those and not the empty set; no peer sends a handshake at all today, so the default is
forward compatibility for the first version that does rather than a description of an installed
base. An old installation therefore needs no
change to be handled correctly by a newer Uplink. **Both are mandatory to implement**, which is
what makes that default safe: were only `http` mandatory, a peer implementing `http` alone could
omit the field, be read as advertising `ws`, and have the far side open a `ws` stream it must then
reject with a connection-scoped close — the failure this whole section exists to avoid. **Present and empty is not that case and is a
protocol error**, rejected at the handshake: absent means "did not know to say", which has a safe
default, while empty asserts "I can receive nothing", which no peer worth completing a handshake
with can mean. Collapsing the two would let a field-dropping bug present as a silent downgrade to
the default set. **An empty *intersection* is the same error reached the long way and is treated
the same**: `http` and `ws` are mandatory, so a conforming peer's advertised set always contains
both, and a reader that intersects to nothing has a non-conforming peer on the other end and
rejects the handshake rather than completing one on which no stream can ever open.

**Both peers can detect these, so both need a way to refuse, and the frame table only gives one to
the Uplink.** `reject { reason }` stays Uplink-only — it is the entitlement answer, and the
installation has no entitlement to pronounce on. An installation that receives an empty or
un-intersectable `welcome.channels[]` therefore **closes the control connection with `1008 invalid
frame`**, the same code it uses for any other malformed frame, and surfaces the failure rather than
retrying on a timer.

**A name in `channels[]` that the reader does not recognise is ignored, not rejected**, and this has
to be said because the opposite rule governs `stream.open`'s `channel` value, under *Stream channels* below. The two are different
situations and take opposite defaults on purpose: an unknown `channel` on a `stream.open` is a peer
opening something this one cannot serve, which is a contract violation and closes the connection; an
unknown name in `channels[]` is a newer peer listing a capability this one has not heard of, which
is exactly the forward compatibility the field exists to provide. A reader takes the intersection of
the advertised set with what it implements and ignores the rest. Applying the `stream.open` rule
here would mean a newer peer could not add a channel without breaking every older one on the
handshake — the failure the field was added to prevent, reintroduced one frame earlier.

This exists because the ordering rule below is otherwise unsatisfiable in the direction that matters.
Installations are self-hosted, so the Uplink cannot wait for every receiver it can reach to upgrade
before it sends anything new — and under [ADR 0012 Amendment
1](adr/0012-subscription-uplink-for-sharing-and-remote-control.md#amendment-1-2026-08-28--remote-web-access-over-the-uplink)
the Uplink is the party that opens the *stream* for an arriving browser. That is a frame on the
existing control connection, not a new connection: the edge signals, and the installation dials the
data connection outbound, so every TCP connection between the two is still installation-originated
and ADR 0012 D2's outbound-only invariant is untouched. "Opens the stream" is a statement about who
sends `stream.open`, and it is worth spelling out because the other reading would describe an edge
that originates a flow into a customer network. Without an advertised set, a
single premature open toward an installation that has not upgraded would close the whole control
connection and drop every concurrent share stream on it (see the channel rules below). With one, the
Uplink simply does not open it, and the browser is refused at the edge instead.

Exactly one **control** connection per `installationId` is live at a time. A second one does not get
rejected — the newest wins and the previous control connection is closed. Rejecting instead would lock
an installation out after any ungraceful disconnect, until the heartbeat timeout expired.

A copied subscription key therefore shows up as two hosts repeatedly displacing each other, which is
observable and can be alerted on, rather than as a legitimate reconnect being refused. Data
connections are unaffected by this rule: there are as many as there are shares and sessions.

That argument only holds if `installationId` cannot be chosen freely, so it is **Uplink-bound, not
client-supplied**. The first `hello` for a subscription key registers the installation and the Uplink
returns the id it assigned in `welcome`; later connections send back the id they were given, and one
that does not match a registered id for that key is rejected with `unknown_key`. A client that invents
a fresh id therefore does not escape displacement — it gets refused. Without this, the displacement
signal could be sidestepped by varying the id, and a copied key would buy concurrent use rather than
a visible collision.

Registering a genuinely new installation on a key that already has one is an explicit operator action
in the Verity account, not something a connection can do on its own. The Uplink additionally enforces
a per-subscription cap on registered installations, so the plan's stated limit is a limit rather than
an accounting convention.

## Lease

`welcome.leaseUntil` is an absolute timestamp. The installation renews before expiry:

```
→ renew   {}
← renewed { features[], leaseUntil }
← revoke  { reason }
```

If a renewal does not arrive before `leaseUntil`, the installation must treat all paid features as
disabled and tear down its own side. This is a client-side *fail-closed* obligation, not an
entitlement decision: the Uplink enforces independently (ADR 0012 D5), and a patched client that
ignores its lease gains nothing because the Uplink stops serving.

`revoke` may arrive at any time — cancellation, key revocation, or the end of a dunning window. It
ends all paid activity immediately.

## Framing

All non-control traffic is carried on **streams**. A stream is opened, carries ordered data frames,
and each direction is closed independently by its sender.

```
stream.open  { streamId, channel, meta{...} }
stream.data  { streamId, seq, payload, meta{...}? }   payload is base64
stream.end   { streamId, meta{...}? }
stream.reset { streamId, code }
```

`meta` on `stream.data` and `stream.end` is channel-specific and optional; only the `ws` channel
defines members today (`opcode` on data, `code`/`reason` on end, below). Receivers ignore members they
do not know, so a channel can add its own without a protocol version bump.

`seq` starts at 0 and increments by one per `stream.data`, counted **per stream per direction** — the
two directions of one `streamId` carry independent sequences. The transport underneath is ordered and
reliable, so `seq` is a consistency check, not a reordering buffer: a receiver that sees a gap or a
repeat has a peer that is out of contract and must `stream.reset` with `protocol_error` rather than
attempt recovery.

`channel` is one of:

| channel | meta | purpose |
| --- | --- | --- |
| `http` | `method`, `path`, `headers` | one HTTP request/response exchange |
| `ws` | `path`, `headers`; the reply direction `protocol` | one WebSocket connection, bidirectional |
| `remote` | — | Remote Control transport |

`http` and `ws` are implemented; `remote` is specified but not implemented. **`raw` is a reserved
name and is deliberately not in the table**, because the table is the set of channels whose
*semantics* this document defines, and `raw`'s are not defined here. An empty `meta` column does not
disqualify a channel — `remote`'s is empty too, and `remote` is in the table because what the
channel carries and how it opens and closes are specified. A conformance checker can implement
every row; it could not implement `raw`. See *Reserved names* below.

The table is the set of channels this specification defines; it is not the set any given peer
accepts, which is what `channels[]` in the handshake reports. A `stream.open` whose `channel` the
receiver does not implement is an **invalid frame**,
not a stream-level fault: channel validation is an allowlist with no default branch to fall through
to, and a receiver closes the connection with `1008 invalid frame` for anything else. That is
already how a current peer behaves: frame validation accepts `http` and `ws` and rejects every
other channel value (`packages/preview-tunnel/src/framing.ts`, covered by the `rejects unknown
channels` case in `framing.test.ts`). **`1008` is deliberate and is not a mislabelled `1007`**: RFC
6455 names 1008 *Policy Violation* and 1007 *Invalid frame payload data*, and a frame this protocol
declines is the former — the payload decoded fine, it just said something the contract does not
permit. 1007 is kept for the case it names, a body that is not parseable JSON, which
`packages/preview-tunnel/src/index.ts` sends as `1007 invalid JSON`. **The code is the contract and
the reason text is diagnostic**, which needs saying because 1008 does not carry one text: the
validator sends `invalid frame`, an out-of-order frame `invalid frame order`, and a reused stream id
`duplicate stream id`. A peer branches on the code and logs the text; a peer that matched on the
text would break on a wording change that breaks nothing else. **Both codes are asserted on the wire, which is
what makes the split a contract rather than a reading.** Four cases in
`packages/preview-tunnel/src/index.test.ts` assert `1008` — the ones named *refuses a
stream chunk whose base64 body is not a whole quantum*, *refuses a stream that ends before it begins
instead of answering an empty 200*, *refuses a stream chunk that arrives before the head*, and
*drops a connector whose stream chunk exceeds the advertised body bound* — and one, *closes a
connector whose frame is not parseable JSON*, asserts `1007`. A change that collapsed either code
into the other would fail the suite, so a peer may be written against the distinction. That is the
channel allowlist, which exists;
the handshake
that would *advertise* the set is the part implemented nowhere, and the two are separate mechanisms
as the paragraph after next sets out. This paragraph writes
that rule down; it does not change it. (Behaviour as read in `packages/preview-tunnel` at the time
of writing. Where an implementation differs from this paragraph, the implementation is the defect:
this document is the contract a peer is written against, and one that closes on a channel the
allowlist admits — or admits one it does not — is non-conforming, not authoritative.)

`remote` is the reason the distinction matters: it is specified above but **not implemented today**,
so a current peer does not advertise it and a current receiver rejects it by the allowlist if one
arrives anyway. Both mechanisms are in play and they do different jobs: the advertised set is what a
correct sender consults, and the allowlist is what protects a receiver from an incorrect one.

Note the consequence of the allowlist half: the failure is connection-scoped, so an unknown channel
drops every stream on that connection, not only the offending one. **An unknown channel is therefore
never something to probe with.** A sender that does not know whether a peer supports a channel reads
`channels[]` from the handshake; it does not find out by trying.

That is what makes the rollout ordering satisfiable rather than aspirational. **A sender must not
emit a channel absent from the peer's advertised set** — which, for a mode crossing the edge, is
enforceable by the edge without any assumption about which version a given self-hosted installation
runs. The obvious alternative — "do not emit a new channel until every receiver it can reach
implements it" — is correct in intent and unsatisfiable in practice, which is why this specification
does not state it: for an open-source, self-hosted fleet there is no moment at which every receiver
has upgraded, and Amendment 1 puts the Uplink on the sending side. Adding a mode is still a coordinated change — the receiver has to implement and
advertise it before the sender can use it — but a premature sender now degrades to "the feature is
unavailable for that installation" rather than to a dropped control connection.

### Reserved names

`raw` is **reserved and not specified**. It has no defined semantics, no lifecycle, and no
implementation, and it is deliberately kept out of the channel table so that nothing reads it as a mode to accept. The
reservation buys naming, not enforcement: it records that this specification owns the name, so a
later implementation neither invents a different one for the same mode nor reuses `raw` for
something else. **Until `raw` is specified**, a peer must not advertise it in `channels[]` and must
not open it. The two prohibitions have different enforcement, and conflating them would put a
`hello` and a `stream.open` on the same footing when the rules above deliberately separate them: a
`raw` in `channels[]` is a name with no implementation behind it and is **ignored**, intersected
away exactly as an unrecognised name would be — the reservation gives a reader the name, not a
reason to treat it differently —
while a `stream.open` on `channel: "raw"` is an unimplemented channel and is an **invalid frame**
that closes the connection. A peer that advertises `raw` today is non-conforming, but a receiver
does not drop its control connection over it. Specifying it is what lifts that restriction — the reservation is a placeholder for a
future section of this document, not a permanent prohibition, and shipping the mode
[ADR 0012 Amendment 1](adr/0012-subscription-uplink-for-sharing-and-remote-control.md#amendment-1-2026-08-28--remote-web-access-over-the-uplink)
describes means writing that section rather than contradicting this one.

**Proposed, not specified here:** serving the web client remotely over the Uplink requires a fourth
mode, `raw`, carrying opaque bytes rather than HTTP-aware framing, so that the edge splices a TLS
connection without terminating it. Its `meta` members and lifecycle are not specified until the
decision is accepted, and until then it is an unimplemented value that every receiver rejects as an
invalid frame under the rule above — on a `stream.open`, reserved means rejected rather than
defaulted to some fallback mode, while in `channels[]` it stays merely ignored, as the paragraph
above splits them. The design behind it is
not disclosed here beyond that sentence; it is already public in
[ADR 0012 Amendment 1](adr/0012-subscription-uplink-for-sharing-and-remote-control.md#amendment-1-2026-08-28--remote-web-access-over-the-uplink),
together with the L4 SNI listener it needs. Nothing in `http`, `ws` or `remote` changes; the note
exists so that this specification does not read as a closed set while a further mode is under
consideration.

No `shareId` appears in stream metadata: the ticket already scoped the data connection to one share or
one session, so repeating it would be a second source of truth the Uplink would have to reconcile.

On the `http` channel a response reuses the same `streamId` in the opposite direction, opened by the
peer with `meta.status` and `meta.headers`. That second `stream.open` is required, not optional: it is
the only frame that carries a status line, so there is nowhere else for one to go.

The `ws` channel works the same way: the responding hop opens the reply direction with
`meta.protocol` — the subprotocol the target selected, absent if none — and that open **is** the
acceptance. Without it the dialling hop would have to answer its own client before knowing whether
the target agreed at all, which loses two things: a refusal would surface as a connection that opened
and then closed rather than one that failed, and the subprotocol would have to be guessed, leaving
the two endpoints believing they had agreed on different ones. For the same reason the dialling hop
must not send `stream.data` before the acceptance arrives — it has no client of its own yet, and a
peer that does anyway is asking the responding hop for an unbounded buffer.

`remote` opens once and has nothing to report back, so its responding side answers with `stream.data`
on the id already opened.

In every case the two directions of one `streamId` are sequenced independently. Streams are independent
of each other too: a slow upload never blocks another share.

`stream.end` is a **half-close**: it ends the sending side only. A client that has finished its
request body sends `stream.end` and keeps receiving the response on the same `streamId`; the stream is
fully closed once both directions have ended, or at any point by `stream.reset`. Treating `stream.end`
as a full close would truncate every response whose request body ends first — which is all of them.

This is what makes SSE and WebSockets expressible. SSE is an ordinary `http` stream whose
response never ends until `stream.end`. A WebSocket is a `ws` stream carrying frames in both
directions.

For `ws`, one `stream.data` carries exactly one WebSocket message, so boundaries survive the relay
rather than being re-fragmented into a byte soup. `meta.opcode` on each `stream.data` distinguishes
`text` from `binary`; continuation frames are reassembled by the sender before relaying, and ping/pong
stay local to each hop rather than being forwarded. The WebSocket close handshake maps to `stream.end`
with `meta.code` and `meta.reason` so the peer's close status reaches the other endpoint intact;
`stream.reset` means an abnormal close.

A hop that is still waiting for an acceptance has a client stuck mid-handshake, so it reports a
failure as an HTTP status on the raw socket — `504` for its own deadline, `502` for a reset from the
far side — rather than as a close frame the peer could not yet interpret. `Sec-WebSocket-Protocol`
is checked against its grammar before the open frame is sent, and a list that is not distinct tokens
is refused with `400`: it can never be answered, and the far hop's own WebSocket client rejects such
a list by throwing, which is a poor thing to hand a frame handler.

`stream.reset` codes: `timeout`, `client_gone`, `body_limit`, `concurrency_limit`, `share_ended`,
`upstream_error`, `protocol_error`. `client_gone` is how a hop reports that the endpoint it was
relaying for went away — a browser tab closed mid-response — so the far side stops pulling from the
target for a reader that no longer exists. Without it that case has to borrow a code that names a
different fault, and the far side cannot tell an abandoned stream from a broken one.

A hop that cannot write as fast as it is being fed never queues without a bound. Which answer it
owes depends on which socket is backing up. When the congested socket belongs to the stream alone —
a browser or a target that has stopped reading — the stream is reset (`client_gone` towards the
target, `upstream_error` towards the browser), because the only source of those frames is the
channel connection, which carries every other stream and cannot be paused for one of them. When the
congested socket is the channel connection itself, the stream's own endpoint is paused instead and
resumes once the backlog drains, which pushes back on exactly the peer that is running ahead and
leaves the other streams flowing.

## Share control

```
→ share.create { requestId, duration, pinHash }
← share.ready  { requestId, shareId, publicOrigin, edgeUrl, expiresAt,
                 connectorToken, sessionSecret }
← share.error  { requestId, code }

→ share.remove { requestId, shareId }
← share.removed{ requestId, shareId }
← remove.failed{ requestId, shareId, code }

← share.expired{ shareId }                  Uplink-initiated at duration end
```

The Uplink creates the share id, connector token and browser-session secret, and creates the public
edge and routing before replying. The installation never names Kubernetes objects and never learns
cluster topology. It passes the opaque connector token to its short-lived connector container, which
dials `edgeUrl` directly. `connectorToken` and `sessionSecret` are returned only on the create reply,
must never be logged, and are persisted only through Verity's encrypted share store.

Every request carries an opaque `requestId`; its terminal response echoes it so concurrent creates
and removals on the single control connection cannot be confused. `share.remove` and
`share.removed` carry the same `requestId` in addition to `shareId`.

`share.error` codes: `not_entitled`, `limit_reached`, `invalid_target`, `duration_rejected`,
`internal`.

`remove.failed` reports a failed idempotent removal and carries the original `requestId` and
`shareId`; clients retain the local revocation record and retry during reconciliation.

Duration is validated Uplink-side against the confirmed set (15m, 1h, 2h, 4h, 8h). A client asking
for anything else receives `duration_rejected`; the client-side list is convenience, not policy.

## Remote Control

Each Remote Control session uses its own data connection, attached with a ticket. The Uplink relays;
it does not interpret.

**Several devices may be connected at the same time.** Each paired device gets its own data
connection, its own key pair (ADR 0012 D9) and its own end-to-end session; nothing is shared between
them beyond the installation's control connection. `limits.maxConcurrentSessions` must be generous
enough for a user's normal set of devices — it exists to bound abuse, not to ration devices.

The one-control-connection rule applies to the **installation**, never to devices.

Per ADR 0012 D9 the payload is **end-to-end encrypted between app and installation**. The Uplink
relays ciphertext and cannot read it.

Keys are established during the direct first-run pairing, which does not traverse the Uplink: the app
is pointed at the installation, the master password is set, and the app records the installation's
public key. The existing guidance already requires that this happens on a trusted network, so no new
trust anchor and no operator-provisioned secret is introduced.

The framing needs nothing special for this — `stream.data` payloads are opaque to the Uplink either
way. What it does require is that the Uplink never needs to inspect `remote` payloads to route them:
`streamId` and the connection identity are sufficient.

### Admitting a session

Per ADR 0012 D12 the Uplink cannot authenticate the app, so it does not try. It checks entitlement and
asks the installation:

```
App    → Uplink         connect { installationHandle }
Uplink                  entitlement check; refuse here if the subscription does not cover it
Uplink → installation   session.request { sessionId }        on the control connection
installation → Uplink   session.accept  { sessionId }
                        session.refuse  { sessionId, code }
Uplink → installation   session.ticket  { sessionId, ticket } on the control connection
Uplink → App            ticket, or a refusal
installation → Uplink   attach { ticket }                    new data connection
App    → Uplink         attach { ticket }                    new data connection
App    ↔ installation   end-to-end handshake, per-device token verified inside it
```

A session needs **two** data connections, so the Uplink mints two tickets from one `session.accept` —
one handed to the app, one pushed to the installation on its control connection. Both stay
Uplink-issued and single-use, per the ticket rule above; the installation dials outbound like it does
for a share, which is what gives the Uplink a relay endpoint on the installation side at all.

The Uplink decides *whether the feature is paid for*. The installation decides *who may drive it*,
inside the encrypted channel, using the per-device token it already issues. Neither replaces the other,
and no device identity is registered with the Uplink.

Two consequences the implementation must handle:

- `connect` is unauthenticated by construction, so the Uplink rate-limits session requests per
  installation. Otherwise anyone could make an installation field requests indefinitely.
- `installationHandle` is a random value learned during pairing, never a sequential identifier. It
  grants nothing by itself; it prevents the set of installations from being enumerated.

## Limits

`welcome.limits` carries at least: maximum concurrent shares, maximum concurrent streams, maximum
body bytes, and request timeout. The installation applies them locally as an early guard; the Uplink
enforces them regardless. Limits exist for abuse containment, not billing (ADR 0012 D11).

## Errors and closure

- Protocol violations close the connection with `protocol_error`. There is no partial-tolerance mode.
- The installation must survive an abrupt close without losing local state, and must not retry a
  terminal rejection.
- On close, all streams are implicitly reset. Shares are re-announced after the next `welcome`,
  which lets the Uplink reconcile rather than trust client state.

## Required changes in `packages/preview-tunnel`

1. ~~Replace request/response framing with the stream framing above.~~ **Landed.**
2. ~~Remove the `426` refusal, implement `ws`, and widen streamed `http` beyond Server-Sent Events.~~
   **Landed.** The MVP streamed only responses declaring `text/event-stream` and buffered everything
   else inside the request deadline. The `http` stream is no longer content-type-conditional: every
   response streams, and the request deadline now bounds the time to the response head rather than
   the exchange. An exchange still running at that instant moves from the request budget to the
   stream budget, so a long-lived response cannot starve ordinary page loads and is not killed for
   being long either.
3. Keep both halves open source. ADR 0012's boundary table and migration list keep the preview edge
   open (operated by us) because it carries no entitlement logic — only the Uplink itself is closed.
4. Split the connector's single per-share edge dial into the two connection kinds above: one
   installation-scoped control connection, plus a data connection per share dialled with the ticket
   that connection hands out. Stream metadata stays free of `shareId` — the ticket already scopes it.

Items 1 and 2 were required by the confirmed product decisions independently of ADR 0012 and were
done as one piece of work. Item 4 is deliberately not started: tickets are issued by an Uplink that
does not exist yet, and the frames it needs are the ones above — only the dial and the attach change.

## Version compatibility

`protocolVersion` exists because installations are self-hosted and open source: we cannot force an
update. Whenever this contract changes, older installations keep speaking the older version until
their operator upgrades, so the Uplink must accept more than one version at a time.

The window is **N/N−1** — the current version and the one before it — matching the runner and toolkit
compatibility rule in ADR 0006 D9. An installation on an older version receives
`reject{ protocol_unsupported }` and the app tells the user to update.

Practical consequence: a breaking change to this contract must ship Uplink-side support for both
versions before the client change is released, and the old version may only be dropped one release
later.

## Open questions

- **Isolation manifests for D10.** The decision and the starting quota values are settled in the ADR;
  the manifests themselves are not written.

D9 needs nothing further on the wire: the installation is its own CA, the app pins the root, and leaf
rotation is an ordinary chain validation. Root and leaf lifetimes are an implementation choice, not a
protocol one.
