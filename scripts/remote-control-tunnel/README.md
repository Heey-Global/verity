# Native Remote Control tunnel prototype

Test-only experiment for Remote Control generally: already-paired personal
devices first, with restricted team enrollment later using the same transport.
Nothing here is linked into the application or implements production admission,
member rights, subscriptions, invitation proofs or device enrollment.

## Path under test

```text
URLSession + existing Core certificate pin/hostname delegate
  -> loopback SOCKS5 listener (native Swift)
  -> outer WSS with its own certificate pin
  -> mock opaque byte relay
  -> fixed loopback Core TLS listener (HTTPS and WSS echo)
```

`core.test:443` is the logical Core address, preserved through the SOCKS tunnel.
The test relay's physical address never becomes the Core identity. The proxy
also accepts `wrong.test:443` solely for the negative hostname test; all other
CONNECT targets are rejected. The relay has a fixed backend, not arbitrary
routing. Test certificates/keys are generated temporarily and removed on exit.

This uses the native session's SOCKS proxy configuration rather than disabling
TLS verification or implementing cryptography. The candidate API requires iOS
17/macOS 14. Apple compilation and actual proxy behavior must be confirmed on
Apple CI; Linux results cannot establish native feasibility. These are SDK
requirements for the experiment, not a new production minimum OS decision.

## Run

Linux fixture checks (existing workspace dependencies required):

```sh
node --test scripts/remote-control-tunnel/mock.test.mjs
```

Apple native checks:

```sh
bash scripts/remote-control-tunnel/run-apple.sh macos
bash scripts/remote-control-tunnel/run-apple.sh ios
```

The iOS run requires Xcode/iOS 17+ simulator and a generated app Info.plist after
Expo prebuild, or `VERITY_SMOKE_APP_PLIST` pointing to it. Its ATS configuration
is copied into the fixture app. The native-verification workflow runs both
variants after prebuild. Test-only changes explicitly trigger that workflow's
change gate even though they do not change the shipping app fingerprint.

The Swift smoke tests HTTP GET, a 32 KiB echo upload/download, WSS echo, wrong
inner and outer pins, wrong Core hostname, shutdown with a pending receive and
a fresh tunnel afterwards. A watchdog fails a hung smoke. The Linux fixture
suite additionally checks untrusted CA, oversized frames, bounded captured bytes
and absence of its synthetic plaintext in that capture. The wrong-pin assertion
was checked against a deliberately disabled verifier and failed as expected.

## Limits

The fixture carries raw TLS bytes in binary WebSocket messages, not the proposed
Uplink JSON/base64 `remote` framing. It has no real hosted gateway, outbound Core
connector admission, ticket exchange or team bootstrap. Loopback outer WSS is
not a test of public gateway routing or routable-address ATS behavior. The two
TLS legs use the same generated fixture certificate for convenience; production
trust and keys must be independent.

A passing native test demonstrates this candidate adapter, not complete Remote
Control. Sustained transfer/load, detailed EOF/half-close behavior, network-path
changes and production request/device lifecycle still require follow-up. The
32 KiB transfer checks record chunking; it is not a load test. After cancellation,
reconnection creates a fresh tunnel; TLS session resumption is not promised.
