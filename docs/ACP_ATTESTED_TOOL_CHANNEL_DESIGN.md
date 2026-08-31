# ACP attested secret-tool channel — design

- Status: decided — see §7 and ADR 0014. Retained as the measurement record.
- Date: 2026-08-08 (decision recorded the same day)
- Relates to: ADR 0012 invariant 6, `BROKERED_SECRETS_W3_W4_CONTRACTS.md` §4.1–4.2,
  ADR 0011, ADR 0006

The title says "attested" because that was the goal when the work started. The
outcome is that the property could not be reconstructed on ACP and the channel
ships approval-gated instead. §7 carries the decision; everything before it is the
evidence that produced it and is left as measured.

## 1. Why this document exists

ADR 0012 withholds native secret-tool attestation from ACP and names the
condition for lifting that:

> The condition for the default flip is therefore a separate, security-reviewed
> slice: an authenticated HTTP-MCP tool channel with a per-turn token, which
> codex-acp already accepts via `mcpCapabilities.http`.

`BROKERED_SECRETS_W3_W4_CONTRACTS.md` §4.1 says of that exact shape:

> Merely configuring an MCP URL/token inside the agent child is not sufficient:
> same-UID repository processes may call or steal that channel. Prompt
> instructions, PATH wrappers, shared Unix sockets, and ordinary Sandbox
> executables remain non-authoritative.

Both documents are accepted. Taken literally they cannot both be satisfied by
the same slice, so the work ADR 0012 describes cannot start until the
contradiction is resolved. This document establishes what property must be
preserved, records a spike into the transport that would preserve it for free,
and proposes a resolution.

## 2. The property to preserve

"Attested" in Verity does not mean authenticated. It means **two independent
channels must agree, one of which is unreachable from the workspace**.

The required invariant and the property Verity actually demonstrates are not the
same thing, and this document keeps them apart deliberately.

- **P1-required — a channel unreachable from the workspace.** The invariant W3/W4
  §4.2 states: _"Repository processes cannot invoke or inherit the channel."_
- **P1-shown — worker memory versus the shared event file.** What the code
  demonstrates. The tool call crosses an in-memory callback inside the Runner
  worker process before it reaches any shared surface
  (`packages/session/src/runner-server.ts:109-122`): _"A project process can
  imitate an events.jsonl line, but it cannot invoke this in-memory callback.
  Rejecting the callback fails the turn closed before the call is published."_

  That is a narrower claim than P1-required. Today's attested call is read off the
  stdout of `codex app-server --stdio`, a child process spawned into the Sandbox
  (`packages/session/src/codex-backend.ts:662`, consumed at `:971`), so the
  question is whether a same-UID repository process can write into that child's
  descriptors via `/proc/<pid>/fd` or attach with `ptrace`. Verity's documents
  answer this nowhere. §5 answers it empirically — M6 for the spawner in this
  repository, M7 for the topology a deployed turn actually runs.

  **P1-required holds on the shipped system.** Every reach a repository process
  has at the channel was attempted and refused (M7). But it holds on three
  barriers of unequal strength, and the two strong ones — the worker running under
  a different UID, and a broker socket the workspace cannot connect to — guard
  processes that are not the tool-call stream. The stream itself is same-UID with
  the workspace and is held by one thing: Node hands child stdio as socketpairs,
  which cannot be reopened through `/proc/<pid>/fd`, while the same attack from
  the same position **succeeds** against an ordinary pipe.

  So the invariant is intact and its weakest link is exactly the channel the
  attestation depends on — a libuv implementation detail that, until this
  document, no Verity test asserted and no Verity document mentioned. It bounds
  every option in §7 equally. It is now written down and pinned
  (`packages/session/src/agent-stdio-isolation.test.ts`, for both spawn paths)
  rather than left to be rediscovered.
- **P2 — agreement, or fail closed.** Server-side, the event read from the
  shared file must deep-equal the call fetched over the supervisor's private
  socket, or the turn dies with `native Secret Tool event has no matching worker
  attestation` (`packages/session/src/runner-supervisor-client.ts:109-123`,
  contract at `:84-89`).
- **P3 — server-stamped context.** Project, session, turn, tool-call ID,
  channel, and protocol version are stamped by the gateway and cannot be
  supplied or overridden by the model (W3/W4 §4.2,
  `packages/server/src/native-secret-tool-event-adapter.ts`).

Any ACP channel must reproduce all three. Authentication alone reproduces none
of them: a credential present in the Sandbox is reachable by every same-UID
repository process, which is precisely the W3/W4 objection.

## 3. Current state

No transport on any backend other than native Codex carries these tools, and
this is enforced twice:

- `packages/session/src/runner-supervisor-client.ts:614-629` gates all four
  flags (`nativeSecretTools`, `nativeSecretJob`, `nativeBrokeredHttp`,
  `nativeTrustedCli`) on `workerBackend === 'codex'`.
- `packages/session/src/runner-worker-entry.ts:69-85` independently rejects the
  same combination for any other backend.

Two consequences worth recording, because both have been misread:

