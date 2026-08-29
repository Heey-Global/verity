# ADR 0010 — Agent Credential Gateway

**Status:** Accepted · **Date:** 2026-07-21 · **Implementation update:** 2026-08-21

## Context

Verity runs agents inside project Sandboxes and treats project code and agent
processes as untrusted. Agents must be able to use providers (Claude, Codex,
OpenCode) without ever holding long-lived credentials. At the time of this
decision, the state was inconsistent and the one hardened path was coupled to
the Server lifecycle. This context and the review findings below are the
historical input to the decision; the current state is summarized under
Implementation status.

- **Claude** could route through a local Sandbox connector and an mTLS egress
  gateway that injects the OAuth token upstream
  (`packages/server/src/claude-egress-gateway.ts`), so no real credential
  existed in the Sandbox. But the gateway ran **inside the Server process**:
  its listener drained for only 5 seconds on shutdown before
  `closeAllConnections()`, so every Server deploy killed all in-flight Claude
  streams mid-response. The gateway URL was the Server's own DNS name
  (`https://verity:9443`), baked into each Sandbox's container environment at
  create time (`packages/server/src/provisioner.ts`).
- **Codex** originally received a writable `auth.json` bind-mounted into every
  Sandbox, and the CLI refreshed the ChatGPT OAuth token by rewriting that file.
  Verity launches Codex with `--dangerously-bypass-approvals-and-sandbox`
  (`packages/session/src/codex-backend.ts`), so project code executes as children
  of the Codex process under the same identity. That made the refresh token
  directly exfiltratable and motivated the Phase 3 gateway cutover described
  below. Server-side model discovery and control-plane environments also
  materialized the credential before that cutover.
- **OpenCode** has no Verity-managed deployment at all — only an
  operator-supplied `OPENCODE_BASE_URL`. The Server process itself is the turn
  driver (an in-memory `await` per turn in
  `packages/session/src/opencode-backend.ts`), the OpenCode HTTP API has no
  authentication or tenant scoping, and `opencode serve` executes agent tools
  (bash, edits) in its **own** process — outside every Sandbox hardening
  boundary. A shared config volume (`opencode-config-verity`) is mounted
  writable into all project Sandboxes, allowing cross-project config
  poisoning.

This ADR was reviewed adversarially from four perspectives (gateway
extraction/lifecycle, Codex feasibility, OpenCode isolation, threat
model/operations) against the actual code. The findings below shaped every
design decision; earlier drafts treated several of them as already solved.

Key review findings this ADR must answer:

1. A "gateway stays sealed after restart until the Server re-authorizes it"
   rule contradicts "the gateway must not depend on the Server" — a gateway
   crash during a Server deploy would leave nobody able to unseal it.
2. The Claude refresh token is single-use and rotating; refresh is deliberately
   serialized through one Server-side queue with Postgres persistence. A
   memory-only gateway that refreshes during a Server outage and then crashes
   destroys the credential permanently, and extraction would otherwise create
   two racing token consumers (gateway vs. Server usage poller and
   control-plane sessions).
3. The gateway address is the Server's DNS name, fixed per Sandbox at create
   time — the listener cannot move to another container transparently.
4. A privileged Codex launcher is unsound as long as Codex executes project
   code under its own identity; endpoint redirection for the Codex CLI is
   unproven in this repository.
5. Moving `opencode serve` "next to the credentials" would place untrusted
   code execution inside the credential boundary; the coupling to break is the
   Server-process turn driver, not the serve process location.
6. Certificate lifecycle gaps: the gateway leaf (90-day validity) has no live
   TLS reload (today masked by Server restarts), Sandbox client certs have no
   rotation path into running containers, certs are project-bound only (not
   Sandbox-generation-bound), and revocation is an in-process callback.
7. Loopback inside a Sandbox is not a security boundary: any process can use
   the connector and spend provider quota, with or without an active turn.

## Decision

Verity introduces a standalone, long-lived **`verity-agent-gateway`** service
as the single credential boundary for all agent backends. The Server controls
the gateway over a dedicated channel but is no longer in the data path of a
running provider stream. The gateway never executes project code or agent
runtimes.

