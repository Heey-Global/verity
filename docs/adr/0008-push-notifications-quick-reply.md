# ADR 0008 — Push Notifications with Quick-Reply Actions

**Status:** Proposed · **Date:** 2026-07-13 · **Rev:** 2 (hardened after a multi-agent design review; see §Review hardening)

## Context

Verity has **no out-of-app notification path**. Today a client only learns of session
state changes while it is in the foreground with a socket open:

- The realtime channel is a single per-session WebSocket, `GET /sessions/:id/stream`
  (`packages/server/src/server.ts:5512`), fanned out from the in-memory event bus
  (`packages/session/src/bus.ts:22`, persist-then-publish). It reaches only a foreground
  app holding that socket.
- The session **list** learns of changes by ~2s polling
  (`packages/mobile/src/models/sessionList.ts`), again only while the app runs.
- "Attention" today is purely in-app: a derived status badge
  (`deriveSessionStatus`, `packages/server/src/status.ts:19`, statuses
  `running | awaiting_input | awaiting_dependency | crashed | completed | idle`) and an
  unread dot (`packages/mobile/src/unread.ts`). Neither emits an OS notification.

So when the operator is away from the app — phone locked, on a walk, glancing at an Apple
Watch — and an agent **stops for a permission prompt** or **finishes / crashes**, nothing
tells them. The operator has to open the app and look.

The operator wants exactly the interaction pattern iOS/watchOS already offer for
messaging: an **OS push notification with quick-reply actions** — a text-reply field to
answer an agent's question, and Allow/Deny buttons to resolve a permission prompt —
usable straight from the lock screen or the Apple Watch, without opening the app.

Two pieces already fit this cleanly and must be **reused, not rebuilt**:

1. **The reply path into a session is done.** `POST /sessions/:id/turns`
   (`packages/server/src/server.ts:5154`) → `Conductor.dispatchTurn`
   (`packages/session/src/conductor.ts:995`). If a turn is still in flight the message is
   **steered** into the running agent at the next step boundary (`conductor.ts:1021`,
   `turn.steer(...)`); if not — the common case for an away operator who reads the push
   minutes later — `dispatchTurn` starts a **fresh resume turn** with the reply as input
   (so "steer" is only accurate while `inFlight`; otherwise it is a new turn). Either way a
   quick reply is a second entrypoint into the same `sendTurn` path the composer already
   uses (`packages/mobile/src/api.ts:1391`).
2. **The app is native Expo** (SDK 56 / RN 0.85), shipped via EAS/TestFlight
   (`apps/mobile/eas.json`). `expo-notifications` gives us APNs registration, notification
   **categories** (the quick-reply actions), and the response listener — and iOS mirrors
   categories to the Apple Watch for free, so there is **no watchOS code to write**.

Everything else is greenfield: there is no push-token storage, no server-side sender, and
no fire point. `mintDeviceToken` (`packages/server/src/server.ts:2831`) is an auth bearer
minter for device pairing — **not** a push token.

## Decision

**Add OS push notifications via `expo-notifications` + the Expo Push Service. A push
carries a category that renders quick-reply actions; the operator's response is delivered
back through the app into the existing `dispatchTurn` / permission-resolve paths. Push is a
notification/transport layer only — it introduces no new way to mutate a session.**

The design ships in two tiers, because the two categories do not have the same footing
today (see §Fire points):

- **`PERMISSION_PROMPT` (Allow/Deny) is buildable now** — it rides the existing
  `awaiting_input` signal, which *is* an unresolved permission prompt.
- **`AGENT_QUESTION` (text reply) needs a prerequisite** — a new "agent is asking"
  lifecycle signal that does not exist yet.

### Why the Expo Push Service (not raw APNs/FCM)

The app is already an EAS project. Using Expo's push service (`expo-server-sdk` on the
server, `getExpoPushTokenAsync` on the client) means we upload an APNs key to Expo **once**
and send to `exp.host` tokens — no per-server APNs certificate handling, no FCM project, no
JWT signing in `packages/server`. It matches the existing build/deploy posture. Raw APNs
remains a future option if we ever need delivery guarantees Expo can't give; nothing in
this design leaks the Expo choice past the sender module.

