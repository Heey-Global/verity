# ADR 0011 — Pragmatic Secret Brokerage

Status: Accepted (operator decision, 2026-07-25)
Supersedes in part: ADR 0009 (the Secret Job Executor buildout is deferred; the `restricted`
maximal profile machinery is scaled back for brokered HTTP)

## Context

The goal was always simple: **secrets must not land in the agent.** What shipped for brokered
HTTP is the maximal variant of ADR 0009's `restricted` mode — per-request DNS pinning, SPKI
pins, canonical request hashes, at-most-once consumption fences, receipt choreography, and
status-only responses. Three of the four production failures on 2026-07-25 came directly from
this extra machinery, and the result is unusable in practice:

- The agent never sees the HTTP response body, so it cannot act on any API result.
- The agent cannot list available secret alias names, so it guesses them.
- The approval card explains nothing and supports only one-shot approval, although scoped
  approvals (once / session / project, with expiry) were the agreed design — the
  `secret_provider_permissions` table already exists, unused.
- The planned interim `trusted` mode (dialog, then the secret may reach the tool, with
  redaction as hygiene) was never built, although it was the explicit stopgap decision.

Perfect exfiltration prevention is not attainable once the agent chooses the target URL; a
colluding upstream can echo a transformed key. We accept that residual risk consciously
instead of sacrificing the product for it.

## Decision

### D1 — Brokered HTTP always returns the response

`verity_http_request` returns `{ status, body }` to the agent — always, no opt-in flag, no
status-only mode. Constraints, applied server-side:

- Body size is capped (existing `maxResponseBytes`, default 64 KiB). Because a cut can end
  inside an encoded credential, the body is withheld fail-closed as
  `{ status, body: null, truncated: true, note: 'body withheld (truncated)' }`.
- **Redaction gate:** the server knows the secret value and replaces every occurrence of it
  (raw, Base64, URL-encoded) in the body with `[REDACTED:<alias>]` before the body crosses
  into the agent. Redaction failure closed: if the body cannot be safely decoded as UTF-8
  text/JSON, the agent gets `{ status, body: null, note: 'body withheld (undecodable)' }`.
- Non-2xx responses are **results, not errors**: the agent receives `{ status, body }` and
  can react ("401 — wrong key") instead of the turn failing with a generic rejection.
- **Signed assertions are minted server-side** (added 2026-08-07). A class of APIs — App Store
  Connect, Google service accounts, Snowflake — authenticates with a short-lived JWT rather
  than a static token. Under `auth.kind: 'static'` the only way to produce one is to hand the
  private key to a CLI, which puts the key in the agent's process and defeats the point of the
  brokered path entirely. `auth.kind: 'jwt'` instead has the server sign the assertion from
  the key named by `secretAlias`; the Sandbox sees a request it never holds the credential
  for. Claims the agent cannot know because they live in Doppler (an ASC key id, an issuer id)
  are written as `{ alias: 'ASC_API_KEY_ID' }` and resolved the same way; anything genuinely
  public is spelled out as `{ literal: … }` so the request stays readable on the card.
  Consequence for D2: a grant row records one alias, but a JWT resolves several, so the grant
  target binds algorithm, audience and every claim source. A different assertion is a
  different target and returns to the card rather than inheriting the earlier "Always".

### D2 — Scoped approvals: once / session / always

The approval card states plainly: *"<agent/tool> wants to send <ALIAS> to <METHOD> <host>"*
with three choices: **[Once] [This session] [Always]**. Grants persist in the existing
`secret_provider_permissions` table keyed by (project, alias, host[, session]); a matching
grant auto-approves without showing a card. "Always" means project scope. Revocation lives in
project settings. The decision payload carries an optional `scope` field; clients that don't
send it get today's behavior (= once).

"Without showing a card" is an ordering requirement, not a detail: the grant must be resolved
in the runner tail BEFORE the prompt is persisted as a `permission` event. That event is what
renders the card and fires the push, so answering afterwards still flashes a prompt and pushes
a notification for a decision the operator already made. The lookup fails open — an error or a
miss leaves the prompt on its normal path, so a broken grant store can never swallow an
approval. The auto-approved request stays visible in the transcript through its `tool_call`.

