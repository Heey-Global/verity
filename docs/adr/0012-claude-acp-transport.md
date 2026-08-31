# ADR 0012: Agent transport over ACP v1

- Status: accepted
- Date: 2026-08-03 (extended 2026-08-05 for Codex; amended 2026-08-19, 2026-08-24 and
  2026-08-25)

## Context

Verity previously integrated each coding agent through its own native protocol:
Claude Code through its `stream-json` and control protocols, Codex through its
app-server JSON-RPC. Those paths work, but every agent-specific lifecycle, event,
permission, steering, and resume detail must be maintained in Verity, once per
agent.

The maintained ACP adapters now cover the agent features Verity depends on:

- `@agentclientprotocol/claude-agent-acp` — session load, images, tool and
  permission updates, steering, background tasks, subagent attribution, model and
  mode configuration, and usage events.
- `@agentclientprotocol/codex-acp` — `loadSession`, inline image prompt blocks
  (`promptCapabilities.image`), steering (`_session/steering`), agent modes, and
  the model as a standard ACP session config option. It also advertises
  `mcpCapabilities.http`, which is the hook a future authenticated tool channel
  would use.

ACP is a transport contract, not a security boundary. Verity must not move
credentials or privileged execution into the ACP process merely because the
wire protocol standardizes those interactions.

## Decision

Use stable ACP v1 as the agent transport. The transport core is agent-neutral
(`packages/session/src/acp-backend.ts`); each agent contributes only a profile —
its adapter command, its `_meta` namespace, its session options, and how a
session is configured after it opens. The original rollback policy is superseded
for both agents by Amendments 1 and 3.

- **Claude**: ACP is the only project-session transport. Project sessions fail closed
  when their Sandbox supervisor is unavailable instead of silently changing transport.
  Control-plane sessions use a dedicated supervisor service with private runtime and
  egress-identity volumes; they fail closed rather than running Claude in the Server.
- **Codex**: ACP is the only transport. Brokered tools use the approval-gated MCP
  channel from ADR 0014; see Amendments 2 and 3.

The ACP client runs inside the Verity Runner worker. Each ACP agent is a separate
unprivileged process launched only through the existing sandbox spawn broker, and
only when a project or dedicated control-plane supervisor is available; without
one, Claude fails closed rather than spawning ACP from the credential-bearing
Server process. The client does not advertise ACP filesystem or terminal
capabilities; agent tools continue to execute inside the project sandbox.

The Codex profile uses `agent-full-access`, the ACP spelling of
`approvalPolicy: 'never'` + `sandbox: 'danger-full-access'`, because the project
container is Verity's isolation boundary and there is no Codex approval UI.

The following remain Verity-owned and outside ACP:

- canonical event persistence and persist-before-publish ordering;
- Runner leases, durable turn frames, reconnect, and crash recovery;
- project/worktree and network isolation;
- the Claude credential gateway and fixed non-secret sandbox placeholder;
- GitHub, signing, and secret brokers;
- permission audit and fail-safe denial;
- backend handoff context and Verity-specific response contracts.

Pin `@agentclientprotocol/sdk` and both adapters to exact versions. ACP v2
remains out of scope while its wire contract is draft.

Pinning is necessary but not sufficient. The adapters build tool-call *titles*
straight out of model-authored tool input, which is untrusted JSON — a tool
schema is a request to the model, not a guarantee. In `claude-agent-acp` through
0.66.0 a `WebSearch` carrying a string `allowed_domains` (or a `ReportFindings`
carrying a non-array `findings`) throws inside that builder; the throw escapes
the SDK query stream, the adapter exits 1 without a terminal event, and Verity
settles the turn as `crashed`. Because `session/load` replays persisted history
through the same builder, the offending block then re-throws on every resume and
the session is unrecoverable — a cosmetic label costs the whole conversation.
Other branches fail more quietly: `Task` and `Bash` return the raw input field as
the `title`, and `Write` as a location `path`, so a wrong-typed field there hands
the ACP schema a non-string instead of throwing. Until upstream guards it,
`verity-claude-acp-harden.mjs` wraps the builder at image build time, in both the
server image and the sandbox toolkit, catching the throws and normalising the
returned title and locations, so a title can only ever degrade and never
terminate a session. The wrapper goes on unconditionally while the seam exists:
probes decide which known-field guards still apply and verify the result, but
they only know the fields that broke yesterday, so they never decide whether to
protect at all. The build fails if the wrapper can no longer be applied — an
unhardened adapter is indistinguishable from a hardened one until a session
dies — which is the signal to re-derive the seam or, if upstream has published
its own boundary, retire the script with its two call sites.