**Trust boundary:** routing through Expo means Expo stores our push tokens, and a leaked
Expo **access token** would let anyone push to every registered device. Treat that access
token as a high-value secret (rotation, least scope). This is acceptable because the push
**text** is generic (see §Payload & privacy) and every *effect* still re-authenticates
through Verity's own endpoints.

### The building blocks

| Block | Where | What |
|---|---|---|
| 0. "Agent is asking" signal | conductor / status | **Prerequisite for `AGENT_QUESTION`.** No lifecycle signal means "the agent ended its turn with a question" today (see §Fire points); one must be added before a text-reply category has anything to fire on. |
| 1. Token registry | server + app | App fetches its Expo push token on launch, `POST /devices/:id/push-token`; server stores it in a new `device_push_tokens` table keyed to the existing device pairing (**not** to a session owner — Verity has no owner entity). |
| 2. Sender | server | A `PushSender` wrapping `expo-server-sdk`: look up **the deployment's paired-device tokens**, send `{ title, body, categoryId, data }`, handle receipts + prune dead tokens. |
| 3. Fire points | server event observer + PR monitor | Observe persist-then-publish permission and turn-settle (`completed`/`crashed`) events; also refresh open-PR state over the existing cached GitHub REST service and notify once per mergeable PR head — **only when no foreground viewer is attached** for that session. |
| 4. Categories + handler | app | Register notification categories at startup; handle the response and POST it back (with a client idempotency key). PR merge actions require device authentication and are revalidated server-side. |

### Quick-reply actions = iOS notification categories

The reply options are **declared in the app** (`setNotificationCategoryAsync`), not carried
in the payload; the push only names the `categoryId` and the OS renders the matching
actions. Three actionable categories:

- **`AGENT_QUESTION`** — a single `textInput` action ("Antworten…"). iOS shows a reply
  field; on the Watch this becomes dictation / scribble / canned replies. **Requires Block 0
  to fire** (see below).
- **`PERMISSION_PROMPT`** — two button actions, **`Erlauben` / `Ablehnen`**. Two taps, no
  typing — buildable today.
- **`PULL_REQUEST_READY`** — **`Merge` / `Open`**. Merge requires Face ID/passcode and
  calls the existing authenticated merge endpoint; Open navigates without mutation.

**Payload & privacy.** The push `data` carries only routing metadata:
`{ sessionId, kind, toolUseId?, pullRequestNumber?, deviceId }`. `deviceId` is added per
recipient by the sender; the app rejects destructive actions unless it matches the active
server pairing, and stores each outbox under the normalized server URL + pairing id.
Human-readable `title`/`body` includes
safe operator-facing context (project, session name, tool name, PR number/title), but never
agent-generated prose, tool input, credentials, or command text. PR title already comes from
GitHub and is deliberately shown so the notification is actionable. The client-generated
idempotency key (`clientReplyId`) is created on the *outgoing reply*, not carried in the
server→device push.

This means project/session names and PR titles traverse Expo and may appear on the lock screen.
That is an intentional usability trade-off for actionable notifications; private deployments
that cannot expose this metadata must disable push with `VERITY_PUSH_ENABLED=0`.

### How the response returns (and the real constraints)

On iOS a quick reply **always routes through the app** — there is no server-direct reply.
The flow:

```
push (categoryId + data) → operator taps action / types text
  → iOS wakes the app in the background
  → addNotificationResponseReceivedListener reads actionIdentifier + userText
  → app calls the matching endpoint (with a clientReplyId):
       AGENT_QUESTION      → POST /sessions/:id/turns   → dispatchTurn (steer if in-flight, else fresh resume turn)
       PERMISSION_PROMPT   → POST /sessions/:id/permissions/:toolUseId (allow/deny)
       PULL_REQUEST_READY  → POST /sessions/:id/pull-request/merge
```

