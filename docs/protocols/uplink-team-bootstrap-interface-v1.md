# Team bootstrap interface v1 — joint review candidate

**Status:** Proposed for one Core/Uplink review. This document fixes the candidate wire shape for the first member join over an opaque TLS tunnel. It is not an implemented endpoint or a T0 freeze. The [team contract](uplink-team-sharing-v1.md) owns invitation creation, commit, removal, grants and recovery; the [remote transport contract](uplink-remote-control-v1.md) owns `/data` attachment and the version-2 Core connector preface. This document takes precedence over their earlier two-request team join sketch. Changes after joint approval require a versioned contract revision and shared vectors.

## Boundaries

The app connects to Uplink's admission WSS `/remote-control`. Uplink routes an opaque TLS stream through `/data` to Core and never terminates inner TLS. Uplink sees `installationHandle`, `invitationId` and opaque session/redemption IDs, but never the invitation secret, device key/proof, Core credential or project content. Core accepts only the `team-member` enrollment endpoint on this pending tunnel; ordinary project and administrator APIs remain unavailable. A ticket or redemption ID alone grants no Core authority. Team eligibility and Remote Control entitlement are independent.

Only a negotiated `team-bootstrap-v1` capability permits these messages. Other admission profiles retain their existing behavior. The review fixtures and draft-7 schemas are in `scripts/team-bootstrap-contract/`. JSON Schema covers structural checks; consumers must also enforce the named `x-semanticChecks` for matching session IDs and conditional retry timing. All admission and control messages below are strict JSON objects: unknown fields, any duplicate object keys in the raw JSON frame, malformed numbers and frames above 64 KiB fail before authorization. IDs are ASCII `[A-Za-z0-9_-]`, 1–128 characters; generated session, redemption and ticket identifiers have at least 128 bits of randomness. Bootstrap timestamps are integer Unix **milliseconds**, matching the remote transport envelope. The team control operations outside this bootstrap profile retain integer epoch seconds.

## One request, one bound session

The app sends exactly one request on its admission socket:

```json
{"type":"team.join.reserve","requestId":"request_example","installationHandle":"AQEBAQEBAQEBAQEBAQEBAQ","invitationId":"invite_example","capabilities":["team-bootstrap-v1"]}
```

Uplink rate-limits the request, checks the installation's live authenticated control connection, the invitation's public state and team entitlement, then atomically creates a fresh `redemptionId` and `sessionId`. The durable redemption is bound to this admission socket, current `controlAdmissionId` and session before Core is notified. A repeated request on the same socket cannot allocate another reservation. The app cannot supply a redemption ID or select a Core destination. A new attempt after pre-commit transport failure uses a new reservation and redemption ID; the old binding never reopens or moves to another socket. The invitation remains usable only while its own validity and attempt limits allow it.

Uplink sends Core, on the installation's authenticated control connection:

```json
{"type":"team.join.pending","requestId":"request_example","sessionId":"session_example","invitationId":"invite_example","redemptionId":"redemption_example","projectId":"project_example","permissions":["read"],"bootstrapSessionId":"session_example","decisionExpiresAt":1800000015000,"capability":"team-bootstrap-v1"}
```

`bootstrapSessionId` is the bound transport `sessionId`; no second, independently selectable session exists. Uplink derives `projectId` and `permissions` from its durable invitation record, never from app input. Core verifies the invitation, inviter authority, project and permissions against its local record, then durably stores the pending tuple before replying once on that same control connection:

```json
{"type":"session.accept","sessionId":"session_example"}
```

or:

```json
{"type":"session.refuse","sessionId":"session_example","code":"unavailable"}
```

The only refusal codes are `unavailable` and `limit_reached`. `session.accept` is the durable acknowledgement of `team.join.pending`; no separate `team.event.ack` is sent for this event. Uplink's decision deadline is 15 seconds from receipt of the app request. While the same bound admission and authenticated control connection remain live, a repeated pending message or reply reuses the same session and redemption IDs, and Core returns the same stored decision. A control loss terminates that admission; a later control connection starts a fresh reservation. A duplicate acceptance never issues a second ticket pair. A late, foreign-control or mismatched decision is ignored and cannot reopen admission.

After acceptance Uplink issues distinct one-use tickets. It sends Core:

```json
{"type":"session.ticket","sessionId":"session_example","redemptionId":"redemption_example","ticket":"core_ticket_example","expiresAt":1800000060000,"capability":"team-bootstrap-v1"}
```

and sends only the requesting app socket:

```json
{"type":"team.join.ready","requestId":"request_example","sessionId":"session_example","redemptionId":"redemption_example","ticket":"app_ticket_example","expiresAt":1800000060000,"capability":"team-bootstrap-v1"}
```