## Security invariants

1. The root spawn broker accepts `claude-agent-acp`, `codex-acp` and `opencode-acp`
   only as fixed executables; a request cannot substitute an arbitrary path. Each
   name maps to exactly one executable, which is why `opencode-acp` is a root-owned
   wrapper rather than the `opencode` CLI: a name that reached the multi-purpose
   binary would let the caller's argv pick the subcommand it starts in (Amendment 4).
2. Each ACP child receives the same allowlisted environment as its native
   counterpart. Real OAuth/API tokens are never copied into the sandbox child;
   the validated local connector URL enables only Verity's fixed placeholder
   credential. `CODEX_PATH`, `NO_BROWSER`, and `INITIAL_AGENT_MODE` are set by
   the broker and never taken from a request — each adapter ships its own bundled
   agent CLI, and an unpinned one would run outside the image's Renovate pin.
3. ACP client filesystem and terminal methods are not advertised.
4. Unsupported or unavailable permission choices resolve to cancellation or a
   one-shot rejection, never implicit approval.
5. Verity resumes existing agent context with `session/load`, which the client
   consumes without re-emitting replayed history; Verity's canonical history is
   never duplicated. A load the adapter refuses reports no session bind, so the
   session recovers cold instead of resuming the same refused conversation
   forever.
6. Native secret-tool attestation is not claimed for ACP. This half of the
   invariant stands, and ADR 0014 does not lift it: what ships under that ADR is
   approval-gated, so no ACP channel may be described as attested. It is not a
   statement that attestation is impossible everywhere — measurement found no
   per-call identity on `codex-acp`, which is the adapter that carries the tools,
   while `claude-agent-acp` does expose one and leaves correlation attestation
   conditionally viable there (see the Consequences section and
   `docs/ACP_ATTESTED_TOOL_CHANNEL_DESIGN.md` §5). Building it remains open work
   with unresolved conditions; until it is built and reviewed, the claim is not
   available on any ACP channel.

   The second half — that the ACP transport carries none of `verity_secret_job`,
   `verity_http_request`, or `verity_secret_run`, and that the runner worker
   rejects those flags for any backend other than native `codex` — is
   **superseded by ADR 0014**. It describes the state of the system until that
   ADR is implemented, not a rule the implementation must preserve: ADR 0014
   ships those tools on ACP under an approval gate instead of an attestation, and
   removing the backend check is part of that work. Until then the check stays,
   because a channel that is neither attested nor yet approval-gated is neither.

## Consequences

Verity gains a reusable, agent-neutral ACP client: adding the Codex transport
reused the whole stream/permission/steering/cancel core and contributed only a
profile. The sandbox image grows by the two pinned ACP adapters.

Codex over ACP also gains mid-turn steering, which the former native transport
could not do.

The cost is why `native` stays the Codex default: Verity's native secret tools
ride Codex app-server `dynamicTools` with an attested `requestNativeTool` relay,
and ACP has no equivalent. Flipping the default today would remove a shipped,
security-reviewed capability — including the operator approval that gates
`verity_http_request` and `verity_secret_run` — from the one backend that has it.
Because `nativeHttpTool` / `nativeTrustedCliTool` are server-global rather than
per-project, no capability-aware automatic fallback is possible either.

The original condition for the default flip was "an authenticated HTTP-MCP tool
channel with a per-turn token", which codex-acp accepts via
`mcpCapabilities.http`. **That condition is withdrawn — it cannot be met as
worded.** A per-turn token configured inside the agent child is the shape
`BROKERED_SECRETS_W3_W4_CONTRACTS.md` §4.1 declares insufficient, because same-UID
repository processes can reach or steal it. Measurement on 2026-08-08 turned that
from an objection into a fact for Claude: `claude-agent-acp` passes the
client-supplied MCP configuration on its child's command line, so the URL and any
`Authorization` header are readable from `/proc/<pid>/cmdline` by any workspace
process. `codex-acp` passes its equivalent over app-server stdio instead and does
not share that leak. See `docs/ACP_ATTESTED_TOOL_CHANNEL_DESIGN.md` for the
conflict, the spike showing `mcpCapabilities.acp` is unavailable on both adapters,
the measurements, and the resolution options.

