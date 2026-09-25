# ADR 0014: Secret tools on ACP are approval-gated, not attested

- Status: accepted (2026-08-08)
- Relates to: ADR 0011 (pragmatic secret brokerage), ADR 0012 (agent transport over ACP v1)
- Source material: `docs/ACP_ATTESTED_TOOL_CHANNEL_DESIGN.md`

## Context

ADR 0012 withheld Verity's brokered secret tools — `verity_http_request`,
`verity_secret_run`, `verity_secret_job` — from the ACP transport, and named the
condition for lifting that: "an authenticated HTTP-MCP tool channel with a
per-turn token". `docs/ACP_ATTESTED_TOOL_CHANNEL_DESIGN.md` then showed that
condition is not sufficient, and asked for a decision between three options: **A**
build correlation attestation on HTTP-MCP, **B** wait for `mcpCapabilities.acp`
upstream, **C** do not flip at all.

§7 of that document made option A conditional on one measurement: whether
`codex-acp` carries a per-call identity comparable to the `claudecode/toolUseId`
that `claude-agent-acp` puts in MCP `_meta` (M3). "If `codex-acp` carries no
equivalent call identity, A collapses back to payload correlation for the backend
that matters and option B becomes the only path."

That measurement has now run. The container has a Codex credential, a turn was
driven end to end against `codex-acp`, and the result closes option A:

- The MCP `tools/call` request carries `_meta` with `x-codex-turn-metadata`,
  `threadId`, and `progressToken`. **None of them is the ACP `toolCallId`** of the
  same call (`exec-…`), which appears nowhere in the request. `threadId` is stable
  per session and `x-codex-turn-metadata` per turn, so neither separates two calls;
  `progressToken` is an MCP-internal request counter, which does separate them but
  is never visible on the ACP side, so it correlates nothing across the two
  channels. Either way there is no shared per-call key.
- `mcpCapabilities` is `{ acp: false, http: true, sse: false }` — the ACP-hosted
  channel option B needs is still unavailable on the adapter that carries the
  tools.
- Ordering was favourable — ACP `tool_call`, then `session/request_permission`,
  then the MCP arrival — but the probe auto-approved, so the *barrier* is
  unproven. Nothing measured shows the adapter would actually wait for a held
  permission answer.

So a correlation that binds an MCP call to the ACP call it claims to be is not
constructible on `codex-acp` today, and option B depends on upstream work that has
not started. Taken at face value that leaves option C — ship nothing — which
freezes the secret tools on a native backend that is being retired in favour of
ACP.

The operator's decision is not to accept that freeze. Verity is not trying to be
unbreakable; it is trying to be honest about what it guarantees. A channel that
never resolves a secret without an operator decision covering that call — a card
answered now, or a standing grant the operator created earlier and that expires
within a day — is worth shipping even when the decision cannot be
cryptographically bound to the call that triggered it.

## Decision

### D1 — Ship the secret tools on ACP over HTTP-MCP, without correlation attestation

Verity hosts a loopback HTTP MCP server per session, configures it through
`session/new`, and serves the existing backend-neutral tool implementations from
it. The per-session bearer token authenticates the endpoint against unrelated
callers. It is **not** treated as a security boundary against the workspace: M4
already showed `claude-agent-acp` publishes the configuration on its child's
command line, and same-UID repository processes read it out of `/proc`.

The offering path may legitimately withhold the gateway — an adapter that does not
advertise HTTP MCP would be handed a server it can never call — but it must never
withhold it *silently*. A turn that was minted a bearer and starts with an empty
`mcpServers` list has to be told, or fail:

- The agent does not speak HTTP MCP: the tools are withheld as before, and the turn
  receives a system-prompt directive naming the reason. It must report that reason
  rather than hunt for a substitute credential, socket, or CLI.
- The Sandbox has a bearer but no `VERITY_MCP_GATEWAY_URL`: the container was
  provisioned without the endpoint, which no retry or prompt can repair, so the
  worker refuses the turn.
- The Server has a gateway-eligible ACP turn bound to a session but no bearer
  registry: a composition fault, refused at runner construction.

This mirrors the serving side, which already treats a missing control-plane tool
executor as an error rather than an empty tool list. A session whose role names
tools its `mcpServers` list does not contain reads the gap as its own failure to
find them, and starts looking for a way around it — which is the one response an
absent brokered channel must not provoke.

### D2 — Operator approval is mandatory on this path and cannot be waived by configuration

No configuration, flag, or backend profile disables the approval for
`verity_http_request`, `verity_secret_run`, or `verity_secret_job` on the ACP
channel. The invariant is **no secret is resolved and no execution begins without
a live operator decision covering that call**, regardless of where the call
originated. This is the property that carries the security on this path; it is the
one thing that must not be optional.

