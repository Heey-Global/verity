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
`sessionId` and asynchronous `close()`. The adapter must use actual admission and
relay code on loopback with synthetic one-use tickets, not a replacement relay.
The fixture must return before waiting for both clients to attach.

The native client checks health, four concurrent POST echoes (0, 1, 8192 and
65536 bytes), Core pin rejection and ordered, idempotent cancellation. Core
independently requires successful attachment and four completed echo requests.
The runner exports only fixed results and repository revisions. Ephemeral keys,
tickets and fixture logs live in a private temporary directory removed on exit.

Build, simulator boot and native app readiness precede the admission window. Each invocation uses a
fresh pair. A successful invocation is not proof of native half-close, slow
reader, directional blackhole, heartbeat deadline or replacement behavior;
those require separate fault scenarios. Component regression results must be
reported independently from this joint test.

The hosted service source belongs in its private repository. Run cross-repository
Apple CI from a context already authorized to check out that source, with both
revisions pinned. Do not add private source or a personal token to this public
repository. Missing adapter access or Apple runtime is a verification blocker,
not a skipped test that can be counted as passing.