The successor condition is **ADR 0014**, which stops trying to reconstruct the
native attestation on ACP and states a weaker guarantee openly instead: the
secret tools ship on ACP over HTTP-MCP, no call resolves a secret without an
operator decision covering it and no configuration can turn that off, standing
grants on that channel expire after 24 hours with no `forever`, and the approval
card renders the parameters the server received rather than the ones the model
announced. The correct word for that channel is **approval-gated**, not attested —
so invariant 6's attestation clause holds for everything shipping today, while its
"ACP carries no secret tools" clause is the part ADR 0014 supersedes. The clause
is not a bet that attestation is unreachable: it lapses for whatever later
implements and reviews it, whether that is correlation attestation on
`claude-agent-acp` or the ACP-hosted channel of ADR 0014 D6. Until ADR 0014 is
implemented, `CODEX_TRANSPORT=acp` remains an explicit opt-in for projects that do
not use the native secret tools.

## Amendment 1 (2026-08-19) — the native Claude transport is removed

The Decision above kept the native backends "available as explicit rollback
paths during migration". For Claude that migration is over: ACP has been the only
Claude transport in production since the Agent Credential Gateway (ADR 0010) took
the OAuth token out of the sandbox, and the native path could no longer run
there — it authenticated with a credential the sandbox is deliberately not given.
A rollback path that cannot execute is not a rollback path; it is code that still
has to be read, typed, reviewed, and kept honest by tests.

So the native Claude transport is deleted, not deprecated: the `claude -p
--output-format stream-json` runner, its stdio control protocol (`initialize`,
`can_use_tool`, `control_response`), the `ClaudeBackend`/`live-claude-backend`
pair, and the `'claude'` worker/supervisor backend identifier. `AcpClaudeBackend`
is the only Claude backend that exists.

Three things survive the deletion because they were never really transport:

- The `PermissionRequest` / `PermissionDecision` vocabulary, which the stdio
  protocol introduced but ACP, Codex, the runner protocol, and the approval card
  all still describe prompts in. It stays in `@verity/adapter-claude` as a leaf
  contract.
- The generic `Spawner` / `SpawnedProcess` seam, including `keepStdinOpen` — ACP's
  JSON-RPC channel needs exactly the held-open pipe that streaming stdin was built
  for.
- The brokered grant vocabulary; Amendment 3 removes its final native transport.

This amendment did not change the Codex half of the Decision at the time. That
part is superseded by Amendment 2 below.

## Amendment 2 (2026-08-24) — Codex defaults to ACP

ADR 0014's approval-gated HTTP-MCP channel is now implemented for both ACP
adapters. The Runner mints a per-turn gateway credential, advertises the MCP
server to `codex-acp`, and retires the credential when the turn settles. This
restores `verity_http_request`, `verity_secret_run`, and control-plane delivery
tools on the ACP path without claiming the native relay's stronger attestation.

Codex therefore follows Claude onto the shared ACP runtime by default. An unset
or empty `CODEX_TRANSPORT` selects `acp`; `CODEX_TRANSPORT=native` is the explicit
rollback to app-server JSON-RPC. Unknown values fail startup instead of silently
selecting the rollback. The native backend remains maintained for rollback, but
new and existing deployments use ACP unless they deliberately opt out. This
temporary rollback policy is superseded by Amendment 3.

## Amendment 3 (2026-08-24) — the native Codex transport is removed

The ACP rollout is complete. Verity no longer contains the direct Codex app-server
driver, its dynamic-tool attestation mailbox, the `codex` Runner worker protocol,
or `CODEX_TRANSPORT`. `codex-acp` is the only Codex execution path, and brokered
tools are available only through the approval-gated MCP gateway. The former
transport variable no longer selects behavior or receives compatibility handling.