It is phrased that way rather than "an uncovered call is rejected" because the
three tools do not gate at the same moment. `verity_http_request` and
`verity_secret_run` block on the decision inline, so for them an uncovered call is
indeed rejected. `verity_secret_job` returns an approval id immediately and the
operator answers out of band: an uncovered job is *accepted as pending* and never
executed. Same guarantee, reached by a different route — the tool call may
succeed, the secret does not move.

For `verity_http_request`, "covered by a live operator decision" includes a
standing grant, which is a delegated approval and not a contemporaneous one — see
D3 for the limit that puts on it. `verity_secret_run` deliberately has no reusable
grant target: every invocation requires a contemporaneous decision covering the
complete command and secret-injection request. Only the operator can approve
either form; nothing the model or the workspace does can.

### D3 — Standing grants on the ACP path expire after 24 hours, and `forever` is unavailable

This covers `verity_http_request`, the tool for which the grant store can derive a
reusable target. `verity_secret_run` remains consistent with ADR 0011 D4: generic
CLI arguments can load code through tool-specific configuration that an argv
digest cannot model safely, so it has no standing scope and every invocation asks.
`verity_secret_job` likewise has no grants; it is approved per job.

The ACP ceiling therefore applies to the HTTP tool. On a channel that
cannot prove which call it is answering, an unbounded grant is an unbounded
delegation. Therefore:

- A grant auto-approves on the ACP channel only if it was **approved on the ACP
  channel**, within the last **24 hours**, regardless of the scope it was created
  with. An approval given on the native path never satisfies the ACP check — not
  because it is stale, but because it is not an ACP decision. The operator answered
  a card that told them their agent was asking, on a channel where that is
  established; D4 requires the ACP card to say something weaker, and consent given
  under the stronger disclosure is not consent to the weaker one.
- Scope `forever` never auto-approves on the ACP channel, **and is not offered on
  it**. The ACP card does not present the choice and the server rejects it if a
  client sends it anyway. Auto-redemption alone would not be enough: an ACP
  approval that created a permanent row would mint a native-path `forever` grant
  from a decision taken on the weaker channel, which is the same delegation
  arriving by the back door. Pre-existing `forever` grants keep working on the
  native path, where they were granted. The card offers `forever` only when the
  prompt says `native` outright: a prompt with no channel on it — persisted before
  the field existed, or raised by a server on the other side of a rollout — gets the
  restricted offer, because the card cannot tell which transport raised it and the
  server refuses the standing scope when it cannot resolve one either. Offering the
  one scope that is certain to be refused is precisely the failure the channel is
  carried to the card to remove.
- The rule runs in **one direction only**: a grant approved on ACP still
  auto-approves on the native path, and a `project` grant re-approved there still
  renews its 30-day window for both. That is not an oversight. Native redemption
  is attested, so answering it with a grant the operator approved under the weaker
  ACP disclosure gives them no less than they already consented to on the channel
  they answered — the asymmetry exists because the guarantees are asymmetric, not
  because the decision is. Requiring a native approval record in the other
  direction would additionally kill every grant made before this ADR, none of
  which has one and none of which may be backfilled (below). `forever` is the case
  where that reasoning does not hold, which is why it is refused on ACP outright.

The check is therefore against **approval records keyed by grant and channel** —
one row per (grant, channel), each with its own timestamp — not a pair of columns
on the grant. A single `last_approved_channel` would be overwritten by the next
native approval and would silently invalidate a still-live ACP one, which is the
same class of bug as reusing `updated_at`. Records are written only by paths
carrying an actual operator decision, and the ACP redemption passes only when a
record exists for the ACP channel and its timestamp is inside the window.

Grants that predate this have no such record and do not auto-approve on ACP; the
first ACP card creates one. Do not backfill from `created_at` — a project grant renewed in place
last week still carries a month-old creation time, so a backfill misdates
decisions in both directions, and the direction that matters is a stale row
reading as fresh. Nothing is lost by starting empty, since no existing grant has
ever been redeemed on a channel that does not exist yet. Nor is `updated_at` a
substitute: that field is maintained by whatever happens to touch the row —
revocation writes it today — so a future bookkeeping update would silently extend
ACP access by a day without anyone deciding to. A security clock reused as a
bookkeeping clock eventually gets wound by bookkeeping.

The approval path has to write these for **every** scope, which it did not do when
this was decided: the store's `grant()` (`createBrokeredHttpGrantStore`,
`packages/server/src/brokered-http-grants.ts`) refreshed only `project` rows, and
a re-approval matching an existing `session` or `forever` row returned without
writing anything. A ceiling read off a field the approval path does not maintain
expires grants the operator just renewed, which trains people to grant more
broadly, not less. `grant()` now records the approval on every scope, which is
what makes re-answering an ACP card restart the window for a `session` grant.