- **Claude never carried these tools.** The gating landed on 2026-07-23 with
  `28667b83f`, before the ACP migration of 2026-08-03 (`49f3de505`). The
  `claude-native` branch of the channel expression in `embedded.ts` was
  unreachable when it was written. The ACP migration did not remove a capability;
  it added a second reason the branch was dead. Building this channel is **new
  capability, not repair**, and carries a full security review accordingly.
- **The channel enum is not evidence of intent to ship.** W3/W4 §4.2 states that
  reserved identifiers mean _"recognized protocol label," not "implemented or
  secure,"_ and that runtime support requires an independently registered
  capability flag after adversarial tests. `opencode-mcp` sitting unbound in
  `toolChannelSchema` is documented design, not drift.

  `claude-native` sat there on the same footing and no longer does. Reserving a
  label costs nothing while the transport it names could still appear; once ADR
  0012 retired Claude's native stream-json transport there is no transport left
  for it to name, and the reservation stopped describing a future and started
  describing a past. Neither residue is left. The dead ternary branch went
  first, on its own: the channel handed to `createNativeSecretToolEventAdapter()`
  in `packages/server/src/embedded.ts` is now the constant `'codex-mcp'`, behind
  a `supportsNativeToolBridge` gate on `runnerSupervisorBackend === 'codex'`. The
  enum member outlived it and is what was removed here. Should an attested Claude
  relay ever be built, it will be built on ACP and will want a name that says so.

  Narrowing an enum is a breaking change to whoever parses with it, so it is
  worth saying who that is: nobody outside this repository.
  `@verity/secret-contracts` is `private: true` and unpublished, and the value is
  not exchanged between processes either — the channel is stamped server-side in
  `embedded.ts` at the moment of invocation, never sent by a sandbox, so there is
  no older peer to skew against and nothing for `protocolVersion` to negotiate.
  A published contract, or one a sandbox could put a channel into, would need a
  major bump and a skew window instead of this paragraph.

  Narrowing an enum breaks reads of anything already stored under the removed
  label, so that was checked rather than assumed, and the check is recorded here
  because the next such removal will want it: **no `ToolChannel` value is
  persisted as a readable field** — the qualification matters, and the last
  paragraph below is where it is spent. `ToolInvocationContext` is stamped per
  invocation and lives only inside `secretToolInvocationSchema`; the audit
  trail's one `channel` field is `gatewayChannelSchema` (`acp-mcp`); and the one
  `channel` column in the store, `brokered_grant_approvals`, holds
  `brokeredGrantChannelSchema` (`native` | `acp`). Three separate vocabularies,
  deliberately — see `gatewayChannelSchema`'s own note on why the gateway must
  not share this enum.

  The one path that turns an invocation into a stored row is the exception worth
  naming, because it does not look like one: `requestNative()`
  (`packages/server/src/secret-job-service.ts`) hands the whole
  `SecretToolInvocation` to `authorization.request()`
  (`packages/server/src/secret-authorization.ts`), which writes claims into
  `secret_approvals.claims_json`. Those claims copy `projectId`, `sessionId`,
  `turnId` and `toolCallId` off the context and stop — `runGrantClaimsSchema`
  (`packages/secret-contracts/src/grant.ts`) is `.strict()` and has no `channel`.
  That is pinned by a test in `contracts.test.ts` rather than left to this
  paragraph, since the paragraph is what would drift.

  One thing does carry the channel into the store, and it took looking for that
  write path to find it: those same claims hold
  `requestHash = sha256(canonicalJson(invocation))`, taken over the _whole_
  invocation, context included. The channel is therefore covered by a persisted
  digest even though no row holds the label. That is not a read of the removed
  value — nothing recovers `claude-native` from a sha256, and the digest is only
  ever compared against one computed in the same process from a live invocation
  (the replay check in `request()`). Its one effect is that a pre-existing
  approval taken over a `claude-native` invocation could no longer be matched by
  a retry, which fails closed as `tool call approval replay does not match`. No
  such row can exist regardless: the branch was already unreachable when the
  gating landed on 2026-07-23. Recorded because the next enum removal will want
  to check the hashes as well as the columns.

On the ACP side, `session/new` currently passes no tool servers at all:
`mcpServers: []` (`packages/session/src/acp-backend.ts` — the `session/new` call).
The line number that used to stand here had already drifted by sixty lines, which
is why the anchors above name files and symbols instead.

## 4. Spike: is MCP-over-ACP available? (2026-08-08)

ACP specifies a transport that removes the endpoint and the credential entirely:
`McpServer::Acp`, in which the MCP server is provided by an ACP component and
speaks over the existing ACP connection via `mcp/connect`, `mcp/message`, and
`mcp/disconnect`. Those are **client** methods
(`@agentclientprotocol/sdk@1.3.0`, `CLIENT_METHODS`), so Verity — the client —
would host the tools in the Runner worker's own address space. No listener, no
credential in the Sandbox.

What it does **not** do is establish P1-required. It carries the tool traffic on
the same adapter stdio descriptors as everything else, so §2's reachability
question applies unchanged: if a Sandbox process can write into those
descriptors, it can forge MCP-over-ACP traffic just as it could forge an
app-server tool call today. This transport is better than HTTP-MCP because it
deletes a stealable credential and a second reachable surface — not because it
proves anything §2 leaves open.

