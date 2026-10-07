# ADR 0027 — Live resource updates for app views

**Status:** Accepted · **Date:** 2026-10-06

**Related:** [ADR 0026](0026-app-wide-live-connection.md)

## Context

The app-wide connection initially covered session events, overview hints and
notification routing. Project folds and ordering, branch status, preview shares,
server logs, meetings and update progress still required separate client timers.
A change on one device could therefore remain invisible on another until its
next poll.

## Decision

Reuse `GET /live` for read-resource subscriptions. A client sends `watch` with an
allowlisted API path and receives `invalidate` when its authorized response
changes. It then reads the normal HTTP API; resource frames carry no response
content. The first observation and each reconnect also refresh the view, closing
the gap between a first read and establishing its subscription.

The client records eligible reads, including dynamically selected projects and
server logs. Incremental meeting cursors do not create new observations: the
watch targets the meeting feed, and each refresh retains its own sync cursor.
Recorder commands preserve their separate meeting-owner authorization.

A shared server observer uses the existing GET routes, including their device
and user authorization, rather than duplicating route permissions. It retains
the connection's credential only in memory. Snapshots are grouped by user,
resource and meeting-owner credential; devices of the same user share an
observation. Backend reads run serially, and only response digests are retained.

Successful resource mutations schedule observation immediately. External and
asynchronous changes still require server observation: Docker lifecycle,
GitHub/cache state, file logs and updater progress do not all have independent
change emitters. Their intervals are centralized in
`packages/events/src/live-resources.ts`; no observer runs for an unwatched
resource. The final detached view releases its observation.

The server advertises support in `ready.resources`. Healthy supported
connections replace the views' periodic HTTP polling. Disconnection, an older
server or subscription limits enable a 15-second client fallback. Subscriptions
are bounded to 64 per connection and 2,048 shared observations per server.

## Remaining timers

Transport keepalive, recorder heartbeat and relative-time display ticks remain.
Meeting outbox retries check local pending writes and upload only outstanding
work. Native app OTA discovery still queries the app update provider, whose
release state is outside Core. Before device authentication, onboarding retains
its fallback because an authenticated live connection cannot yet be opened.

## Verification

Tests cover shared observations, user/owner isolation, authorization failures,
backend concurrency, detach during an in-flight read, subscription restoration,
coalesced refreshes, legacy fallback, the local demo, and project collapse
synchronization between two real WebSockets. Existing view tests exercise live
invalidations in place of their previous polling cadence.