The ceiling is enforced at **redemption**, not at creation. A `forever` or 30-day
project grant stays exactly as valid as it was on the native path; it is simply
not an answer to the ACP question.

Enforcing at redemption rather than creation is the whole point: the two channels
have different guarantees, so the same stored grant must mean different things
depending on where it is presented.

Which makes "the channel" a security value, and it must be derived from how the
request reached the server — the session's configured transport and the listener
the call arrived on, which are server-side state — and **never** from the request
itself. Not an MCP parameter, not `_meta`, not a header, not anything the caller
supplies: a workspace process that can name its own channel simply says `codex`
and redeems the `forever` grant this decision exists to keep away from it. If the
channel of a call cannot be established from server state, the call is not on a
known channel and does not auto-approve. Today that derivation is
`brokeredGrantChannel(backend)` (`packages/session/src/backend.ts`), read off the
backend object the Conductor resolved for the turn; the listener half is added
with the loopback MCP gateway, which is what makes a second listener possible at
all.

That derivation **enumerates the native channel and defaults everything else to
ACP**, rather than the reverse. Only the two attested native runner protocols
(`claude`, `codex`) are `native`; an unrecognised protocol and a backend that
declares none at all are both `acp`. The absent case matters because
`runnerSupervisorBackend` is optional, so "this backend has no attested transport"
and "a wrapper rebuilt this backend and dropped the field" are indistinguishable at
the point of decision — and the Server does re-spread that field conditionally when
it builds a backend for a Sandbox turn. Reading absence as `native` would let a
future wrapper hand itself the attested channel's unbounded grants by omission.
Reading it as `acp` costs nothing today: every genuinely native backend declares
the field, and OpenCode, which omits it on the loopback path, has no
permission bridging, so they raise no brokered prompt to redeem a grant against.

**What the grant costs, stated plainly.** While a grant is live, matching calls
auto-approve with no card, and the channel cannot tell a call the model made from
one a workspace process made with a stolen endpoint and token. So a thief who
reads the credential out of `/proc` and finds a matching grant already in place
gets that tool executed, up to the grant's remaining lifetime, without the
operator seeing anything at the moment it happens.

Do not expect the ACP transcript to record that. A stolen-endpoint call goes
straight to the loopback MCP server and never passes through the adapter, so no
ACP `tool_call` is emitted for it — the transcript shows exactly the calls the
model made, which is precisely the set this attack is not in. So **the MCP gateway
persists its own audit event for each `tools/call` it serves**, recording the tool
name, a keyed request MAC, whether a card was shown or a grant matched, and the
outcome. Without it the only record of these calls is the one channel the attacker
skipped.

Because it is the only record, it is written **before** the secret resolves, and a
write that fails rejects the call rather than proceeding unlogged — the same
persist-before-publish ordering Verity already applies to canonical events. An
implementation that executes first and logs after has, on the one crash that
matters, executed a secret-bearing call with no trace of it. The outcome is a
second event against the same record; a call whose start is logged and whose
outcome never arrives reads as indeterminate, which is the correct reading of a
crash mid-call and is why the two are separate writes rather than one.

The event is a safe projection, under the same rule as every other audit row:
raw argv, provider keys, ciphertext, and secret values are excluded, and this event is not
an exception to it. That
matters more here than elsewhere, because these parameters are attacker-supplied
by construction — the whole premise is a caller Verity did not authenticate — so
persisting them verbatim writes attacker-chosen bytes, possibly including a
credential they are trying to launder, into durable storage.

So: record the validated scalar fields the approval card already displays, and
identify the request by a **keyed MAC over its complete canonical form** — for
`verity_secret_run` that includes argv, which is exactly the part §3.4 forbids
storing and exactly the part that distinguishes two invocations. A plain digest
will not do double duty here. Unkeyed, it is a durable verifier to guess against,
and the values in reach (a short token, an account id, a command line) have little
enough entropy for that to be a real recovery path rather than a theoretical one;
narrowed to the non-argv fields to avoid that, it stops distinguishing the calls
it exists to distinguish, and two different `verity_secret_run` executions
reconcile against one transcript entry. A server-held key gives both properties at
once: the record separates distinct requests and is useless to whoever supplied
them. A rejected malformed body records the rejection reason and no MAC at all —
there is nothing to reconcile it with.

