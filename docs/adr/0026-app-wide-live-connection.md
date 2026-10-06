# ADR 0026 — App-wide live connection and per-user notification routing

**Status:** Accepted · **Date:** 2026-10-06

**Related:** [ADR 0008](0008-push-notifications-quick-reply.md),
[ADR 0023](0023-multi-user-projects-and-turn-identity.md),
[live protocol](../../packages/events/src/live.ts)

## Context

Until now the app held one WebSocket per open session (`GET /sessions/:id/stream`)
and polled everything else: the session list every 2 s, a session's activity every
1.5 s. Push suppression (ADR 0008) was derived from that socket and was
deliberately session-wide: while any device showed a session, no device was
notified about it. Two problems followed:

- With the app open on one device (on the list, or another session), pushes still
  reached every other device. The server could not tell which device the user
  was using.
- In a shared project (ADR 0023) one member viewing a session would silence
  every other member's notifications about it.

The per-session socket also had no keepalive, no paging of its replay, and no
protection against a client that could not keep up.

## Decision

**One live connection per device and server, `GET /live`.** It multiplexes every
session the app shows, carries content-free overview hints, and is the device's
presence. Authentication is a one-use ticket from `POST /live/ticket` (any active
user), offered as a WebSocket subprotocol. The frames are specified in
`packages/events/src/live.ts`. The per-session route, its tickets and the
session-wide presence are removed; the app and the server ship together.

- **Sessions are subscribed individually.** Each subscription is authorized like
  `GET /sessions/:id` and re-checked when access may have changed (a user
  disabled, membership withdrawn, and periodically). The replay is paged; a
  subscription the socket cannot keep up with ends `overflow` and the client
  resumes from its cursor without loss.
- **Overview hints carry no content.** They name the session and the kind of
  change; the client refetches through the ordinary authorized routes. A user
  hears only about sessions of projects they may read, and an administrator also
  about sessions outside any project. The list's poll drops to a 30 s safety net.
- **Presence.** A connection reports whether it is in the foreground (an active
  iOS app; a visible, focused browser tab able to show notifications), and which
  subscribed session is on screen. A socket that stops answering pings for 45 s
  is dropped.

**Notifications belong to the turn's initiator.** The authenticated caller of the
turn route is stamped on the `prompt` event as `initiatedBy` (an automation's turns
carry the user who confirmed it). Steering a running turn does not change it; a
prompt without a user continues the last initiator's work. Without a known
initiator, the users with execute permission on the project are notified. For
each recipient:

1. one of their devices shows the session → nothing;
2. one of their devices is in the foreground → an in-app alert there (a local
   notification with the push's category and quick actions) for requests that
   block the agent; if it is still unanswered after 60 s, the user's other devices
   are pushed. Informational notifications are not shown to a user who is in the
   app;
3. otherwise → a push to all of their devices.

Another user's activity never suppresses or redirects a notification.

## Consequences

- One socket per device instead of one per open session, which also matters for
  Remote Control's per-session stream budget.
- In-app alerts render agent-offered choices as real buttons; a push cannot,
  because iOS needs the button labels registered before the push arrives (a
  Notification Service Extension would lift that).
- The pinned native WebSocket gained a send path, so this needs a native app
  release; the release workflow's native-compatibility check keeps the new
  JavaScript off older binaries.
- Still open for team mode: unread state and notification preferences per user,
  enforcing that only the initiator answers its permission requests, and the
  concurrent Remote Control device limit.