## Amendment 4 (2026-08-25) — OpenCode joins the ACP runtime

Amendment 3 said "the ACP rollout is complete", and for the two agents this ADR
was written about it was. OpenCode was the exception it did not mention: it kept a
transport of its own, a client of a long-lived shared `opencode serve` reached over
an operator-supplied `OPENCODE_BASE_URL`. That transport is now removed too, and
`opencode acp` runs as a supervised ACP child like the other two.

The native path was the odd one out in every way this ADR cares about. Its agent
process was not Verity's to launch: an HTTP server outside the Sandbox, addressed
by URL, so the spawn broker, the sandbox isolation boundary, and the whole
credential posture the broker exists to enforce simply did not apply to it. It
could carry no permission bridge — there was no child to gate — so `plan` was
advisory rather than enforced. And the SSE plumbing that made it look like a
backend was roughly 1.5k lines of Verity-maintained adapter, event mapping, and
client code, all of which the shared turn loop already does for ACP agents.

What replaces it contributes a profile and nothing else:
`packages/session/src/acp-opencode-backend.ts`. Isolation, permission cards,
cancellation, steering, resume, and persist-before-publish ordering come from
`acp-backend.ts` unchanged. Six things were genuinely new:

- **The command is a wrapper.** OpenCode speaks ACP as a subcommand, not as a
  separate binary, so `verity-sandbox-toolkit` generates a root-owned
  `/usr/local/bin/opencode-acp` that is exactly `exec opencode acp "$@"`. This is
  what keeps Security invariant 1's one-name-to-one-executable property true; the
  broker never learns the name `opencode`. It is written whenever opencode itself
  is installed, not only when the runner-supervisor option is on: the name is what
  the session backend spawns through whichever Runner carries the turn, so gating
  the file on one deployment option would make a present CLI unreachable.
- **The mode is a config option, not an ACP mode.** Measured against opencode
  1.18.21: `session/new` answers with `configOptions` for `model` and `mode` and
  advertises **no** ACP `modes` block. So the profile states no `sessionMode` and
  the shared loop's `session/set_mode` path stays disarmed — sending it would be a
  request this agent does not implement. Verity's postures collapse into OpenCode's
  two modes: `plan` maps to `plan`, everything else to `build`. Because that
  collapse yields one of two literals, no caller-supplied string can become the
  session's mode, which is why the profile declares no `permissionModes` vocabulary
  under the §5b invariant. The mode is asserted after the model and unconditionally
  — the `currentValue` snapshot predates the model write, and for a permission
  posture a stale read fails in the dangerous direction. A `plan` that cannot be
  asserted **fails the turn**: the option may be missing on an older opencode, or
  the session's vocabulary may not contain `plan`, and in both cases the only thing
  standing between the turn and live edit tools is gone. That is the one place where
  a posture and a preference part ways — an unavailable *model* is survivable and
  earns a notice, and `build` asserts nothing the session does not already do.
  Which is also the honest limit of the mapping: `build` is a claim about what
  Verity asserts, not about what the agent may then do. Which tools `build`
  permits, and whether they are auto-approved, is settled by the operator's own
  opencode config, and Verity cannot read that decision out of the protocol.
  What it does hold is the near side: every `session/request_permission` the
  agent raises becomes a Verity permission card, so a tool that asks is gated.
  A tool the operator's config auto-approves never asks, and nothing on this
  transport would see it. The same config decides what `plan` itself permits, and
  it lives in a volume every project's agent can write, so the enforcement this
  bullet describes is only as strong as that file — recorded as a known bypass in
  ADR 0010's O2 bullet, which the per-project generated config closes.
- **`VERITY_EXTRA_MODELS` is the picker catalogue.** The retired transport
  enumerated providers over `GET /config/providers`. ACP's only equivalent is
  `session/new`, so live enumeration would mean spawning an agent per picker
  refresh. The operator's pinned list is the better trade, and `VERITY_OPENCODE_ENABLED`
  turns the route on: a deployment that has named no models has nothing to route.
  `OPENCODE_BASE_URL` — which used to be the whole of OpenCode's
  configuration, and whose presence turned the route on by itself — now **refuses the
  boot** when it is set and the new flag is not. Ignoring it would leave an upgraded
  deployment looking healthy while every stored provider-qualified id routes to
  Claude and fails there on an unknown model, one confusing session at a time; a
  refusal names both replacement variables at the moment the upgrade happens.
  It can only fire on env the operator supplied: no compose file, env template or
  deploy manifest in this repository sets `OPENCODE_BASE_URL`, so the deployments
  that meet the refusal are exactly the ones that were using the retired
  transport and need to hear about it. Both remedies it names are one env edit
  and a restart.