It is gated by `mcpCapabilities.acp`. Both installed adapters were probed
directly with an `initialize` request:

| Adapter                                | Version | `mcpCapabilities`                    |
| -------------------------------------- | ------- | ------------------------------------ |
| `@agentclientprotocol/claude-agent-acp` | 0.66.0  | `{http: true, sse: true}` (no `acp`) |
| `@agentclientprotocol/codex-acp`        | 1.1.14  | `{acp: false, http: true, sse: false}` |

These are point-in-time readings of the pinned bundles, not upstream guarantees.
Re-probe rather than trusting this table after any Renovate bump of the two
adapters (`features/verity-sandbox-toolkit/install.sh`):

```sh
{ printf '%s\n' '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{}}}'; sleep 5; } \
  | codex-acp | head -c 2000
```

Both values are **hardcoded literals**, not runtime-computed and not behind a
flag or environment variable:

- `/usr/local/lib/node_modules/@agentclientprotocol/codex-acp/dist/index.js:28804-28808`
- `/usr/local/lib/node_modules/@agentclientprotocol/claude-agent-acp/dist/acp-agent.js:703-706`

`codex-acp` references `mcp/connect` only inside its bundled copy of the SDK
method table; it registers no handler. The Claude adapter's bundle contains no
occurrence of any `mcp/` method at all. Both installed versions are the latest
published, so no Renovate bump unlocks this.

Upstream, MCP-over-ACP is an open RFD. The Rust SDK carries it behind the opt-in
`unstable_mcp_over_acp` feature; neither JS adapter implements the agent side.
The RFD's backwards-compatibility story — an intermediary that bridges an
ACP-transport MCP server down to stdio or HTTP for agents that do not support it
— **does not help Verity**: the bridge terminates in a stdio or HTTP endpoint
inside the Sandbox, reintroducing exactly the reachability W3/W4 rejects.

**Spike verdict: negative.** HTTP is the only transport both adapters accept, and
it is the one W3/W4 declares insufficient on its own. Claude additionally
advertises SSE, which is excluded here because it is the same shape — a network
endpoint in the Sandbox authenticated by a credential the agent child holds — so
it inherits the identical objection while being supported by only one of the two
adapters.

## 5. Measurements on the running system (2026-08-08)

A driver spawned `claude-agent-acp` directly over stdio, opened a session with a
probe HTTP-MCP server in `session/new`'s `mcpServers`, auto-approved
`session/request_permission`, and drove real turns. The probe server timestamped
every HTTP request; the driver timestamped every `session/update` and scanned all
of `/proc` every 50 ms for holders of the adapter's stdio descriptor.

Both scripts are in `scripts/probes/acp-attested-channel/`, with instructions for
re-running them. They are manual — a turn needs a live adapter and a working
credential. The one claim below that needs neither, M6's descriptor isolation, is
a test instead (`packages/session/src/agent-stdio-isolation.test.ts`) and runs in
CI, because it is the claim most likely to be invalidated by a change inside
Verity rather than upstream.

One prerequisite that cost a run: an `mcpServers` entry needs `headers: []`
present. Without it the adapter silently ignores the server — no error on either
channel, the tool simply never appears and the model reports it does not exist.
Anything built on this needs to detect that case rather than inherit it.

### M1 — Ordering is favourable, and there is a barrier

One turn, one MCP tool call, milliseconds relative to the first event:

| +ms | event |
| --- | ----- |
| 0 | `session/update` `tool_call`, status `pending`, `rawInput: {}` |
| 12 | `session/update` `tool_call_update`, `rawInput: {"target":"probe-alpha"}` |
| 19 | `session/request_permission` — a **request**, not a notification |
| 76 | MCP `tools/call`, `arguments: {"target":"probe-alpha"}` |

Two consequences. The complete argument payload is on the private channel
strictly before the MCP call arrives, which is the ordering §6 needs. And
`session/request_permission` is a request the client may hold, so the correlation
has a synchronization point Verity controls rather than a race it has to win.

Calls also overlap. In one run the agent opened its Bash `tool_call` before the
MCP tool's call had completed, so a gate that assumes one pending call per turn is
wrong on ordinary traffic — a further reason the correlation key must be per-call
identity rather than anything positional.

One trap: the first `tool_call` carries `rawInput: {}`. Arguments stream in
incrementally — the Bash tool in the same run showed `rawInput` growing across two
updates (`command`, then `command` plus `description`). A correlator keyed on the
first notification compares `{}` against real arguments and fails closed on every
call. It must take the last update before the permission request.

### M2 — `rawInput` is byte-comparable

`{"target":"probe-alpha"}` on both sides; deep-equal on the final update. Measured
on `claude-agent-acp` only — see M5.

### M3 — A call identity already crosses, undocumented

The MCP request carries one:

```json
"params": {
  "name": "verity_probe_secret",
  "arguments": { "target": "probe-alpha" },
  "_meta": { "claudecode/toolUseId": "toolu_013FMkFVUsdXDhuxaxRATcha", "progressToken": 2 }
}
```