### D3 — Secret names are not secret

The alias names available to the project (Doppler config keys) are injected into the tool
description / session context so the agent never guesses. Values stay server-side as before.

### D4 — `trusted` mode for everything that is not HTTP (interim, as agreed)

When the agent wants to feed a secret to an arbitrary tool/CLI, Verity shows the same scoped
dialog and then injects the secret into that tool invocation. Exact-match redaction in
chat/logs is hygiene, not isolation — the card says so. This is the agreed interim until
(if ever) something stronger is needed.

Three extensions, the first two to how the value arrives, all driven by CLIs that the original
single-env-var shape simply could not reach:

- **File injection** (added 2026-08-03). `injection: 'file'` writes the value to
  `/run/verity-runner/secrets/<env>` and puts that path in the variable. Without it, every
  tool that wants a file — `kubectl` reading `KUBECONFIG`, `tailscale up --auth-key=file:…` —
  is unreachable: there is no shell to redirect with, and a script in the worktree is refused
  because the executable must be root-owned. Agents hitting that dead end build a wrapper,
  which is precisely what the ownership rule exists to prevent. Verity writing the file
  removes the reason to try.
- **Several secrets per run** (added 2026-08-07). The request carries a `secrets` array (max
  8, one environment variable each). A CLI that authenticates with a key id, an issuer id and
  a private key needs all three in one process, and no sequence of single-secret runs composes
  into that. The workaround agents reached for — one Doppler value holding several credentials
  as JSON, split at runtime — makes the secret store worse and then fails anyway, because
  nothing in the Sandbox is allowed to do the splitting.
- **Socket operands** (added 2026-08-10). An operand naming a Unix socket is judged by who
  owns its path, not refused for its node type. The argv rule asks that a file which may
  affect execution be as immutable as the command; a socket holds no bytes to alter, and the
  peer behind it was decided when root bound the node in a directory the rule already requires
  to be root-owned and unwritable. Its own write bits are therefore waived — write permission
  is exactly what `connect(2)` checks, so a socket the trusted CLI can reach at all is
  group- or other-writable, and refusing that put `tailscale --socket=/…/tailscaled.sock` and
  every other daemon-socket flag out of reach. The waiver stops at the node: an interpreter
  reads its operand for bytes, so a socket in the script position stays refused, and a socket
  in a directory the agent can write to fails the walk as before. The accepting half is not
  constructible without root, so `scripts/probes/trusted-cli-socket-operand.mjs` carries it.

None of the extensions widens what the operator approves: the card still shows the exact
invocation, and a trusted CLI run has no standing grant scopes at all — every run asks.

### D5 — What we stop building

- No Secret Job Executor buildout (ADR 0009 D3–D10 stay dormant).
- Brokered HTTP drops DNS pinning and SPKI pinning; a normal TLS HTTP client with an
  SSRF guard (block private/link-local/loopback targets) is sufficient.
- Generic error masking is removed: server logs the real cause; the agent gets the real
  HTTP status.

## Consequences

- The feature becomes usable: agents can read API responses and know which aliases exist.
- Approval fatigue drops via scoped grants; the card finally says what it grants.
- Security posture is stated honestly: secrets are kept out of the agent for brokered HTTP
  (modulo colluding-upstream echo), and `trusted` mode is labeled as hygiene-only.
- Implementation order: Phase 1 = D1 + D3 (server + sandbox toolkit), Phase 2 = D2
  (server + app UI), Phase 3 = D4, cleanup = D5.
- The trusted CLI request crosses a process boundary into the sandbox, and the two deploy
  separately, so changing its shape is a rollout constraint rather than just an API change.
  Ship the image first, then the server: the supervisor accepts the old flat single-secret
  shape alongside `secrets`, so a new image serves an older server for the length of the
  window. The reverse never holds — an older image cannot read `secrets` — which is what makes
  the order mandatory rather than merely preferable. The compatibility branch is deletable
  once no deployed server sends the flat shape.