No new mutation mechanism: text replies reuse `sendTurn`; Allow/Deny reuses the existing
permission resolution (`decidePermission`); Merge reuses `mergePullRequest`. The server
re-resolves the session's PR and requires it to be open, green, and mergeable before mutation,
so a stale or forged push payload authorizes nothing.

**Idempotency (must be added).** The reused `POST /sessions/:id/turns` does **not**
deduplicate today — `turnBody` (`server.ts:1427`) has no reply-id field, so a client
`replyId` alone is a no-op (unknown keys are stripped). Because iOS can suspend the
background-woken app before the 202 and the outbox will re-flush on next foreground, the
turn endpoint must gain a **server-side idempotency key**: accept `clientReplyId` in
`turnBody` and keep a per-session seen-set that returns the prior result on replay.
The permission-resolve path is already naturally idempotent via `toolUseId`
(`conductor.decidePermission`), so it needs no change.

**Late replies (after the turn/prompt ended).** Because `dispatchTurn` only steers while
the turn is `inFlight` (`conductor.ts:1009`), the typical away-operator reply lands as a
**fresh resume turn**, not a steer — and a packed permission prompt lives only during its
turn (`clearPermissions` in the turn `finally`; fail-safe **deny** at turn end). So a late
Allow/Deny hits a resolved/absent prompt (a safe 404, `decided:false`) and a late text reply
starts a new turn on possibly-stale context. The app must handle this gracefully: silent
"prompt already resolved" feedback, withdraw the stale notification, and consider carrying a
turn/prompt token in `data` for staleness detection.

### Fire points and suppression

**What `awaiting_input` actually is.** `deriveSessionStatus`
(`packages/server/src/status.ts:49-50`) returns `awaiting_input` from **exactly one**
source: an unresolved `permission` event. The code that emits session `status` events
(`packages/session/src/acp-backend.ts:735-740`, `packages/session/src/conductor.ts:1113`
and `:1121`) writes only `running`/`completed`/`crashed`/`awaiting_dependency`. There is **no** signal today for "the agent ended its turn with a
plain-text question" — such a turn derives to `completed`, indistinguishable from an
ordinary completion (`attention.ts:73` even relabels `awaiting_input` itself as the
"question" kind, propagating the conflation). Consequences for the two categories:

- **`PERMISSION_PROMPT`** rides `awaiting_input` — the fully-supported case today.
- **`AGENT_QUESTION`** has **no trigger yet**. It needs Block 0 (e.g. the backend emitting a
  distinct `awaiting_reply` status, or a turn-end result flagged as a question). Wiring it to
  `awaiting_input` — as Rev 1 of this ADR did — binds it to the permission path, so it would
  never fire for a prose question. This is why `AGENT_QUESTION` is a second-tier deliverable.
- **Turn end** — `completed` ("done") or `crashed` ("needs you") — a separate low-priority
  notification for the away operator, not a quick-reply trigger.
- **PR ready** — a 30-second background refresh through the REST-only cached PR service.
  Persist a dedupe marker per `(session, PR number, head SHA)` only after at least one Expo
  ticket is accepted; failed/no-device sends remain eligible for a later poll.

**Suppression.** Send a notification only when **no foreground viewer** is attached to the
session. The mechanism needs care: the event bus (`packages/session/src/bus.ts`) exposes
only `publish`/`subscribe` — there is **no** subscriber-count API today. A raw "bus subscriber
count == 0" check would also let future internal subscribers (audit tap, analytics, the sender
itself) silence push forever. Track explicit **foreground-viewer presence** from the
per-session WebSocket instead. Presence is deliberately **session-wide across devices**: if
the session is visible on any paired device, suppress fan-out to every device. The mobile app
actively closes that socket on a real `background` transition (not transient `inactive`) and
resumes from its event cursor on `active`; debounce the server-side check so a reconnect flap
at the fire instant does not emit a lone noise push.

### Not in scope

