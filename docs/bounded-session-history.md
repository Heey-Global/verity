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
be returned on an earlier page.

To recover an oversized event, request the same endpoint with
`beforeSeq=seq+1`, the returned `snapshotSeq`, and `eventOffset=0`. Core returns
`kind: "event-chunk"` with `seq`, `snapshotSeq`, `offset`, `totalChars`, and `data`.
`data` is a substring of the serialized single-event page; offsets and lengths
count UTF-16 code units. Each chunk response stays below the 256 KiB JSON wire
limit, including escaping and its envelope. Continue with `eventOffset` advanced
by `data.length` until `totalChars` is reached. Concatenate before parsing, so
Unicode characters split across chunks are preserved. Validate the reconstructed
page and its original byte count before advancing the history cursor. Stored
events, sequence numbers, timestamps, and payloads remain unchanged.

The mobile client performs recovery within the original request's cancellation
and 30-second deadline. Partial events are never installed; retry starts the
transfer again. Recovery requires both an updated Core and an updated client;
older clients continue to show the explicit oversized-event error.

The mobile session model reads at most two pages on initial opening. Additional
history starts through an explicit continuation action; older-history scans also
have a page-count limit. Completed pages survive a later request failure. A
failed initial read offers retry without starting a full live replay. Requests
have a 30-second deadline and are cancelled when the session model stops.

A new app requires the versioned contract and displays an update-required error
when it is unavailable. It does not fall back to the legacy endpoint. Older apps
can continue to use the legacy endpoint on a newer Core.