- **`XDG_CONFIG_HOME` is forwarded** to `opencode-acp` children only. The
  provisioner mounts OpenCode's config volume under it, so without the forward the
  agent would start with no provider configured.
- **Existing sessions migrate by being refused.** A session that ran on the native
  transport carries a `session_backend_state` bind minted by `opencode serve`, and
  no `opencode acp` will ever know one. Its first post-upgrade turn therefore
  resumes into a `session/load` the agent answers with -32002 — and because a
  refused resume mints no id, nothing replaces the dead bind, so every later turn
  would repeat it: a permanent wedge, one per pre-upgrade OpenCode session. Rather
  than a one-shot data migration, the backend now reports an **answered** resume
  refusal as `RunResult.staleResume` and the conductor drops the bind and retries
  cold with the transcript as handoff context. This is deliberately
  backend-neutral and not tied to the upgrade: an agent that pruned its own history
  or a replaced config volume produce the same refusal, and a data migration would
  fix only the one instance of it that this amendment happens to create. An
  unanswered failure — the adapter died, the pipe broke — says nothing about the
  conversation and leaves the bind alone.
- **One capability is dropped: `query()`.** The retired backend implemented the
  one-shot side channel Verity uses to name a session, and ACP has no such
  channel — a title would cost a second agent process per session. `Backend.query`
  is optional and every call site is already guarded, so an OpenCode session simply
  keeps its fallback title, exactly as a Codex one does.

The rollout has a container-shaped ordering constraint the two earlier amendments
did not. `opencode-acp` becomes a supervised backend in the Server, but the file
it names is written by `verity-sandbox-toolkit`, and those ship as separate
artifacts on separate clocks (ADR 0006 D9). A Sandbox still running a pre-upgrade
toolkit image has neither the wrapper nor `opencode-acp` in its own worker
backend list, so an OpenCode turn there is refused by the supervisor's
`workerBackends` gate. That refusal now names the case: it lists the backends the
image does support and says that a backend the Server offers but the image lacks
means the container predates it — because nothing else in the session can deduce
"rebuild the image" from a bare unsupported-backend line. Naming it is all the
supervisor can do; the Server cannot install a binary into a container it does not
build. So the upgrade order is: republish the Feature, rebuild the base image and the
derived devcontainer images against the new ref, then recreate the project
containers. Deployments that never enabled OpenCode are unaffected, because no
model routes there.

Control-plane sessions do not get OpenCode. Every ACP backend is otherwise routed
to the dedicated control-plane Runner when its turn has no project of its own, and
`opencode-acp` would be too — but that Runner is one fixed container the deployment
launches, not a Sandbox the provisioner composes: it mounts no OpenCode config
volume, sets no `XDG_CONFIG_HOME`, and holds egress certificates for the Claude and
Codex gateways only. Such a turn is refused by name at the routing seam
(`embedded.ts`) rather than allowed to fail inside the first prompt, and the
loopback is not an alternative — ACP must never start in the credential-bearing
Server process. Giving that container OpenCode's configuration is a deployment
change, and until it is made, a control-plane session stays on Claude or Codex.

Brokered secret tools stay off this transport. `opencode-acp` does advertise
`mcpCapabilities.http`, the same hook ADR 0014's approval-gated gateway uses on the
other two, so this is not a capability gap — it is a decision not yet taken about
which agents may spend the operator's secrets. Until it is, `opencode-acp` is
absent from `ACP_WORKER_BACKENDS` and from `carriesBrokeredSecretTools`, no gateway
bearer is minted for its turns, and the runner worker's own gates name their two
members rather than asking whether the transport is ACP. That is the posture the
native path had, so nothing is lost by carrying it across; admitting OpenCode later
is a one-line change in each of those places plus the review that justifies it.