The key never leaves the server, and it is **durable and versioned**: stored
alongside Verity's other server-held key material, with a key id written into
every audit event. An ephemeral per-process key would make every record before the
last restart incomparable with every record after it, which is the same as not
having them, and reconciliation is precisely the after-the-fact work these records
exist for. Rotation is additive for the same reason — a new key gets a new id and
old events stay comparable among themselves, so rotating does not quietly retire
the history.

Be exact about what that record can support. It proves a call was served, matching
a given request MAC, under a given decision. It does **not** attribute the call: there
is no per-call identity shared between the two channels — that absence is M5, the
finding this whole ADR rests on — so no gateway event can be matched to the ACP
`tool_call` it claims to be. What reconciliation can do is compare the two sets:
gateway calls the transcript has no counterpart for are an anomaly worth an alert,
and that catches the careless case. It does not catch the careful one, because
payload correlation is exactly what front-running defeats (design doc §6) — an
attacker who copies the parameters of a call the model is about to make produces a
gateway event that reconciles cleanly. Treat the audit record as evidence, not as
attribution, and do not let a UI imply otherwise.

That is the residual risk the 24-hour ceiling exists to bound, and it is why
`forever` is unavailable here: on the native path a permanent grant delegates to a
channel that can prove which call it is answering, and on this one it would
delegate to anything that can reach a loopback port. Operators granting on the ACP
path are choosing a bounded window in which a workspace compromise inherits their
approval — the card should say so, in those terms.

### D4 — The approval card shows server-side parameters, and does not claim who asked

The card renders the parameters the server received on the MCP channel, not the
ones the model announced over ACP. Where those disagree, the operator sees what
will actually execute. Verity cannot prove the two describe the same call; it can
make sure the human approves the one that runs.

The card is where the whole guarantee is spent, so it must not overstate what it
knows. On this channel Verity cannot establish that the request came from the
model rather than from a repository process holding the endpoint, and the two are
indistinguishable at the gateway. A card that says "**Claude** wants to send
`STRIPE_KEY` to …" therefore asserts something unverified, and the operator's
whole basis for approving is the belief that their agent is mid-task. The ACP card
attributes to the session, not to the agent, and says plainly that a process in
the workspace can produce the same request. If that makes the card read as less
reassuring than the native one, that is accurate — the channel is less
trustworthy, and hiding it in the copy would move the risk from the design onto a
person who cannot see it.

### D5 — Stop calling this "attested"

ADR 0012 invariant 6 uses "attested" for the native Codex relay, where two independent
channels agree. The
ACP channel does not have that property and this ADR does not claim it. The
supported wording for the ACP path is **approval-gated**. Any UI, document, or
commit message that calls it attested is wrong.

### D6 — Option B stays open

`mcpCapabilities.acp` is still the structurally better channel — no endpoint, no
token, no payload correlation to front-run. This decision does not retire it; it
removes it from the critical path. If it lands upstream, it replaces this channel
and D3's ceiling can be revisited.

## Consequences

### Hash-bound interpreter entry scripts

`verity_secret_run` keeps the executable boundary root-owned, but may execute a worktree entry
script through that interpreter when the request explicitly carries the script's absolute path and
SHA-256. The approval card shows the executable, arguments, entry-script path, digest, and every
secret alias. The privileged broker resolves the path inside the project worktree and verifies the
current bytes against the approved digest immediately before launch, then executes a broker-owned
snapshot. The snapshot mirrors the script's worktree-relative location. Dynamic one-time runs link
its sibling resources back to the worktree; isolated reusable runs expose no such mutable files.

A reusable grant is keyed by project and provider binding, the complete command, the sorted alias
set, the entry-script path, and the complete SHA-256. Changing any one of them returns to approval.
Only a directly named entry operand with `loading: "isolated"` is reusable. A Landlock read policy
allows the broker snapshot, root-owned system paths, and only the exact secret files materialized
for that invocation, but
denies the mutable worktree; transitive worktree code therefore cannot ride an old grant. A script
that imports, sources, or otherwise reads worktree files uses `loading: "dynamic"` and is one-time.
Directory arguments after that approved script may name directories inside its worktree, such as
`--input-dir dist` for a prepared deployment bundle. This follows the same dynamic-read boundary:
the broker resolves symlinks before checking the directory, and directories outside that worktree,
unattested invocations, and isolated scripts retain the ordinary operand checks.
Eval/inline code, stdin, module lookup, and preload flags are one-time as well. This is an
execution-integrity decision, not Doppler secret classification: aliases remain opaque project
secret names.

The isolated form accepts interpreters resolved under `/bin` or `/usr`; other root-owned executables
remain available to dynamic one-time runs. Runner startup probes the host kernel's Landlock ABI and
fails provisioning before advertising brokered tools when the enforcement primitive is unavailable.