`claudecode/toolUseId` is exactly the ACP `toolCallId` of the same call. §6's
second candidate repair — agent-side call identity — therefore already exists on
this adapter, with no upstream change, which weakens the ordering argument in §7.
Whether a thief holding the endpoint can produce that identifier is a separate
question this measurement does not answer: the value is not confined to stdio —
the snippet above is the adapter putting it on the wire — and nothing pinned here
states it is unpredictable. §6 treats both as open.

What it is not: a contract. It is a proprietary `_meta` key of one adapter, absent
from both the ACP and the MCP specifications and from the pinned schema, free to
disappear on any version bump. Depending on it means owning a probe that fails the
build when it goes — the posture `verity-claude-acp-harden.mjs` already has for the
title builder (ADR 0012).

### M4 — The endpoint and its credential sit in world-readable argv

`claude-agent-acp` passes the whole MCP configuration on the command line of the
CLI it spawns. With a token supplied in `headers`, `/proc/<pid>/cmdline` reads:

```text
/usr/local/bin/claude --output-format stream-json … --mcp-config
{"mcpServers":{"verity-probe":{"type":"http","url":"http://127.0.0.1:8771/mcp",
"headers":{"Authorization":"Bearer <per-turn token>"}}}} …
```

`/proc` is mounted without `hidepid` (measured earlier this session, alongside
`ptrace_scope=1` and an empty `CapEff`), so any same-UID repository process reads
the per-turn token by listing `/proc`. This is not an analogy to W3/W4 §4.1 —
"same-UID repository processes may call or steal that channel" — it is that
sentence demonstrated on the shipped adapter.

**From which position matters, and the first version of this measurement got it
wrong.** `/proc` access to another task's `environ` and descriptors goes through a
ptrace-mode check, so an ancestor can read what a workspace process cannot; the
original scan ran inside the driver, which is the adapter's *parent*, and would
have shown the same result even if the leak were unreachable from the workspace.
The scan is now its own program (`leak-scan.mjs`) and was re-run from all three
positions in one turn:

| Scanner position                                | Reads the URL and a `Bearer` credential off the CLI's `cmdline` |
| ----------------------------------------------- | --------------------------------------------------------------- |
| `parent` — the driver, adapter is its child      | yes (and the token value matches byte for byte)                 |
| `sibling` — a second child of the driver         | yes                                                             |
| `agent-descendant` — run by the agent's own Bash | yes                                                             |

The third row is the claim that matters: a command the agent ran itself, which is
a descendant of the adapter and exactly what a repository process is, read the
credential out of its own ancestor's command line. Not one `cmdline` in the
container was refused to it (`readable cmdline=38, refused cmdline=0`); only a
handful of `environ` files were, and those belong to processes of another user.
The leak is reachable from the position the threat model names, not merely from a
privileged vantage point the probe happened to occupy.

It also settles ADR 0012's flip condition directly. "An authenticated HTTP-MCP
tool channel with a per-turn token" cannot be satisfied by this adapter as
written: the token is public to the workspace by construction, and §6's "keep the
token in the adapter's memory only — never in argv" is not something Verity can
honour from the client side.

### M5 — `codex-acp` carries no per-call identity, which closes option A

`codex-acp` spawns `codex app-server` with no configuration in argv and passes
`mcp_servers` over the app-server stdio channel, so M4 does not apply to it as
written. Whether it persists the server into an on-disk config layer is
unverified.

M1 through M3 were unmeasured here in the first version of this document, because
the container carried no Codex credential. **That gap is now closed** — the
measurement ran on 2026-08-08 with a credential present, and it is decisive
against option A:

| M3 on `claude-agent-acp`                                   | M3 on `codex-acp`                                            |
| ---------------------------------------------------------- | ------------------------------------------------------------ |
| `_meta` carries `claudecode/toolUseId` = the `toolCallId`  | `_meta` carries `x-codex-turn-metadata`, `threadId`, `progressToken` |
| a key both channels share                                   | no key both channels share                                    |

Both sides of that one call, from the same run, with every identifier consistently
replaced (`<session>`, `<turn>`, `<call>`) and nothing else altered. Read them as a
pair — the point is what the second does *not* contain:

```json
// ACP session/update — the private channel
{"kind":"tool_call","toolCallId":"exec-<call>","status":"in_progress",
 "rawInput":{"server":"verity-probe","tool":"verity_probe_secret",
             "arguments":{"target":"probe-alpha"}}}

// ACP session/request_permission, 1 ms later
{"toolCallId":"exec-<call>","chose":"allow_once"}

// MCP tools/call, 3 ms after that — the channel Verity would have to trust
{"params":{
  "name":"verity_probe_secret",
  "arguments":{"target":"probe-alpha"},
  "_meta":{
    "x-codex-turn-metadata":{
      "session_id":"<session>","thread_id":"<session>","turn_id":"<turn>",
      "sandbox":"seccomp","model":"…","reasoning_effort":"…",
      "turn_started_at_unix_ms":0,"user_input_requested_during_turn":true,
      "workspaces":{"<cwd>":{"associated_remote_urls":{"origin":"…"},
                             "latest_git_commit_hash":"…","has_changes":false}}},
    "threadId":"<session>",
    "progressToken":1}}}
```