The extraction is explicitly an infrastructure redesign, not a code move: the
portable part was the existing data-path handler; bootstrap trust, bindings
distribution, credential delivery, revocation, and unsealing were designed in
Phase 0 before the process moved.

### Implementation status (2026-08-21)

The standalone extraction and provider routing in Phases 1–3 are implemented
for Claude and Codex. `verity-agent-gateway` has a private control socket,
encrypted Claude and Codex spill files, live TLS reload, and versioned peer
bindings. Project and control-plane agent runtimes receive placeholders rather
than provider credentials; their local connector reaches the project-bound
relay and mTLS gateway listeners. Claude and Codex both fail closed when that
path is unavailable.

Phase 0's token-authority target is only fully realized for Codex: the gateway
serializes Codex refresh, writes it ahead to the encrypted spill, and reports
the rotated bundle back under revision checks. Claude refresh remains owned by
the Server's `claudeCredentialSync`, which projects the current access token to
the gateway and serves `/provider-limits`. The gateway is the Claude data-path
credential boundary, but not Claude's refresh authority. Running Sandbox client
certificate rotation also remains recreate-based, as the certificate-lifecycle
section specifies.

The Claude policy admits only the two Messages API endpoints described below.
The Codex policy admits only `GET /codex/models` and `POST /codex/responses`,
which the gateway maps to the fixed ChatGPT subscription upstream. Hermetic
end-to-end and deployment smokes cover placeholder replacement, cross-project
peer refusal, restart/unseal recovery, policy-before-credential ordering, and
the absence of real credentials from runtime homes.

Phase 4's remaining half (OpenCode O2 — its provider key is still mounted into
the Sandbox from a shared volume; see the 2026-08-25 update below), Sandbox-generation
certificate binding, and turn-scoped gateway grants remain roadmap work. They are
not prerequisites for, or claims about, the deployed Claude and Codex credential
boundary.

### Security invariants — current vs. roadmap

Already true today (Claude and Codex paths, egress routing enabled):

- No long-lived provider credential inside the Sandbox; only a non-secret
  placeholder token.
- Fail closed: no upstream call without a validated mTLS identity and policy
  check.
- The mTLS client key is not readable by the agent uid.
- Hardcoded upstream origin; redirects rejected (no SSRF).
- Exact inference allowlist: only `POST /v1/messages` and
  `POST /v1/messages/count_tokens`, optionally with the CLI's `?beta=true`
  (allowlisted by exact name and value); every other query parameter, alternate
  method, fragment, and account/admin/usage/batch path is rejected before
  credential resolution.
- Exact Codex allowlist: only `GET /codex/models` and `POST /codex/responses`,
  with no query or fragment, mapped to fixed `chatgpt.com/backend-api/codex/*`
  upstreams.
- Error responses toward the Sandbox are credential-free.
- Every proxied Claude and Codex request is observable without retaining request
  content. Gateway and Sandbox connector each report one record per request —
  outcome (`rejected` / `cancelled` / `aborted` / `consumer-closed` / `completed`), reason, status,
  method, route, bytes forwarded, and duration. The gateway additionally records
  allowlisted query parameter names (all others become `<other>`) and the
  pseudonymous project id;
  the Sandbox connector records neither. The Codex gateway records only its two
  allowlisted routes and never query names because Codex queries are forbidden.
  Never headers, body, query values,
  client address or certificate detail.
  Policy failures and every other reason are recorded as fixed CLASSIFIED
  labels (`policy-rejected`, `Error/ECONNRESET`, `sandbox-closed`, `downstream-closed`, `ok`), because provider and
  network errors can quote upstream response detail. Fields are charset-filtered
  and length-capped and anything unexpected collapses to `<other>`, so the log
  cannot be used as a side channel by the Sandbox. `cancelled` means the Sandbox
  disconnected before response headers; `aborted` is the record that
  makes a mid-response break attributable to a side at all. Codex HTTP 200
  responses with bytes already forwarded are instead `consumer-closed` when the
  downstream closes before Node marks the response finished: without parsing
  SSE content, the gateway cannot distinguish a consumer that received its
  logical result from one that stopped early, so this outcome is neutral.

