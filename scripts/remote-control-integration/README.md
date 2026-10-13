# Native App → Uplink → Core integration

This runner compiles the production `RemoteAppTunnel` and connects it through
the real Uplink test adapter to the production `createRemoteConnectorPool`.
Only tickets and certificates generated for the local fixture are used. Certificate
extensions come from explicit local OpenSSL configuration so host defaults cannot
add duplicate extensions that Apple trust evaluation rejects.

Prerequisites: Node matching the repository engines, installed dependencies in
both checkouts, macOS with Xcode, and an iOS simulator for the iOS variant.

```sh
npx tsc -b packages/server
# In the separately authorized Uplink checkout: npm run build
bash scripts/remote-control-integration/run-apple.sh macos /absolute/path/to/uplink
bash scripts/remote-control-integration/run-apple.sh ios /absolute/path/to/uplink
```

The Uplink build must export `createRemoteIntegrationFixture` from
`packages/uplink/dist/testing/remote-integration-fixture.js`. It accepts
`{tls: {key, cert}, lifetimeMs}` and returns `dataURL`, `appTicket`, `coreTicket`,
`sessionId`, `suppressDataFrom(party, enabled)` and asynchronous `close()`. The adapter must use actual admission and
relay code on loopback with synthetic one-use tickets, not a replacement relay.
The fixture must return before waiting for both clients to attach.

The native client checks health, four concurrent POST echoes (0, 1, 8192 and
65536 bytes), Core pin rejection and ordered, idempotent cancellation. Core
independently requires successful attachment and four completed echo requests.
The runner exports only fixed results and repository revisions. Ephemeral keys,
tickets and fixture logs live in a private temporary directory removed on exit.

By default the runner executes a loss scenario followed by recovery in a new
native process and fixture with fresh tickets. The loss scenario first completes
the baseline checks, then submits an exact POST request over pinned TLS. Core
arms installation-to-app DATA suppression before replying. Core requires a
successful production connector DATA send callback and a subsequent WebSocket
pong; the native client requires a request timeout while the tunnel remains
active and its pong counter increases. The HTTP response's local completion is
recorded separately from connector completion and endpoint receipt. Recovery
requires fresh health and exact parallel echo receipts after the old fixture has
been closed. The withheld response differs from every expected recovery payload.
Pass `baseline`, `loss`, or `recovery` as the third argument to isolate a scenario.

Suppression happens after WebSocket decoding and before the production Uplink
DATA listener. This is a synthetic endpoint discrimination test, not a simulation
of TCP loss or proof of a historical Gateway failure. The native timeout belongs
to the HTTP test request, not a newly implemented production stall detector.
Reverse traffic during suppression is covered separately by Uplink's component
test; this native scenario proves the request reached Core before suppression.

Build, simulator boot and native app readiness precede the admission window. Each invocation uses a
fresh pair. A successful invocation is not proof of native half-close, slow
reader, heartbeat deadline or live connection replacement behavior;
those require separate fault scenarios. Component regression results must be
reported independently from this joint test.

The hosted service source belongs in its private repository. Run cross-repository
Apple CI from a context already authorized to check out that source, with both
revisions pinned. Do not add private source or a personal token to this public
repository. Missing adapter access or Apple runtime is a verification blocker,
not a skipped test that can be counted as passing.