- The secret tools become available on the transport Verity is migrating to,
  rather than only on the native backend it is retiring. That is the point of the
  decision.
- The guarantee on the ACP path is weaker than on the native Codex path, and is
  stated as such rather than papered over. A workspace process that reads the
  endpoint and its token can call the tool. An HTTP call with no grant gets a card
  the operator did not expect, which interrupts them at the moment it happens;
  with a matching grant in place it gets the tool executed silently inside that
  grant's window. Silently is not invisibly — the gateway audit record of D3 has
  the call either way — but that record shows a call happened, not who made it, and
  the difference between "you are asked now" and "you can find something in a log
  later" is the whole cost of granting on this channel. A trusted CLI call always
  gets a card and never runs under a standing grant.
- HTTP approval fatigue is bounded by the 24-hour grant rather than by a 30-day or
  permanent one. Long-running unattended automation on the ACP path will ask again
  daily. That is an accepted cost, and the flip side of the exposure D3 describes:
  a shorter ceiling would be safer and more annoying, and 24 hours is where the
  operator drew that line.
- The gateway audit record of D3 is load-bearing rather than a nicety: it is the
  only place a call the model did not make can appear at all. It has to be written
  for every served `tools/call`, including rejected ones, and the existing audit
  schema has no event for it — there is a contract to define, not just a log line
  to add. It is evidence and not attribution, and the implementation must not be
  built as though the two were the same thing.
- Two channels with different grant semantics now share one grant store, which is
  a correctness risk if the redemption check is ever bypassed. It needs a test that
  a native-path `forever` grant does not auto-approve on ACP, not just a code
  comment.
- ADR 0012's flip condition is superseded by this ADR; that document is updated to
  point here rather than to keep naming a condition that cannot be met.

## Amendment 2 (2026-08-26) — the control-plane session tools ride this gateway under D2

This amendment extended the gateway to `verity_list_sessions` and
`verity_session_handoff`, allowing Verity Control to read fleet metadata and send
briefings to project sessions. Handoffs also support explicitly creating a new
session in the target project. These tools remain available after the retirement
of `verity_create_delivery` and the workflow engine (ADR 0015).

The two new ones are not secret tools. They land here anyway, because they land
on this gateway, and D2 is a property of the channel rather than of the three
tools that first used it.

**D2 extends to both, unchanged and unwaivable.** Every call raises a card. There
is no configuration, flag, or backend profile that disables it. Both tools block
on the decision inline, so for them "an uncovered call is rejected" is the whole
story — neither has `verity_secret_job`'s out-of-band shape.

**Including the read-only one.** `verity_list_sessions` resolves no secret and
starts no execution, so D2's stated invariant does not by itself demand a card
for it. It asks regardless. What it returns is the shape of the operator's fleet
— which projects exist, which sessions are live, which can be written to — and
that is reconnaissance for the tool next to it. A listing that answered silently
would also make the handoff's card the first and only moment the operator learns
a control session is addressing the fleet at all.

**D3 does not extend to either.** Neither has a standing-grant target and neither
is grantable. The grant flag on this seam is now a named allowlist holding
`verity_http_request` alone, so a tool added to the gateway later is un-grantable
until someone amends this document to say otherwise. That is D2's default made
structural rather than incidental: the previous shape granted by exclusion, which
would have given the next tool a delegation nobody decided to give it.

**What is new and is not covered by the D1 threat model.** D1 states the
per-session bearer token is not a boundary against the workspace: a same-UID
process can read it from `/proc` and call the tool. For the secret tools that
buys the caller a card the operator did not expect. For `verity_session_handoff`
it would buy a card proposing to inject text into *another* session — a
cross-session write, which is a capability the three secret tools do not have.
The mitigation is the same one D2 names, and it is the only one: the briefing is
shown in full on the card, unclamped and not collapsed to one line, and the
operator reads it before it becomes a turn anywhere. The gateway additionally
refuses a caller that is not the control session before raising a card at all, so
a workspace process holding a stolen token does not get to interrupt the operator
with a card in the first place.

### Consequences

- The gateway audit record this ADR calls load-bearing now covers five tools, and
  its `toolName` enum is the enforcement point: a tool the schema does not know
  cannot be served. Adding a tool to the gateway means amending the schema, which
  means arriving at this document.
- A handoff addressed to a project rather than a session resolves to a concrete
  session *after* the card is answered. The card discloses this and the tool
  refuses rather than choosing when a project holds more than one eligible
  session, but the durable record of where a briefing landed is the target
  session's transcript, not the audit row. That is a gap in evidence, not in
  approval, and it is named here rather than left in a code comment.

## Amendment 3 (2026-08-29) — selected targets and bounded observation