The ACP `toolCallId` of the same call (an `exec-<uuid>` identifier) appears nowhere
in that object — not as a value, not as a substring. `threadId` is stable across
every call in the session and `x-codex-turn-metadata` across every call in the
turn, so neither distinguishes two calls that a correlator has to tell apart.
`progressToken` does distinguish them — it is MCP's own per-request counter — but
it is generated on the MCP side and never appears on the ACP channel, so it
identifies a call within one channel rather than binding the two. A correlator
needs a key both sides can see, and there is none.
`mcpCapabilities` reports `{ acp: false, http: true, sse: false }`, so the
ACP-hosted channel of option B is still unavailable on this adapter too.

What would overturn this is a `_meta` key on `codex-acp` that varies per call and
matches the ACP `toolCallId`. That is a one-line check in the probe log
(`MCP_TOOLS_CALL` versus `ACP_TOOL_CALL`), which is the form the claim is stated
in so a later adapter version can be re-tested against it rather than argued
about.

M1's ordering held — ACP `tool_call`, then `session/request_permission`, then the
MCP arrival, within a few milliseconds — but the **barrier is unproven**: the probe
auto-approved, so nothing in this run shows the adapter would actually wait on a
held permission answer. Proving it needs a run that delays the answer.

This is exactly the case §7 named as fatal to option A: "If `codex-acp` carries no
equivalent call identity, A collapses back to payload correlation for the backend
that matters and option B becomes the only path." It does not, and it does.

Provenance: like every measurement here this was a manual probe run
(`scripts/probes/acp-attested-channel/`, `--adapter codex-acp`). The raw log is not
committed — it carries live session, turn, and workspace identifiers — but the
excerpt above is the whole of what the conclusion rests on, quoted from it with
only the identifiers substituted, and the falsifying check is stated so a later
adapter version can be tested rather than argued about. Re-running needs a
container with a Codex credential and nothing else.

### M6 — No inheritance leak — by adapter behaviour, not by anything Verity owns

Scanning all of `/proc` every 50 ms across two full turns, one of them containing a
real Bash tool call, found exactly one process holding the adapter's stdio socket:
the adapter's own inner `node /usr/local/bin/claude-agent-acp`. The Bash tool's
subprocess had

```text
0 -> /dev/null
1 -> /tmp/claude-1000/<cwd>/<session>/tasks/<id>.output
2 -> /tmp/claude-1000/<cwd>/<session>/tasks/<id>.output
3 -> /proc/<pid>/fd
```

— no ACP descriptor. The "or inherit" half of W3/W4 §4.2 holds for the Claude ACP
path as shipped.

The "or invoke" half holds too, for a reason nothing in Verity states or enforces:
Node hands child stdio as **socketpairs**, and a socket cannot be reopened through
`/proc/<pid>/fd` (`ENXIO`), while a real pipe can — a control test wrote
`FORGED-BY-REPO-PROCESS` into a sibling's pipe and the reader consumed it, under
the same `ptrace_scope=1`. So the channel is protected by a libuv implementation
detail. §2's P1 gap is narrower than it was, and the half Verity controls is now
pinned: `packages/session/src/agent-stdio-isolation.test.ts` asserts that
`nodeSpawner` puts an agent child on a socketpair that cannot be reopened, and
demonstrates the forge succeeding against an ordinary pipe so the first assertion
cannot quietly become vacuous. Both attempts are mounted from a *separate* process
whose target is a sibling, for the reason M4 spells out — an attack run from the
parent proves access an ancestor has and a workspace process may not, so the two
results would not be comparable. Mounting both from the same position is what lets
the difference be attributed to the descriptor type. What remains unpinned is the
half Verity does not own — a runtime or adapter that changes the descriptor type
outside that spawner.

How much of that runs on a given host is itself measured, because the forge needs
a host that permits `/proc/<pid>/fd` access between same-UID processes at all. The
test calibrates against the ordinary pipe first: where the reopen is refused
outright — `ptrace_scope >= 2`, `hidepid` — the socketpair would be unreopenable
for the host's reason rather than its own, so the comparison is skipped with the
observed code in the note instead of reported as a Verity regression. The
descriptor *type* is asserted everywhere regardless: reading a child's own fd link
needs no ptrace permission, so a spawner that regressed to a forgeable pipe fails
on any runner. What a hardened runner loses is the corroboration, not the guard.

### M7 — The shipped topology, measured: three barriers, and the channel has the weakest

M6 measures `nodeSpawner`. A deployed turn does not use it. The Runner worker
hands spawning to the agent spawn broker (`runner-worker-entry.ts:297`), so the
processes and the boundaries between them are not the ones §2 reasons about.
Observed on a live turn in this container:

```text
  124      1  root           node /usr/local/bin/verity-agent-spawn-broker
  168      1  verity-runner  node /usr/local/bin/verity-runner-supervisor
27139    168  verity-runner  node /usr/local/bin/verity-runner-worker …/request.json
27150    124  dev            node /usr/local/bin/claude-agent-acp
27162  27150  dev            /usr/local/bin/claude --output-format stream-json …
```

