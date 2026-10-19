# Bounded session history

`GET /sessions/:id/history/v1` negotiates the `bounded-history-v1` contract.
It requires the same device authentication as the other session routes.
The legacy `/sessions/:id/events` endpoint retains its existing behavior.

Each successful page contains at most 150 complete events and at most 256 KiB
of serialized UTF-8 JSON, including the response envelope, before compression.
Events appear in ascending sequence order. A page is a contiguous suffix of the
requested history; sequence numbers can have gaps because other sessions share
the sequence allocator.

The response contains:

- `contract: "bounded-history-v1"` and `kind: "page"`.
- `events`, with their original sequence numbers, timestamps and complete payloads.
- `snapshotSeq`, the newest event visible to the initial history read, or zero for
  an empty session.
- `beforeSeq`, the oldest returned sequence, or `null` for an empty page.
- `hasMore`, indicating whether older events remain.

Continue backward by passing both `beforeSeq` and the original `snapshotSeq`.
Seed the returned history before subscribing to live events after `snapshotSeq`.
New arrivals belong to live continuation and never move the older-history cursor.

If the next required event cannot fit on a page by itself, the endpoint returns
`kind: "oversized-event"`, with `seq`, `snapshotSeq`, `requiredBytes` and `maxBytes`.
It does not truncate, replace or skip that event. Newer complete events can still
be returned on an earlier page. Loading arbitrary oversized payloads separately
is not part of this contract.

The mobile session model reads at most two pages on initial opening. Additional
history starts through an explicit continuation action; older-history scans also
have a page-count limit. Completed pages survive a later request failure. A
failed initial read offers retry without starting a full live replay. Requests
have a 30-second deadline and are cancelled when the session model stops.

A new app requires the versioned contract and displays an update-required error
when it is unavailable. It does not fall back to the legacy endpoint. Older apps
can continue to use the legacy endpoint on a newer Core.