The gateway additionally serves `verity_session_progress`,
`verity_recent_session_messages`, and `verity_publish_session_progress`; the
served-set count is now eight. The two reads are
on-demand reads under D2: every invocation raises a fresh card, neither supports
a standing grant, and callers must not poll them.

Handoffs no longer use a project name to choose among multiple sessions. The
Control session lists the eligible sessions and presents those exact ids plus a
New session option. The approved handoff then names either that `sessionId` or
`newSession.project`; the latter creates the session and delivers the briefing as
its first turn. A bare project target remains compatible only when exactly one
eligible session exists and fails closed otherwise.

`verity_session_progress` returns lifecycle/timing and local or already-cached
branch, Issue and PR facts. It never refreshes GitHub and never returns transcript
text. A completed turn is reported separately from an outcome-delivered claim;
absence of a bounded published claim is `null`, not inferred success.
`projectionTruncated` says when the bounded event tail may have omitted an older
turn start or publication.
The publish tool is bound to its authenticated calling session and writes a
bounded canonical event containing summary, blocker/decision when present, and
an explicit outcome-delivered boolean. It cannot name or update another session.

`verity_recent_session_messages` names one exact session, a purpose, a bounded
count (20 by default, 50 maximum), and an optional time window. It returns only
prompt, top-level assistant and system-error text, with recognized credential
patterns conservatively redacted. Attachments, tool inputs/results, hidden
prompts and capabilities are excluded. Because arbitrary free text cannot be
proven secret-free, the approval card explicitly warns that the selected content
scope may still contain sensitive material. Pagination is a
new invocation with the returned `nextBeforeSeq` cursor and therefore a new
approval. Audit logs record caller, target, purpose and scope but never returned
message content.
Assistant responses crossing an internal event-page boundary are omitted rather
than returned as fragments that could split one credential across approvals.
Responses exceeding the bounded raw assembly buffer are likewise represented by
an omission marker rather than returning a tail that may have lost a credential
prefix.

## Amendment 4 (2026-09-19) — OpenCode is admitted to the gateway

ADR 0012 Amendment 4 moved OpenCode onto ACP and deliberately left it outside the
brokered tools, naming the reason: which agents may spend the operator's secrets
is a decision, not a consequence of the transport an agent happens to speak. This
amendment takes that decision. `opencode-acp` now carries the same brokered tools
as `claude-acp` and `codex-acp`: a per-turn gateway bearer is minted for its
turns, its `session/new` offers the loopback MCP server, `trustedCliExecution` is
granted to it, and the project's secret NAMES are listed in its system prompt.

**Nothing about the guarantee changes, because there was never an attestation to
weaken.** D1 already states that the gateway is approval-gated rather than
attested, on every transport it serves: the bearer identifies the turn, it
authorizes nothing, and a same-UID workspace process that reads it from `/proc`
gets a card the operator did not expect. That is the exposure Claude and Codex
already run with. OpenCode joins a channel whose security rests on D2 — no secret
resolves without an operator decision covering the call — and D2 is a property of
the channel, not of the agent on the other end of it.

**What made it a decision anyway** is the other end. The tools are as strong as
the agent is trustworthy with a card in front of the operator, and admitting an
agent means accepting that its turns can ask. That question was answered for
Claude and Codex when D1 shipped and is now answered for OpenCode, which runs
behind the same spawn broker, in the same Sandbox, under the same per-turn
identity, and — unlike either of them — under `openCodeMode`, which collapses
every Verity posture into `build` or `plan`. An unattended OpenCode turn therefore
gets fewer tools than the same turn on Claude, never more.

**`trustedCliExecution` is part of this decision, not a side effect of it.** It
rides the same flag as the bearer, and no line mentioning it changed, so it is
worth saying what it grants: not a shell, but the execution half of
`verity_secret_run`, one of the three D1 tools. It is reachable only through the
gateway (`mcp-gateway-tools.ts`), under the same D2 approval and the same
root-owned-executable allowlist as on Claude and Codex. Admitting an agent to the
gateway and withholding this would mean one of the three tools failing at the
point of use rather than a narrower posture. A future backend that should get the
gateway *without* `verity_secret_run` is possible, and needs its own predicate
rather than a reinterpretation of this one.

**D3 is unchanged and already correct for it.** `brokeredGrantChannel` has
answered `acp` for `opencode-acp` since before this amendment, so a standing grant
created on the restricted channel is what an OpenCode turn redeems against, and a
native-path `forever` grant does not auto-approve on it. That arm needed no edit;
it was written for this day.