- **Android/FCM parity** — the design is FCM-ready via the same Expo tokens, but the Watch
  quick-reply use case is iOS-first; Android buttons are a follow-up, not a blocker. Until
  then, decide explicitly what an Android token receives (or reject it at registration) so
  `platform: 'android'` rows are not stored with no consumer.
- **Server-direct reply / background reply without waking the app** — not possible on iOS;
  explicitly accepted.
- **Rich per-message threading, notification grouping/collapsing** — start with one
  notification per fire event; grouping (via `apns-collapse-id`) and cross-device dismissal
  are later polish.

## Consequences

**Positive:** the operator can approve a waiting agent (and, once Block 0 lands, answer a
question) from the lock screen and Apple Watch with zero watchOS code; reuses the finished
`dispatchTurn` and permission-resolve paths so quick reply is a thin new entrypoint, not a
new subsystem; Expo Push keeps APNs credential handling out of `packages/server`; the
`PERMISSION_PROMPT` fire point reuses an existing lifecycle signal.

**Negative / accepted:**

- **`AGENT_QUESTION` is gated on new work** (Block 0), not free — the headline "answer the
  agent's question from the lock screen" ships only after an "agent is asking" signal exists.
- **Server-side idempotency is required** on `POST /sessions/:id/turns` (above), or an
  outbox re-flush double-runs a turn.
- **Lock-screen actions bypass device unlock.** iOS notification actions fire without Face
  ID / passcode by default, while the app holds a fully-privileged operator bearer token at
  rest. A lock-screen `Erlauben` could approve a destructive `can_use_tool` decision and a
  text reply could steer an arbitrary instruction into a running agent — both without
  unlocking. At minimum the Allow action must be `authenticationRequired: true`
  (open-to-foreground) so a destructive approval forces an unlock; no silent lock-screen
  approval of permission prompts.
- **Best-effort delivery needs observability.** Silent failures (bad APNs key, exhausted
  Expo, mass `DeviceNotRegistered` pruning, suppression misfires) are invisible without
  instrumentation — specify metrics/logs (send attempts vs. Expo ticket errors, receipt
  outcomes, prune counts, suppression hit-rate, outbox flush success). The in-app
  badge/unread remain the source of truth; push is an **accelerator, not a guarantee**.
- iOS gives the background-woken app only a few seconds — the POST must be fast, and an
  offline reply must be **queued locally and flushed on next foreground** (a small
  client-side outbox), covering both fully-offline and "POST in flight when the ~5s window
  closes" (use `beginBackgroundTask` / Expo background execution).
- A one-time EAS/Apple provisioning step is needed (Push Notifications capability + APNs key
  uploaded to Expo) — Expo/EAS config, **not** a repo container/GitOps change.
- A new `device_push_tokens` table and its lifecycle (register, refresh,
  prune-on-failed-receipt **and on auth-token revocation**) must be maintained.

**Guardrail that must hold:** push is notification/transport only. The response must go
through the existing `dispatchTurn` and permission-resolve endpoints — no new
session-mutation path may be added on the notification side, and their auth must apply
identically to a quick reply. Push tokens are **not** a capability: possessing a token
authorizes nothing; every reply still carries the device's session auth.

## Configuration

Push is enabled by default for self-hosted deployments:

- **`VERITY_PUSH_ENABLED=0`** explicitly disables the sender. When disabled, no tokens
  are accepted (`/devices/:id/push-token` 503), no notifications fire, and the app skips
  permission-prompting for notifications.
- The Expo Push Service accepts sends without server authentication by default. An
  **`EXPO_ACCESS_TOKEN`** is optional and is required only when Enhanced Push Security
  is enabled for the EAS project. If used, it lives in server env and never in the repo.

Fail-safe, not fail-loud: with push off, the app degrades to today's in-app-only
behavior; it must not error.

## Suggested build order

1. **Token registry** — `device_push_tokens` migration (keyed to the paired **device
   identity**, no owner column; add the sender-lookup index and a down-migration) + store
   methods; `POST /devices/:id/push-token` (derive the device identity server-side from the
   authenticated pairing, do not trust a client-supplied `:id`); app-side
   `expo-notifications` install, permission request, `getExpoPushTokenAsync`, register on
   launch.