The worker is **not same-UID with the workspace**: it runs as `verity-runner`
(uid 1101), the broker as root, and only the agent child runs as `dev`. The agent
child's parent is the broker, not the worker — the tool-call stream reaches the
worker relayed over the broker's Unix socket.

Attempted from a repository process (uid `dev`), in both positions available to
one — a descendant of the agent child, as any Bash tool call is, and a detached
non-descendant — with identical results:

| Attempt                                             | Result   |
| --------------------------------------------------- | -------- |
| Reopen the agent child's stdout, `/proc/27150/fd/1` | `ENXIO`  |
| Read the worker's descriptors, `/proc/27139/fd/0`   | `EACCES` |
| Read the worker's `environ`                         | `EACCES` |
| Connect to `…/agent-spawn-broker.sock`              | `EACCES` |

Calibrated the same way M6 is: the same attacker, same position, against a
genuine `pipe:[…]` stdout of a same-UID process — the write landed and the reader
consumed `FORGED-BY-REPO-PROCESS`, under `ptrace_scope=1` and a `/proc` mounted
without `hidepid`. So the refusals above are properties of these boundaries, not a
host that refuses the class of attack.

**P1-required therefore holds on the shipped system**, which §2 could previously
only assume — but it holds on three unequal barriers, and they do not protect the
same thing:

1. **A UID split.** The worker and supervisor run as a different user, so no
   workspace process can read or write their descriptors at all. This is stronger
   than P1-shown claims, and it is invisible in the repository: it lives in the
   deployment.
2. **Group ownership of the broker socket.** `srw-rw---- root:verity-runtime`,
   inside a `711` directory, and `dev` is not in `verity-runtime` — the workspace
   cannot ask the broker to spawn anything.
3. **The socketpair.** The one surface that *is* same-UID with the workspace is
   the agent child's own stdout — which is exactly the stream the attested tool
   call is read off (`codex-backend.ts:662`). Nothing guards it but M6's libuv
   detail, and the calibration above shows the attack landing the moment that
   detail changes.

The two strong barriers protect processes that are not the attestation channel;
the attestation channel is left with the weakest of the three. That is the answer
to §2 and it is the finding: not that the shipped system is broken, but that the
part carrying the tool calls is held by the one barrier Verity neither states nor
arranges. `agent-stdio-isolation.test.ts` now pins the broker's launch spec for
all four agent commands as well as `nodeSpawner`, so a spawn path that hands a
raw pipe or an inherited descriptor fails rather than quietly opening surface 3.

What this does not establish: it was measured on the Claude ACP path. Attested
Codex tools run `codex app-server --stdio` through the same broker spec — same
stdio by construction, now asserted for that command too — but not observed live.
Nor does it speak for a host with a different UID layout; barriers 1 and 2 are
deployment facts, and a deployment that collapses them leaves only the third.

## 6. Proposed resolution — correlation attestation

Keep HTTP-MCP as the *transport* and restore P2 in a new form: **an MCP
invocation is executed only if the same call was independently observed on the
worker-private ACP stdio channel.**

When an ACP agent invokes a tool it also reports it as a `session/update`
`tool_call` over the ACP connection — file descriptors between the Runner worker
and the adapter child, already consumed by
`packages/session/src/acp-adapter.ts`. That channel occupies **the same trust
position as the native Codex app-server stdio the shipped attestation already
depends on** (§2): no better, no worse. It is a second channel distinct from the
shared event file, which is what P2 requires; it is not proven unreachable from
the Sandbox, and §2's open question applies to it identically.

The gate then mirrors `createAttestationGatedRunnerFrameStore`:

1. Verity mints a per-turn MCP endpoint and token, handed to the adapter in
   `session/new`'s `mcpServers`.
2. An inbound `tools/call` for `verity_secret_job`, `verity_http_request`, or
   `verity_secret_run` is **parked, not executed**.
3. It is released only once a `session/update` `tool_call` for the same session
   has arrived over stdio bearing the **same call identity** — the ACP
   `toolCallId`, which the MCP request repeats in
   `_meta["claudecode/toolUseId"]` (M3) — and the recorded arguments deep-equal
   the request's. Identity is the key; payload equality is a consistency check on
   top of it, never the key itself. Keying on payload alone is broken, for the
   reason below.
4. The recorded pair is taken from the **last** `tool_call_update` before
   `session/request_permission`, not the first notification, which carries an
   empty `rawInput` (M1).
5. No match inside the turn, or a mismatch: fail closed, exactly as the
   shared-file gate does today.
6. Context is stamped server-side as in P3; the parked request supplies only the
   model-authored `request` payload.

A stolen token alone therefore produces a parked request that never correlates —
the thief cannot produce a `toolCallId` Verity is waiting on. That is strictly
better than an authenticated channel, and it is **not yet sufficient**.

### Unresolved break: front-running

Correlation on payload alone is broken, and §5 makes the attacker's position
worse than this section originally assumed: by M4 the endpoint **and** its
credential are readable from `/proc`, so a thief is handed the channel rather than
having to find it.