It does mean OpenCode turns can redeem grants approved during a Claude or Codex
turn, and that is worth stating rather than leaving to be discovered. Grants are
keyed by project, binding, secret alias and tool target (ADR 0011 D2) — never by
backend — so a `project`-scope grant has always covered every session in its
project, on whichever agent. Admitting OpenCode widens who can redeem one in
exactly the way starting another Claude session does, which is the reach the
operator agreed to when they chose `project` over `session`. What does NOT widen
is the ceiling: those grants are all on the `acp` channel, where `forever` is
refused at the store and a redemption additionally requires an ACP approval under
24 hours old. An operator who wants a decision confined to the agent in front of
them has `session` scope, which binds to the session id and so never crosses to
another backend's turn.

**The admission is still not "is it ACP".** Four gates name their members by hand
— `ACP_WORKER_BACKENDS` in the supervisor, the `acpBackend` flag that mints the
bearer, `carriesBrokeredSecretTools`, and the runner worker's two independent
re-checks — plus the Server's bearer-registry assembly check. They are separate
literals so none can drift into the others, and they must move together: a member
added to one alone either refuses the turn it meant to admit or starts it
tool-less. A fourth adapter arrives refused until this document says otherwise.

### Consequences

- **A Sandbox older than this release refuses every OpenCode turn.** ADR 0006 D9
  has such a container attesting cleanly — a Server outliving a Sandbox is the
  normal case — but its supervisor's `ACP_WORKER_BACKENDS` predates the decision
  and answers `invalid mcpGatewayToken` to the bearer the Server now mints. That
  is the old boundary failing closed, which is the right direction, and it is not
  recoverable at runtime: the fix is to recreate the project container on a
  current toolkit.

  That one list gates two fields, so the refusal has two shapes. A turn with
  `sessionId: null` — the ephemeral/meta-query path — mints no bearer and clears
  the first gate, but `trustedCliExecution` rides on backend identity rather than
  on bearer presence, so it is refused at the second one with `invalid
  trustedCliExecution`. Such turns are NOT exempt, and the field is not gated on
  the bearer to make them so: it is the execution half of `verity_secret_run` and
  belongs to the same decision. An older draft of this bullet claimed the
  exemption and was wrong.

  The Server recognizes both refusals and says so rather than passing on four
  opaque words (`explainStaleGatewayRefusal`, `runner-supervisor-client.ts`),
  which also keeps the supervisor's gate order from being load-bearing. It states
  the cause outright, because it can: a current supervisor emits the bearer
  refusal for two further reasons of its own — a bearer that is EMPTY, and one
  over its 512-byte shape bound, both Server composition defects that no
  reprovisioning fixes. All three are indistinguishable from the message, and
  none of them are to the client that minted the bearer. It reads the value it
  sent, and explains container age only for a bearer the supervisor would have
  accepted on shape; the defect cases are told outright that recreating the
  container will not help. That defect arm is the one thing here not narrowed to
  OpenCode: the registry is shared, so the same malformed bearer on Claude or
  Codex is the same defect. The mirrored shape bound is the fragile part of that
  — the supervisor is a boundary binary with nothing to import — so the bound and
  its comparison are pinned against the supervisor's own source rather than
  restated. The operator-facing procedure is
  `docs/runbooks/opencode-brokered-tools-container-refresh.md`.

  Detecting this BEFORE the turn was considered and rejected on two counts. The
  status handshake names no backends, so a Server would have to infer staleness
  from a new field's ABSENCE — which is what the refusal already reports — by
  changing the very boundary binary the affected containers do not have. The
  `protocolVersion` it does carry is not a substitute: it is the WIRE dialect,
  and this amendment changes no frame. Bumping it to signal a policy change would
  make every older supervisor look wire-incompatible and refuse ALL of its turns,
  Claude and Codex included, turning a failure confined to one backend into a
  total one. Failing per-backend, at the turn, is the smaller blast radius.