The app retains `redemptionId` for same-device recovery if the final result is lost. Ticket claims bind installation, session, redemption, party, `bootstrap` scope, current control admission and expiry. The pre-acceptance decision deadline is 15 seconds after Uplink receives the app request. Once accepted, the attachment reservation expires at the earlier of 60 seconds after ticket issuance and 75 seconds after that request arrived. Both party tickets expire at that same attachment deadline; neither can extend it. `/data` consumes each ticket atomically as the first message; both parties must attach before the deadline. Only then does Uplink send `attached` and forward opaque bytes. The active tunnel lasts at most five minutes from attachment. A swapped, replayed, expired or wrong-scope ticket fails. A ticket is not a member credential.

The Core-side outbound connector uses the existing version-2 local preface with `purpose: "team-member"`, the bound `sessionId` and `redemptionId`, and empty `recoveryReservationId`. Core matches that tuple to its durable pending record through the protected local connector channel before TLS starts. Inside TLS the app proves the invitation secret and device key; Core checks the exact invitation commitment, intended project and permissions, current inviter authority and local cancellation state. Uplink cannot substitute any of them.

## Completion, failure and retry

The admission socket stays open until attachment succeeds or fails. App cancellation or socket loss before activation ends the reservation/session binding. Uplink sends `session.cancelled` with the bound session ID on termination. Core closes the pending channel and releases its connector claim. Core refuses a later message for the old binding. Uplink closes both `/data` peers on cancellation, control loss, entitlement loss, invitation invalidation, expiry or the five-minute absolute duration measured from attachment. It checks durable reservation validity on admission and activation, schedules deadlines, and revalidates external state at least every 30 seconds; forwarding each frame does not require a database query. A committed service state does **not** close an already active tunnel: Core may have committed its outbox before the credential response reaches the app. Connection shutdown must deliver Core's final bytes before closing the peer.

If Uplink cannot admit the request, it replies on the app socket with `team.join.error` carrying `requestId` and one of `unavailable`, `rate_limited`, `limit_reached`, `protocol_unsupported`, `timeout`, `cancelled` or `internal`. Unknown handles, expired/cancelled invitations and absent entitlement all map to `unavailable` for unauthenticated callers. `rate_limited` may include `retryAfterMs` (1,000–60,000). No error text or timing reveals whether a particular invitation exists.

Core's local join transaction consumes the invitation, stores the member/device binding and writes one `team.join.commit` outbox item as specified by the team contract. The member remains pending and has no project access until Uplink confirms that commit. The outbox retries with the same operation and redemption IDs; neither a lost acknowledgement nor a retry creates a second membership or seat. The durable redemption receipt persists through the proposed seven-day retry window (subject to joint T0 approval) after the short transport reservation ends. `member_limit_reached` is retryable while that receipt remains valid; Core keeps the member pending. After receipt expiry Uplink returns terminal `invitation_unavailable`, and Core fences the member and shows “invite again”. A removed membership returns terminal `revoked`. Post-commit recovery uses the separate same-device recovery flow; it never rebinds this transport reservation or creates another member.

## Shared acceptance cases required before activation

The two implementations must run the same versioned fixture set: successful one-request join; duplicate pending/reply and lost ticket acknowledgement; reservation bound to another socket/control identity; swapped and replayed party tickets; wrong invitation/device proof inside TLS; inviter removal and cancellation racing acceptance/commit; admission timeout and app abort; Core final bytes on immediate close; entitlement/control loss during an idle tunnel; service commit before credential delivery; eleventh active member pending, capacity freed before expiry, and terminal expiry; post-commit same-device recovery. Each negative fixture must fail when its guard is deliberately removed. Existing team V08–V13 and V19–V30 and enrollment EN13–EN19 remain in force. The later full app/service integration gate tests the actual iOS adapter through the production transport path.

## Joint review disposition and implementation gate

Uplink's bundled review accepts this one-request profile as the joint bootstrap baseline and reports no architectural blocker. The following are implementation work against this contract, not requests for another wire-shape decision:

| Gate | Required result before activation |
| --- | --- |
| Durable pending context | Uplink stores invitation, project, permissions and bound session/redemption together; Core persists the matching tuple before `session.accept`. |
| Bootstrap authority | Production tickets have the dedicated `bootstrap` scope, team entitlement, redemption and current control-admission binding. Remote Control authority alone cannot admit a team join. |
| Admission lifecycle | The 15-second clock starts when the app request arrives. Socket binding, cancellation and one atomic ticket pair are enforced in the production path. |
| Invitation and receipt state | Invitation validity, attempt limit and single use are enforced separately from the short tunnel reservation and longer-lived commit receipt. |
| Wire compatibility | Both implementations validate the versioned schemas, semantic checks, error codes and shared vectors. Stateful races and replay cases in the acceptance list are tested at integration, not inferred from shape fixtures. |
| Raw frame validation | Reject any duplicate JSON object key before parsing into a value or validating a schema, including duplicates outside security-sensitive fields. |

Before either side enables team join, pin the accepted public contract commit, the matching private implementation revision and a digest of executable schemas/fixtures. The remaining team-grant signing profile and key distribution are separate T0 work and cannot be inferred from this bootstrap admission profile.