The break itself: if correlation is keyed on payload, payload is all the two
channels share. A thief can submit a request carrying the name and arguments of a
call the agent is about to make; the arriving `session/update` then binds to the
attacker's parked request instead of the agent's. The attacker receives the
secret-tool result and the legitimate request is rejected as the duplicate.
Single-use binding does not fix this — it decides _which_ request consumes the
observation, and the attacker's is simply first. **Payload-keyed correlation is
broken, and no wording here should be read as claiming otherwise.**

M3 supplies the repair this section could previously only wish for. The MCP
request already carries `_meta["claudecode/toolUseId"]`, identical to the ACP
`toolCallId`. Keying on that identity rather than on payload changes what a
front-runner must supply: not a guessable payload, but a specific random
identifier.

Two properties have to hold, and neither is established here.

**Not disclosed.** The value is **not** confined to the stdio channel — the
adapter's own MCP request carries it over HTTP to Verity's endpoint. What must
hold is that no workspace process learns a pending `toolCallId` before submitting
its own request. Verity terminates the HTTP endpoint, so the adapter's request is
not delivered to an attacker, and M6 shows the stdio channel is not readable from
the workspace as spawned today. That is an argument, not a proof: it assumes
nothing else republishes the identifier, and the model-disclosure case below is a
known way for the assumption to fail.

**Not predictable.** This one is weaker, and it is the reason M3 does not by
itself unblock option A. The three identifiers observed have the shape
`toolu_01` plus 24 mixed-case alphanumerics — consistent with a random token, and
consistent with several things that are not. Three samples measure nothing, and
more samples would not help: what is missing is a **contract**. No adapter, SDK,
or provider documentation Verity pins states that tool-call identifiers are
unpredictable, or that they cannot be influenced by conversation content. If they
are derived, sequential per session, or steerable by a prompt-injected model, an
attacker predicts the next one and front-runs exactly as before.

This matters for how the dependency is policed. A presence-and-equality probe —
the obvious thing to build, and the thing suggested for the `_meta` key above —
verifies that the identifier still arrives and still matches. It cannot detect
that the identifier became predictable. The two failure modes need different
instruments, and only the first has a cheap one. Until the second is answered by
an upstream statement or by adversarial testing, correlation keyed on
`toolCallId` is an improvement over payload keying with an **unverified
assumption underneath**, not a closed defence.

M1 supplies the barrier — `session/request_permission` is a request Verity can
hold until it has recorded the expected `(toolCallId, arguments)` pair, so the MCP
handler never has to guess whether an observation is still coming.

That combination is a candidate, not a verified design. Three things must be
settled before it is relied on:

- **The key is not a contract.** `claudecode/toolUseId` is one adapter's private
  `_meta` extension (M3). It needs a build-time probe that fails loudly when it
  changes, and it is **absent on `codex-acp`** (M5) — the backend that actually
  carries the tools. That is what closed option A; the rest of this section
  describes what would have been required had it been present.
- **The model can disclose the identifier.** `toolCallId` is secret from
  repository processes, not from the agent. A prompt-injected model could emit it
  into the workspace while the call is still pending. The window is short and the
  attacker must also beat the adapter's own request, but "short race" is not the
  standard W3/W4 sets, and this is unresolved.
- **Connection binding is still worth having**, now as depth rather than as the
  primary defence. Accept exactly one MCP connection per turn, from the adapter
  Verity spawned, and refuse every later one. Open: whether the adapters connect
  eagerly and exactly once, and whether the startup window can be raced.

### Further open questions

- **Correlation key.** Answered for `claude-agent-acp` (M2, M3): `rawInput` is
  byte-comparable, and a shared `toolCallId` crosses both channels. Unanswered for
  `codex-acp` (M5).
- **Ordering and window.** Answered for `claude-agent-acp` (M1): the update
  precedes the MCP call, with a holdable permission request between them. Still
  open: how long a parked request may wait when the client does *not* hold that
  barrier, before this becomes a liveness bug.
- **Multi-call turns.** Two identical calls in one turn must not collapse into one
  binding. Keying on `toolCallId` rather than payload resolves this as a side
  effect — a further argument for M3's key.
- **Channel reachability.** Answered in §2, M6, and M7 — on the shipped topology,
  not only on this repository's spawner. It holds, and the barrier that holds it
  for the tool-call stream is a libuv detail rather than a Verity guarantee.

### Defense in depth, independent of the above

- Constrain **reachability** of the endpoint, not just its credential. A separate
  network namespace for the adapter child is the starting point and is not
  sufficient by itself: if the two namespaces remain routed to the listener,
  repository processes still connect. Answering W3/W4's "same-UID repository
  processes may call … that channel" requires a concrete, stated isolation —
  listener bound inside the adapter's namespace with no route from the workspace
  namespace, or an equivalent source policy — specified and tested, not assumed.
  None of it answers "or steal".
- Keep the token in the adapter's memory only — never in argv, never on disk.
  **Not achievable on `claude-agent-acp` from the client side** (M4): the adapter
  puts the client-supplied MCP configuration on its child's command line. The
  token has to be treated as public to the workspace, which is why the identity
  key of M3, rather than the credential, must carry the security.