- **This release is order-dependent, and the order is Server first, then the
  containers.** As a pairing it looks like the opposite: both supervisor gates
  fire on a field being PRESENT, so a CURRENT supervisor under an older Server is
  fine — that Server sends neither field for OpenCode — while the reverse is the
  failure above. Refreshing the containers first is still wrong, because the
  toolkit is not independently installable ahead of the Server that ships it. A
  Server pins the toolkit Feature to its own bundled version, and it attests each
  Sandbox against the ledger in its own bundle (`published-hashes.json`), which
  cannot list a release published after it. Forcing the newer toolkit in
  therefore fails attestation, and a failed attestation disables the Runner
  supervisor for the whole container (`provisioner.ts`) — trading a failure
  confined to OpenCode for one that takes Claude and Codex down with it. So:
  deploy the Server, then recreate the project containers running OpenCode. The
  window between the two is the one in which those turns fail, and shortening it
  is the mitigation; Claude and Codex are the workaround inside it.

  There is deliberately no rollout flag — no switch that withholds the bearer
  while the Server otherwise ships this. A flag would be a second answer to "may
  OpenCode spend the operator's secrets", sitting outside this document and
  outgrowing it, which is the coupling the hand-named gates above exist to
  prevent. Deploy ordering is a release-note obligation instead: this amendment
  ships as a BREAKING change — `!` on the squash title, a `BREAKING CHANGE:`
  footer naming the container refresh and the order — so Release Please renders
  it into `CHANGELOG.md` with the version that needs it. `docs/releases.md`,
  "Changes that require operator action", is where that rule now lives, because a
  runbook is only reachable by an operator who has already hit the failure.

  Forcing the refresh instead of announcing it was considered, and there is
  exactly one lever: raising `minimumVersion` in the toolkit's
  `published-hashes.json`, which would stop older toolkits attesting at all. It is
  rejected for the reason that rejected a `protocolVersion` bump — attestation is
  whole-container, so it would strand Claude and Codex sessions in those projects
  over a change that affects neither — and additionally because ADR 0006 D9 takes
  a Server outliving a Sandbox as the NORMAL case and requires the previous Runner
  to keep working. A boundary version the operator can read is the part that is
  genuinely missing today; recovery therefore ends with a check against the
  installed supervisor itself, which is the artifact the question is about.
- **The project's secret NAMES now reach whichever model provider the OpenCode
  session is configured with.** `carriesBrokeredSecretTools` lists the aliases in
  the system prompt, so admitting OpenCode also discloses them — and that lands
  differently here than on the other two adapters. Claude and Codex each speak to
  one vendor, chosen by choosing the agent; OpenCode speaks to an API base URL and
  key the operator supplies (ADR 0012 Amendment 5), which may be any provider at
  all. The exposure is names, never values — no value resolves without a D2
  approval covering the call, and an alias without the gateway behind it buys a
  reader nothing, which is ADR 0011 D3's position that secret names are not
  secret — but "the names of this project's secrets" still describes the project,
  and an operator who picked a provider for model access did not pick it for
  this. The names go anyway, because they are what makes the tools usable: an
  agent that cannot name an alias cannot ask for an approval, which is the
  tool-less-but-admitted dead end this amendment removes everywhere else. The
  control is therefore which adapter a project's sessions run on, and which
  provider that adapter is pointed at — not a per-backend name filter, since the
  aliases are the project's bindings and a project has one set of them.
- **A Server composed without `mcpGatewayTokens` now refuses OpenCode turns that
  it previously ran tool-less.** The registry is mandatory for every named
  brokered-tool backend, and OpenCode joins that requirement here rather than
  being exempted from it: a Server that would start an admitted turn with no
  tools and no error is the failure that check closes. The production
  composition always supplies the registry, so this reaches only a partial
  assembly — but its message (`composed without mcpGatewayTokens`) resembles the
  stale-container one closely enough to be misread as container age, so the
  runbook names it under "Recognize it" as a third message that recreating
  nothing will fix.
- Control-plane sessions still do not get OpenCode. That refusal is ADR 0012
  Amendment 4's, for a different reason — the fixed control-plane Runner carries
  no OpenCode configuration or egress material — and this amendment does not
  touch it. (**Lifted by ADR 0012 Amendment 6, 2026-09-20**: the Runner carries
  the configuration now, and it never lacked the egress material — OpenCode rides
  the Codex leg. The brokered tools this amendment admitted reach control-plane
  OpenCode turns through the same per-turn gateway as the other two.)
- `opencode-mcp` in `@verity/secret-contracts` still names nothing. It is a label
  for an ATTESTED native relay; gateway calls carry `acp-mcp`, whose premise is
  that nothing attests them.

## Amendment 5 (2026-09-25) — explicit linked-session messages

ADR 0024 adds `verity_list_linked_sessions` and `verity_send_session_message` to
the gateway. This is a narrow exception to D2's per-call card rule, rather than
an extension of the standing-grant store. The user creates one exact pair of
sessions through the authenticated app. Listing returns only that caller's
linked peers without a card. Sending consumes a durable allowance of six
messages per direction; once exhausted, the next message requires a fresh card
showing its complete content and target. Approval both delivers that message
and renews the same directional allowance. Denial delivers nothing.

The gateway still MAC-keys and audits every invocation, including automatic
sends and denied renewals. Its authenticated session and turn bind the source;
the server resolves the target from the link and reserves the allowance under a
row lock through target acceptance. The card decision is passed to that
reservation, so a concurrent send cannot convert an exhausted automatic call
into an unapproved renewal. Link creation, revocation, provenance, and the
cross-project information-flow decision are recorded in ADR 0024.