2. **Sender** — `PushSender` over `expo-server-sdk`; **paired-device** token lookup; receipt
   handling + dead-token pruning; observability counters. Unit-testable with a fake Expo
   transport.
3. **Fire points** — `PERMISSION_PROMPT` off the persisted permission event; turn-settle for
   the "done/crashed" notification; the **foreground-viewer presence** suppression check
   (new presence API, session-wide across devices). Test the suppression matrix explicitly.
4. **`AGENT_QUESTION` prerequisite (Block 0)** — add the "agent is asking" signal, then the
   text-reply fire point; add `clientReplyId` server-side idempotency to `POST /turns`.
5. **Categories + response handler** — register `AGENT_QUESTION` / `PERMISSION_PROMPT` /
   `PULL_REQUEST_READY`
   categories (`authenticationRequired` on Allow); `addNotificationResponseReceivedListener`
   → persistent local outbox (idempotent flush) → POST to `sendTurn` / permission-resolve /
   PR merge. Merge also requires authentication and server-side live-status validation.
   E2E validated on TestFlight; `VERITY_PUSH_ENABLED=off` degradation covered by a test.

Crosscutting, one-time: **EAS/Apple provisioning** (Push capability + APNs key to Expo).

## Review hardening

Rev 2 folds in a multi-agent design review (5 dimensions, adversarially verified). Beyond the
substantive items above, the following precisions carry into implementation:

- Reference the permission-resolve endpoint concretely: `packages/server/src/server.ts:5250`
  (`POST /sessions/:id/permissions/:toolUseId`) → `conductor.decidePermission`.
- `promptId` vs. `toolUseId`: the push `data` uses `toolUseId` to match the endpoint path
  param; if the app models it as `promptId`, map explicitly.
- `device_push_tokens` upsert: define the `ON CONFLICT(expo_token) DO UPDATE` columns, add an
  index on the sender-lookup key, and a rollback migration.
- Bind push-token rows to the auth `tokenId` (thread it through `verify()`), so `forget`/
  `clear` of a device also drops its push tokens — pruning must not be receipt-only.
- Defense-in-depth: a server-issued per-event nonce that the resolve endpoint re-checks would
  harden against a forged/phished notification (no direct exploit today — resolve is bound to
  a live-pending `toolUseId` plus an operator tap).
- Suppression inherits the single-process bus scope (`bus.ts`); a LISTEN/NOTIFY swap later
  must carry both the bus and the presence check.

## Related

- `packages/server/src/server.ts:5154` (`POST /sessions/:id/turns`),
  `packages/session/src/conductor.ts:995` (`dispatchTurn`), `:1009` (the `inFlight` guard),
  `:1021` (`turn.steer`) — the reply path a quick reply reuses; `server.ts:1427` (`turnBody`)
  — where `clientReplyId` is added.
- `packages/server/src/server.ts:5250` (`POST /sessions/:id/permissions/:toolUseId`) →
  `conductor.decidePermission` — the Allow/Deny path; naturally idempotent via `toolUseId`.
- `packages/server/src/status.ts:49-50` (`deriveSessionStatus`) and
  `packages/session/src/acp-backend.ts:735-740` — `awaiting_input` comes **only** from
  an unresolved permission event; no status writer ever emits it itself
  (the Block 0 gap). `packages/mobile/src/ui/attention.ts:73` mislabels `awaiting_input` as the "question" kind.
- `packages/session/src/bus.ts:22`, `packages/server/src/server.ts:5512` / `:5559` — the event
  bus (no count API) and per-session WS; suppression needs a new presence API, not raw
  subscription.
- `packages/server/src/server.ts:2831` (`mintDeviceToken`) — the existing device pairing the
  token registry keys off (an **auth** token, not a push token; and there is no owner entity).
- `apps/mobile/eas.json`, `apps/mobile/app.config.ts` — EAS/Expo config where the APNs
  capability and push credentials are provisioned.
