# Public preview reconnect behavior

The public preview HTTP edge and connector are implemented in
`packages/preview-tunnel`. Hosted Uplink orchestration and deployment manifests
are maintained separately.

Authenticated public GET and HEAD requests that have not been dispatched wait
up to three seconds for an available tunnel. The reconnect waiting pool is
separate from upstream admission and holds at most `maxQueuedRequests` visitors
(64 by default). Reader cancellation, share expiry, and edge shutdown release
waiters. Connector replacement before dispatch re-enters admission; requests
already dispatched are never replayed. Local previews retain their existing
immediate failure and queue cancellation behavior.

When the reconnect window expires or its pool is full, the edge returns a
no-store 503 Reconnecting page with `Retry-After: 2`. GET pages without a query
string reload after two seconds using an HTML refresh directive, without
scripts or a weaker content security policy. Query-bearing URLs are deliberately
not reloaded automatically because they may contain credentials. HEAD receives
the same headers without a body. Unsafe methods receive a non-reloading response
and are never held for reconnect. WebSocket upgrades are not retried.

PIN verification stays on the edge: a successful login POST issues its session
cookie and a 303 redirect even while the tunnel is down. The authenticated GET
after that redirect uses the reconnect window. Neither the login POST nor an
application or webhook POST is automatically replayed.

The connector retains its 15-second ping interval and 15-second ping-write
deadline. A missed pong starts another probe immediately; two consecutive
15-second pong timeouts terminate the connection. A matching pong resets the
count. Dead peers normally disconnect about 45 seconds after the last successful
probe, excluding socket-write delays and event-loop stalls. Heartbeat timeout
diagnostics include `missedPongs` and the existing scheduling delay metadata.

## Request logs

Both executable entrypoints emit one JSON `request.completed` record per HTTP
proxy attempt on stdout, at completion or cancellation. Long-lived streams log
only when they finish. Edge-local login and asset requests are not proxy
attempts. The records contain `shareId`, bounded `method`, fixed `pathClass`
(`root`, `content`, or `internal`), `status` (null before response headers),
`outcome` (`completed` or `aborted`), `durationMs`, `tunnelState`,
`connectionGeneration`, and `tunnelUnavailable`.

`completed` means a complete HTTP response was emitted, including error
responses; use `status` to distinguish success. `tunnelUnavailable` identifies
tunnel-caused failures, rather than requests that merely waited successfully.
Generations are process-local counters, incremented on each successful tunnel
attachment; edge and connector counters are independent. The state is sampled
when the record is emitted. Raw paths, queries, PINs, headers, cookies, bodies,
and arbitrary peer error text are excluded.

## Deployment contract

Deploy updated preview edge and connector images through the hosted deployment
repository. No wire protocol change or new edge environment variable is required;
`PreviewEdgeOptions.reconnectWaitMs` is available to embedded users, with the
three-second default used by the executable. The reconnect capacity reuses the
existing `maxQueuedRequests` option without sharing upstream slots.

Core supplies `VERITY_PREVIEW_SHARE_ID` when creating connector containers so
connector request logs can be correlated with edge records. Other container
creators must supply that same non-secret share identifier. Older embedders
without it remain compatible, but their connector records use `unknown`.
Existing containers need recreation with the updated image and environment to
gain the behavior and identity metadata.

After rollout, verify a real public share with a short connector interruption:
submit the PIN once, retain the cookie and redirect, and confirm that the first
GET reaches content when the connector returns within three seconds. Repeat
with a longer interruption and confirm the 503 page reloads to content. Confirm
one completion record per proxy attempt on each side and that a POST is never
replayed. Repository tests do not establish hosted rollout or browser behavior
in a live cluster.