- Per-turn lifetime, revoked at turn settle.

## 7. Decision — resolved 2026-08-08 (ADR 0014)

**Outcome: A is closed, B is deferred, and none of the three was adopted.** M5's
`codex-acp` measurement removed option A — there is no per-call identity to
correlate on the backend that carries the tools — and option B still has no agent
side on either adapter. Option C, shipping nothing, would have frozen the secret
tools on the native transport that ADR 0012 is migrating away from.

The decision taken instead is a fourth: ship the channel with the weaker guarantee
and say so. Secret tools on ACP over HTTP-MCP, no correlation attestation claimed,
operator approval mandatory on every call and not waivable, standing grants capped
at 24 hours with `forever` unavailable and the ceiling enforced at redemption
keyed on the channel, and the approval card rendering the server-side parameters
rather than the model-announced ones. The channel is **approval-gated**, not
attested. See `docs/adr/0014-acp-secret-tools-approval-gated.md`.

The options as they stood when the decision was taken:

- **A — build correlation attestation** on HTTP-MCP as above. **Closed by M5.**
  Unblocks both
  Claude and Codex on their ACP transports. Cost: a new attestation surface with
  its own adversarial test suite. §5 moved this from "cannot be adopted as
  written" to "adoptable on one adapter under stated conditions": front-running
  now has a concrete candidate repair (M3's shared `toolCallId`, M1's holdable
  barrier) rather than none at all, while M4 removes any illusion that the
  per-turn token contributes security. The break is **not closed**: the repair
  assumes tool-call identifiers are unpredictable and not model-influenceable,
  which no upstream contract states and no probe can police. The
  conditions are the three bullets in §6 — chiefly that the key is an undocumented
  vendor extension, and that it turned out to be absent on `codex-acp`, which is
  the condition that closed this option rather than merely constraining it.
- **B — pursue `mcpCapabilities.acp` upstream** and implement the client side
  when it lands. Structurally the better channel: Verity hosts the tools in the
  worker's own address space, so there is no endpoint and no token to steal, and
  no payload correlation to front-run. M4 strengthens this: on the Claude adapter
  today, any HTTP endpoint Verity configures is published to the workspace along
  with its credential, and B is the only option that removes the endpoint rather
  than defending it. It does **not** answer §2's reachability
  question — an attacker who can write into the adapter's descriptors can forge
  this traffic too, and that limit is common to every option here. Cost:
  dependent on an unstable RFD and on two adapters that implement none of the
  agent side today.
- **C — do not flip.** Native Codex stays the sole carrier; `CODEX_TRANSPORT=acp`
  stays an opt-in that silently drops the tools, and Claude never gets them.

> Resolution (2026-08-24): ADR 0014 chose a fourth, deliberately weaker security
> contract: approval-gated tools over HTTP-MCP without attestation. That channel is
> implemented, and ADR 0012 Amendment 3 subsequently removed the native Codex
> rollback entirely. Option C remains here as historical decision input only.

A needed two answers before any build. The first was whether tool-call identifiers
carry an unpredictability guarantee — an upstream question, and the one that
decides whether the whole approach stands. It was never answered, and it no longer
matters: the second question settled A on its own. M1 through M3 were repeated
against the adapter that actually carries the tools, and `codex-acp` carries no
per-call identity at all (M5). A collapses back to payload correlation for the
backend that matters, which is the shape §6 already showed front-running defeats.

B therefore remains the only option that would restore the property in §2, and it
is deferred rather than abandoned: it is still cheap to start upstream, and if
`mcpCapabilities.acp` lands it replaces the approval-gated channel rather than
supplementing it. What ships in the meantime does not claim the property — that is
the whole content of ADR 0014.

Two findings stand independently of A, B, or C:

- **M4 is a live defect in the flip condition, not a design note.** ADR 0012 named
  "an authenticated HTTP-MCP tool channel with a per-turn token" as the condition
  for flipping the Codex default. On `claude-agent-acp` that token is world-
  readable in `/proc`. That condition is now withdrawn in ADR 0012 and replaced by
  ADR 0014, which treats the token as authentication against unrelated callers and
  not as a boundary against the workspace at all.
- **§2's P1 assumption is now answered on the shipped system, written down, and
  tested.** M7 attempted every reach a repository process has at the channel and
  measured all of them refused, so the invariant holds where it is deployed and
  not only where this repository's spawner runs. What it holds on is uneven: the
  worker's UID split and the broker socket's group protect processes that are not
  the tool-call stream, while the stream itself depends on child stdio being a
  socketpair rather than a pipe — the same attack lands on a pipe from the same
  position. That dependency now has a regression test over both spawn paths. It
  was an undocumented assumption until this document, which is the part worth
  remembering: it held by luck of the spawn path, not by design, and it is the
  weakest of the three barriers rather than one among equals.

## 8. Out of scope

- `opencode-mcp` remains blocked behind ADR 0010 O1 (`opencode` is absent from
  `SUPERVISED_WORKER_BACKENDS` and has no turn driver on the runner path). It is
  not reachable by this work.
- ADR 0010 C3 concerns Codex's own credential, not the tool channel, and neither
  blocks nor is blocked by this.