Roadmap (new work; earlier drafts wrongly listed these as invariants):

- **Sandbox-generation binding.** Certificates are project-bound only and are
  reused across recreates. Generation-scoped issuance and rotation are new.
- **Turn-scoped grants.** Any Sandbox process can use the connector at any
  time and burn quota. This is an **accepted, documented risk of the first
  release**. The remedy: the runner supervisor issues a short-lived turn token
  at turn start; the connector attaches it; the gateway rejects requests with
  no active turn (with a small grace window for trailing traffic).
- **Turn-aware enforcement and broader audit/rate limiting.** Data-minimized,
  classified request-end telemetry now exists for both provider paths, including
  success, rejection, cancellation, mid-stream aborts, duration, and forwarded
  bytes. Per-turn authorization, gateway-side spend limits, and an audit sink
  beyond container logs remain their own work packages.

### Phase 0 — four designs completed before the process move

**Unseal protocol.** The gateway keeps secrets in memory **and** in a local
encrypted spill file. The file key is delivered only at unseal time by the
Server and never persisted by the gateway. After a gateway restart the gateway
is sealed but the spill file is complete (including the latest rotated refresh
tokens); **any live Server instance** — old or new — can unseal, and unseal is
idempotent. Deploy orchestration guarantees the old Server does not stop until
the new one can reach the gateway, reducing the "no Server alive" window to
genuine double failures. Honest residual: if the gateway and all Servers die
simultaneously, Claude is down until a Server starts — strictly better than
today, where every Server deploy kills all streams. This trade is accepted
deliberately.

**Token authority.** The gateway becomes the **single refresh authority**.
Exactly one serialized refresh queue (as today, relocated). Rotated tokens are
written to the encrypted spill file **before** use (write-ahead), then reported
asynchronously to the Server for Postgres backup — there is no moment where the
only valid token exists solely in volatile memory. Residual: between the
write-ahead and the Server report-back the spill file is the only durable
holder of the newest rotated token; losing the gateway's disk inside that
window destroys the credential. Report-back is therefore immediate and retried
until acknowledged, and this residual is accepted alongside the unseal
residual above. The Server usage poller and
control-plane sessions obtain access tokens **from the gateway** over the
control channel instead of refreshing themselves, so there are never two
redeemers of the same rotating refresh token. The legacy injection path and the
Server-side queue stay until the gateway serves those consumers; only then are
they removed.

**Current provider split.** Codex implements this target. Claude deliberately
retains `claudeCredentialSync` as its Server-side refresh authority; only its
current access token crosses the private control channel into the gateway.
Completing the Claude authority relocation remains Phase 0 follow-up work.

**Discovery.** A new stable name `verity-agent-gateway` on the Sandbox networks, with
a matching SAN in the gateway's server certificate. New and recreated Sandboxes
get the new URL. Existing Sandboxes are **recreated on a rolling basis** — this
is lossless since the Sandbox-recreate work (sessions demonstrably survive
recreate; the live smokes exist for exactly this). No DNS takeover of the
Server name, no transitional proxy inside the Server. The connector reconnects
with backoff to this one stable address; gateway updates run blue/green behind
the stable name, not via connector-side failover.

**Certificate lifecycle.** The CA stays with the Server (issuance, rotation,
ownership unchanged); the gateway receives its leaf, the CA bundle, and peer
bindings over the control channel. The gateway gets **live TLS reload** — a
long-lived process cannot rely on restarts to pick up a rotated 90-day leaf.
Peer bindings are pushed as a **versioned full-state sync** with periodic
reconciliation; revocation is a push with defined semantics: if the control
channel is down beyond a threshold, the gateway fails closed for **new**
connections while existing streams drain. Client-cert rotation into running
Sandboxes: the connector learns to reload its material and the Server's
reconcile loop projects renewed material into the container; until then,
Sandbox recreate is the rotation path. CA rotation remains an all-projects
event handled as planned maintenance with rolling Sandbox recreates — not sold
as transparent.

### Claude adapter (Phases 1–2, implemented)

Data path unchanged: connector → mTLS → policy → credential-header strip →
OAuth token injection → bidirectional stream. Scope stated honestly: the
portable part is the data-path handler; the control channel (bootstrap trust,
bindings push, credential delivery, revocation RPC, and the "authorized but
credential not yet delivered" state — today's 503 + `retry-after`) is new code.
The Phase 2A Anthropic inference policy admits only the two exact Messages API
POST endpoints; the Server-owned usage poller remains a separate trusted
consumer and never traverses the Sandbox adapter. The control listener must
never share a network with Sandboxes (the data listener already binds on the
shared Sandbox network).

Phase 2B gives the credential boundary the unambiguous runtime and DNS name
`verity-agent-gateway`; `verity-gateway` remains reserved for the separate
control-plane front door from ADR 0008. The old Compose service key and DNS name
temporarily address the same process so Compose upgrades it in place instead of
orphaning a live Canary gateway; a transition SAN keeps those existing connectors
alive. Global routing is a rolling cutover: only a Sandbox stamped with the exact
standalone target routes there, so enabling the global switch never points an old
Sandbox at a missing connector. Phase 2C removes the compatibility name after the
fleet is recreated, moves token authority, and removes the second consumer.

**Second consumer removed (2026-08-19).** The Server no longer resolves a Claude
access token for any turn. `sessionBackend` refused a Claude turn on a non-ACP
transport, dropped the three branches that fetched `getAccessToken()` for a
control-plane or project agent, and `claudeEgressAgentEnv` lost its `accessToken`
option — the only `CLAUDE_CODE_OAUTH_TOKEN` an agent process can now receive is
the non-secret egress placeholder.

A deployment without a configured egress identity and connector port therefore
cannot serve a Claude turn at all, and says so rather than falling back to a
directly injected credential. Two separate mechanisms cover that, which is worth
spelling out because the project refusal alone looks incomplete: control-plane
turns require `controlPlaneRunner`, and the Server already refuses to *start* with
that enabled and the egress identity wiring incomplete, so those branches cannot
be reached in such a deployment at all; project turns have no start-up equivalent
and are refused per turn by `claudeProjectEgressRefusal`, before any preparation
work is sequenced.

`claudeCredentialSync` remains the single token authority: it exists to project
the credential to the gateway and to `/provider-limits`, never into an agent
environment.

### Codex (Phase 3, implemented) — privileged launcher rejected

A privileged Codex launcher (a protected runner identity that can read
`auth.json`) is **rejected**: Verity launches Codex with
`--dangerously-bypass-approvals-and-sandbox`, so project code runs as child
processes under the Codex identity — a protected identity would hand the
credential straight to the attacker. Instead:

- **C1 — Declare and contain the status quo.** `auth.json` in the Sandbox is
  exfiltratable today; documented as a known risk. Inventory and consolidate
  the server-side `auth.json` consumers (model catalog, control-plane env) so
  a later migration is complete. The code-grounded inventory is recorded in
  _C1 — status-quo inventory_ below.
- **C2 — Network-adapter spike: passed.** A live spike against the deployed
  Codex CLI 0.144.6 passed all three hard gates. A custom model provider
  redirected both `/backend-api/codex/models` and
  `/backend-api/codex/responses` to a local connector. Codex held only a dummy
  API key; the connector replaced it with ChatGPT subscription OAuth plus
  `ChatGPT-Account-Id`, and a real turn completed successfully. The upstream
  response carried populated `x-codex-*` quota headers, including plan,
  primary and secondary usage windows, reset times, credits, and safety
  buffering, and transparent response forwarding preserved them. The result
  is CLI-version-specific and must be reverified when the pinned Codex version
  changes.
- **C3 — Migrate through the generic gateway.** The spike selects the gateway
  path instead of re-enabling Codex's own sandbox. Generated provider config
  points Codex at the local `/codex` connector; the Sandbox receives a dummy
  provider key and no `auth.json` mount. The Codex adapter strips the dummy
  credential, injects the subscription access token and account ID, and routes
  only the required `chatgpt.com/backend-api/codex/*` paths. Responses remain
  transparent so model metadata, streaming events, and quota headers survive.
  The gateway becomes the single refresh authority, also eliminating today's
  stale `settings.codexAuthJson` re-seeding across independently rotating
  Sandboxes.

The original spike used disposable local connector and Codex-home fixtures.
The production foundation now lives in the standalone gateway: a
separate encrypted Codex spill, a serialized write-ahead refresh authority, and
strict `/codex/models` + `/codex/responses` adapters with transparent responses.
A pinned-CLI probe verifies the custom-provider request contract. The Server now
projects the stored login with a source revision, and the gateway reports a
rotated bundle over its private control socket. Persistence is compare-and-swap:
a late refresh can never overwrite a newer login or logout, while the encrypted
spill retains both the rotated bundle and its provenance across a restart. The
Server acknowledges the update only after the encrypted DB commit succeeds.
The production cutover now adds a parallel project relay tunnel, generated
credential-free provider config, fixed spawn-broker placeholder authentication,
and removes every real `auth.json` runtime mount. Project and control-plane Codex
turns route through the gateway and fail closed when the listener or dedicated
Runner is unavailable. The Server uses the bundled model catalog instead of
materializing account credentials for discovery. The adapter contract is
provider-specific on requests but deliberately transparent on responses:
Claude and Codex share the gateway lifecycle, identity, and token-authority
substrate without pretending their upstream authentication protocols are the
same.

The cutover is guarded by a hermetic end-to-end test that launches the pinned
Codex CLI with the production-generated provider config and sends its request
through the loopback connector, TCP-to-Unix project relay, project mTLS identity,
and real Codex gateway listener. Its injected upstream proves that the dummy
credential was replaced only inside the gateway, the account header arrived,
quota metadata survived the return path, and no `auth.json` appeared in
`CODEX_HOME`. The image deployment smoke independently starts both gateway
listeners, rejects an unbound mTLS peer, checks Codex policy before credential
resolution, restarts the gateway, recovers both encrypted spills, and scans logs
and spill files for plaintext fixture credentials.

Ownership in the runner runtime mount (Server writes restored rollouts, worker
reads as runner uid, Codex writes sessions as agent uid) is an explicit
checkpoint in C2/C3 — any identity change re-decides it.

#### C1 — status-quo inventory

This section preserves the pre-cutover inventory of every site that touched the
**real** Codex `auth.json`. It is a historical snapshot of the migration surface
C2/C3 had to account for; the current implementation is summarized immediately
after the inventory.

**Authority (durable source of truth).** The secret lives only as the encrypted
`codex_auth_json` settings column (`packages/store/src/store.ts`), surfaced as
`codexAuthJson`, decrypted solely while the store is unlocked.

**Ingestion.** `packages/server/src/agent-login.ts` runs `codex login
--device-auth` server-side in a temporary `HOME`, reads `~/.codex/auth.json`,
and persists it via `updateSettings({ codexAuthJson })`. An operator may also
paste `auth.json` through the mobile advanced path
(`packages/mobile/src/secretSettings.ts`).

**Historical consumers of the real secret — the migration surface:**

1. **Sandbox mount (the exfiltratable path — the risk this phase removes).**
   `provisioner.ts` → `codexAuthBind()` materializes the secret to a `0600`
   host file and bind-mounts it **writable** at `$CODEX_HOME/auth.json` into
   every project Sandbox (`CODEX_HOME` set alongside), re-seeded on each
   provision. The Codex CLI rewrites it in place on refresh. Combined with
   `--dangerously-bypass-approvals-and-sandbox` (`codex-backend.ts`), project
   code runs as a child under the Codex identity and can read and exfiltrate
   the refresh token.
2. **Server-side control-plane env.** `embedded.ts`
   (`materializeControlPlaneAgentEnv`) writes the real `auth.json` into the
   **server-side** `secretRoot/codex` and sets `CODEX_HOME` for Verity-self /
   control-plane sessions. Stays server-side; must keep working after the
   Sandbox mount is removed.
3. **Model catalog.** `embedded.ts` + `packages/server/src/codex-model-catalog.ts`:
   `codex debug models` reads the materialized `CODEX_HOME` when the store is
   unlocked and Codex is logged in (account-current list), and degrades to
   `codex debug models --bundled` (no unlock, no `CODEX_HOME`) when sealed or
   not logged in. Prefers the real secret but is not dependent on it.

**Historical presence-only surface (no secret left the server).** Settings redaction
`codexAuthJsonConfigured` (`server.ts`), `onboarding-routes.ts`, and
`packages/mobile/src/api.ts` report only configured/not; clearing sets
`codexAuthJson: null` and truncates the server-side file in (2).

**Historical runtime plumbing (path/env only, no materialization).** The spawn broker env
whitelist copies `CODEX_HOME` for the `codex` command
(`features/verity-sandbox-toolkit/bin/verity-agent-spawn-broker.mjs`);
`verity-runner-stack-start` documents that `auth.json` is mounted separately,
outside the Runner runtime, and manages only the `sessions` symlink;
`codex-backend.ts` resolves `CODEX_HOME` and launches Codex.

**Two historical findings that shaped C2/C3:**

- **Refresh-authority drift** (the ADR's "stale re-seeding" problem, now
  code-located): each Sandbox refreshes its own writable `auth.json` copy
  independently, but the DB `codexAuthJson` is updated only by a fresh login,
  never written back from a Sandbox refresh. Across N Sandboxes, N
  independently rotating tokens diverge from an ageing DB copy. C3's single
  gateway-side refresher (one writer) resolves this.
- **Mount removal is not "just drop the bind."** After (1) is removed, (2) and
  (3) still need a real secret — but they are server-side and unaffected. The
  migration therefore also removed those Server-side consumers. Runtime Codex
  now receives generated non-secret provider configuration and a fixed
  placeholder environment value; the real credential is injected only by the
  gateway.

**Post-cutover state.** Login ingestion still stores `codexAuthJson` encrypted
in the database because it is the durable credential authority. The Server
projects that bundle to the gateway over the private control socket, and the
gateway reports rotated bundles back with revision-checked persistence. Neither
project Sandboxes nor control-plane Runners receive a real `auth.json`. Model
discovery uses only `codex debug models --bundled`. Startup code still removes
or truncates an `auth.json` found in a runtime home as a bounded upgrade guard
for volumes created before the cutover; it does not create or populate one.

### OpenCode (Phase 4) — reframed

`opencode serve` **is the agent runtime**: it executes tools in its own
process. It therefore belongs **inside the project Sandbox** like every other
agent process — never in the gateway, never in a shared central service.
Deploy survival comes from decoupling the turn driver, not from relocating the
serve process.

- **O1 — Turn driver onto the runner path.** An HTTP-driver adapter in the
  runner supervisor drives OpenCode turns inside the Sandbox (today
  `SUPERVISED_WORKER_BACKENDS = ['claude-acp', 'codex', 'codex-acp']`), giving
  OpenCode the same event-file/reattach machinery. SSE reattach and exactly-once terminal
  handling are built here — declared as new construction, not hardening.
- **O2 — Credentials out of the Sandbox.** `opencode serve` runs in the
  Sandbox, but its provider configuration is **generated per project** instead
  of mounted from the shared volume: provider base URLs point at the local
  connector; real keys stay with the gateway. The shared
  `opencode-config-verity` volume is removed and **any keys it exposed are
  rotated** (today any Sandbox can poison every other project's config).
- **O3 — API authorization.** As long as any OpenCode endpoint is reachable
  over a network it needs an authentication layer in front (today: no auth,
  client-asserted `directory`, a global event stream). In the O1/O2
  architecture the problem reduces to loopback-inside-the-Sandbox plus the
  turn-grant roadmap above.

#### Update (2026-08-25) — O1 and O3 are settled by the ACP migration

The reframing above rests on a premise that no longer holds: there is no
`opencode serve`. ADR 0012 Amendment 4 replaced the HTTP transport with
`opencode acp`, a per-session stdio child launched through the sandbox spawn
broker under the existing runner supervisor, so `SUPERVISED_WORKER_BACKENDS` is
now `['claude-acp', 'codex-acp', 'opencode-acp']`.

- **O1 is met, by a different construction.** No HTTP-driver adapter was built.
  OpenCode contributes an ACP profile and inherits the event-file/reattach
  machinery whole, so the SSE reattach and exactly-once terminal handling this
  bullet declared as new construction were never written — the code path they
  would have duplicated already exists and is already covered.
- **O3 dissolves.** There is no reachable endpoint left to put authentication in
  front of: the agent has no listening socket, the `directory` is Verity's own
  worktree argument rather than a client assertion, and the event stream is the
  child's stdio pipe. Nothing here reduces to the turn-grant roadmap because
  nothing here is a network surface.
- **O2 is untouched and is now the whole of Phase 4.** The provider key still
  lives in the shared `opencode-config-verity` volume, mounted **writable** into
  every project Sandbox — at `/home/dev/.config/opencode`, or at
  `$XDG_CONFIG_HOME/opencode` under neutral-path images, which is why the spawn
  broker forwards `XDG_CONFIG_HOME` to `opencode-acp` children. Moving the
  transport did not move the credential: generated per-project config pointed at
  the local connector, volume removal, and key rotation all remain open.

  One thing inside O2 did move, and it is worth naming rather than filing under
  "unchanged". The write side is as it was — the volume was already mounted
  writable into project Sandboxes under the HTTP transport, so an agent could
  already edit a config every project's OpenCode turns depend on, and an opencode
  config can declare MCP servers and provider base URLs. What changed is who
  reads it. Before, the single shared `opencode serve` parsed it once and ran
  every project's turns against it, with any worktree its clients named; now each
  Sandbox's own `opencode acp` parses it for that project alone. So the set of
  projects a poisoned config reaches is the same set, and the code it would cause
  to run moved from one process holding everyone's worktrees into each victim's
  own Sandbox — narrower blast radius per instance, more processes parsing it.
  Mounting the volume read-only would close the write side outright and was
  considered; it is not done here because opencode writes to its own config
  directory at startup (it normalizes `opencode.json` and drops a `.gitignore`
  beside it), so a read-only mount is a runtime failure for every OpenCode turn,
  not a hardening. The fix that actually fits is the per-project generated config
  already named above, which removes the sharing rather than freezing it.

  Something else now rests on that writable volume, and it is a control rather
  than a credential: **plan mode**. Under the HTTP transport `plan` was advisory
  and there were no permission cards, so a poisoned config cost the
  confidentiality and integrity of turns. On ACP, Verity asserts `mode=plan` as
  the session config option and **fails the turn when it cannot** (ADR 0012
  Amendment 4), which reads as enforcement — but what `plan` permits, and whether
  a tool raises `session/request_permission` at all in `build`, are both defined
  by the same `opencode.json`. An agent that can write the volume can redefine
  `plan` to allow edits, or auto-approve tools so no card is ever raised, and
  Verity sees a clean `set` either way. So the honest statement of the invariant
  is: **OpenCode's plan mode is enforced by OpenCode, configured by a file every
  project's agent can write.** That is a known bypass, it is not new to this
  amendment (the write side predates it), and it is one more thing the
  per-project generated config closes — which makes O2 the gate for it too, not
  only for the provider key.

### Lifecycle and operations

Blue/green behind the stable name, drain, connector reconnect — plus: the
gateway gets its own supervision (restart policy, health check, watchdog) and
a documented crash recovery; earlier drafts covered only planned updates. The
drain timeout is raised from 5 s to a turn-scale value; a stream that cannot
drain is caught by auto-resume, not silently dropped.

### Auto-resume — present vs. missing

Present: `turn_id` + `start_command_id` idempotency, `backend_session_id`,
gapless frameSeq dedup with terminal promotion. Missing, named as work
packages: a persisted attempt identity (the `attempts` column is a counter,
not an identity), transport-error classification, marking of unsafe tool
effects, a durable "last accepted event" ack. Exactly-once ingest exists;
safe-to-resume does not yet.

### Phases

| Phase | Content | Exit criterion |
| ----- | ------------------------------------------------------------------- | -------------------------------------------------------- |
| 0 | Four designs: unseal, token authority, discovery, cert lifecycle | Met as a design milestone — all four were written down and accepted before extraction. Implementation is provider-specific as documented above: Claude refresh-authority relocation and live client-cert rotation remain open |
| 1 | Extract gateway process: control channel, spill file, live TLS reload, stable name, connector reconnect | Met — standalone lifecycle and Server-replacement smokes cover the boundary |
| 2 | Claude default routing, remove legacy injection, path allowlist, leak/forgery tests | Met (2026-08-19) — no second token consumer remains; allowlist, isolation, redaction, and failure-path tests are in place |
| 3 | Codex C1 → C2 spike → C3 gateway migration | Met — project and control-plane Codex use placeholder-only runtime homes and the generic gateway |
| 4 | OpenCode O1 (runner path) → O2 (generated config, volume removal + key rotation) → O3 | Partial (2026-08-25) — O1 met and O3 dissolved by the ACP migration (ADR 0012 Amendment 4): an OpenCode turn now runs under the runner supervisor and survives a Server deploy. O2 is open and is the remainder of this phase — and it is no longer only a credential item: the same writable shared volume defines what `plan` permits, so O2 now gates a permission control as well as the provider key (see the update above) |
| 5 | Shared production gate per backend: credential absence, restart mid-response, recreate + resume, revocation, cross-tenant, forgery, exactly one terminal result, no duplicated tool effect | Partial — Claude/Codex credential-boundary, isolation, restart, and failure-path tests are in place; the safe-resume guarantees listed above and all OpenCode criteria remain open. OpenCode's gate carries one criterion the other two do not: its plan mode is enforced by a config file every project's agent can write, so "credential absence" is not the whole of its boundary until O2 lands |

Turn-scoped grants and broader audit/rate-limiting run as a parallel track
alongside Phases 2–4.

## Non-goals

The gateway **never** executes project code or agent runtimes (explicitly
including `opencode serve`); it has no PostgreSQL access (the spill file is a
local encrypted write-ahead cache, not an independent authority — the Server
persists revision-checked report-back to PostgreSQL and acknowledges it before
the gateway retires the pending update. Between the spill write and that
acknowledgement, the encrypted spill is intentionally the only durable holder
of the newest rotation, with that window retained as the residual named above);
it does not orchestrate turns; it
is not a general open HTTP proxy; it stores no agent transcripts; it does not
artificially unify provider protocols.

## Consequences

- Server deploys no longer kill in-flight Claude or Codex provider streams; the
  new worst case (gateway crash while every Server is down) is strictly rarer
  than the former every-deploy breakage and is documented.
- The gateway is load-bearing for Claude and Codex, which is why Phase 0 fixed
  supervision, unsealing, and credential durability before extraction.
- Sandboxes created before the stable gateway URL and certificate SAN require
  a rolling recreation once — acceptable since sessions survive recreates.
- Codex reaches the credential boundary through its spike-gated network adapter.
  OpenCode does not reach it at all yet: since 2026-08-25 it is an in-Sandbox ACP
  child rather than a serve process, but its provider key still comes from the
  shared config volume. Generated per-project config pointing at the connector is
  the open remainder of Phase 4, not a solved case.

## References

- [ADR 0002](0002-credential-and-isolation-architecture.md) — credential and
  isolation architecture
- [ADR 0005](0005-naming-and-layering.md) — naming and layering
- [ADR 0006](0006-runner-in-sandbox-extraction.md) — runner-in-Sandbox
  extraction and Server-restart survival
- [ADR 0008](0008-verity-server-self-update.md) — Verity Server self-update
