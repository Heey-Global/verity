# Remote Control Staging probe

The `verity-mobile-native-verify` workflow can run an opt-in macOS probe against
the already connected Staging Uplink and managed Core Gateway. Dispatch it after
the Staging `/remote-control` and `/data` routes are enabled, with:

- `uplink_origin`: the public HTTPS Uplink origin (for example
  `https://uplink.verity.build/`)
- `installation_handle`: the existing installation's routing handle from Uplink
  `welcome` or a read-only Uplink installation lookup
- `core_url`: the paired logical HTTPS Core URL
- `core_pin`: the paired Core SPKI pin (`sha256-...`)

The workflow does not take a subscription key. The existing Core Control
connection must already have `remote-control-v1` negotiated and the
`remote-control` feature. The probe opens App admission, waits for a matching
short-lived ticket, keeps admission open through the request, and
uses the Swift smoke tunnel and the production app tunnel to make separate
HTTPS GET requests. Both must receive HTTP 200 through pinned inner TLS.
A third app-mode run sets `VERITY_REMOTE_PROBE_IDLE_SECONDS=40` and pauses
before its last request, longer than the 15-second data heartbeat: an app
attachment that ends while idle fails that run with the tunnel's stop reason.
The ticket is passed only in the child process environment and is not logged.

These are macOS command-line probes of the native transports, not an iOS App UI
test. They do not exercise device pairing storage, foreground/background
lifecycle, or App navigation. The existing workflow separately compiles the
iOS app and runs the native iOS Simulator tunnel prototype against a local
fixture. No Staging request runs during ordinary pull-request CI.

Run the local admission checks with
`node --test scripts/remote-control-staging/probe.test.mjs`. The full Staging
probe requires macOS 14+, Xcode, and the four workflow inputs above.

## Diagnosing a device connection

The displayed paired Core URL remains the TLS identity for both direct and
Uplink routes. Its presence does not establish which route was attempted.

- `Remote Control descriptor refreshed` records whether Core advertised Remote
  Control and whether the app retained a saved route. A refresh failure retains
  the previous descriptor; it does not prove a subscription rejection.
- `Remote Control direct probe` records reachability and elapsed milliseconds.
- `Remote Control admission failed` records the admission request ID, whether
  the socket opened, elapsed time, and a validated refusal code or local error.
- `Remote Control admission ready` links the request ID to the remote session
  ID. Use that session ID to correlate Core connector logs; it is distinct from
  the chat session ID. Tickets and authorization headers must not be logged.
- The visible transport error distinguishes routing prerequisites, admission,
  data attachment, and the pinned Core health probe. `no remote descriptor
saved` means the app has no saved Uplink route, not that an entitlement was
  definitively rejected.

A successful admission or data attachment alone does not prove that Core TLS,
HTTP authentication, or the chat stream works. Capture the failed stage and
its time before attributing a failure to App, Core, or hosted Uplink. These
repository diagnostics do not provide access to hosted Uplink Kubernetes logs.

### Reading the transport diagnostics

The iPhone timeout includes the phase of that individual native request when
cancellation begins: `NO_AUTH_CHALLENGE`, `AUTH_CHALLENGE_RECEIVED`, or
`PIN_AND_CHAIN_TRUST_ACCEPTED`. The last value confirms certificate validation,
not a completed HTTP request. Older native builds still show the plain timeout.
A native build containing the diagnostics is required; an OTA bundle alone
cannot add these counters or phases.

The visible tunnel summary is cumulative for the attachment, not specific to
one health probe. `received` counts data, end, and reset frames. `sentBytes`
counts payload bytes successfully submitted to the outer WebSocket;
`receivedBytes` counts validated incoming payload bytes; `deliveredBytes`
counts bytes accepted by the local socket write callback. None proves that the
receiving application processed them. `localResets` and `remoteResets` count
terminations from each side. `lastReset` retains the latest direction and fixed
code even after another stream opens.

A stream that has sent its first local bytes and received nothing within
10 seconds ends the attachment with the stop reason `stall: …` (Core's TLS
reply to a ClientHello otherwise arrives within milliseconds). The app then
attaches again at once and retries its reads on the fresh attachment, at most
once per minute; a further stall within that minute backs off as before. A
probe that times out waits up to three more seconds for that native stop
before it is classified, so a probe failure surfaces after about 15 s.

`age=` is the attachment's age in milliseconds, `pings=` counts the app's
heartbeat pings sent and pongs received, and `pongAge=` is the time since the
last pong. A pong that still arrives while stream frames do not says the relay
is not forwarding towards the app; a pong that stops too says the socket's
inbound half is dead.

`streams=` lists up to three recent streams as fixed tokens, for example
`s1=k3F0A9C1E.up1806.dn6801.fo3.fi4.t210.d520.local.psocks.o22.i22-23-23.h2`: the
first characters of the stream ID (the same ID Core reports under "Core
streams" in the app's connection diagnostics, so both ends of one stream can
be read side by side), bytes sent and received, `stream.data` frames sent
(`fo`) and received (`fi`, compare with Core's "frames" on the same stream to
see at which frame a reply stopped arriving), milliseconds until Core's first
bytes (`tnone` if none arrived) and
until the stream ended, which side ended it (`local` is the app's own TLS
client closing, `remote` is Core), the proxy dialect the app used (`socks` or
`connect`), the TLS record types seen in each direction (22 handshake, 20
change-cipher-spec, 21 alert, 23 application data), and Core's first handshake
message (`2` ServerHello, `hrr` HelloRetryRequest). A stream that received a
full handshake flight and was then ended by `local` without any `23` record
sent is a handshake the device's TLS client abandoned. No payload bytes are
recorded.

The app dials the loopback tunnel as a SOCKS5 proxy first. When that Core
probe fails on a device it retries once as an HTTP CONNECT proxy and keeps the
dialect that answered; `via connect` in the probe failure names the second
attempt.

Native `Verity remote stream` events include the remote session and stream IDs,
first data in either direction, first local delivery, and final byte counts.
Core's `remote connector first bytes` and `remote connector stream ended` use
the same session/stream IDs. Core distinguishes `receivedFromAppBytes`,
`writtenToLocalBytes`, `receivedFromLocalBytes`, and `sentToUplinkBytes` so a
blocked local write differs from a silent upstream. Counters describe local
transport acceptance; a final snapshot can exclude writes still pending when
the stream was retired. Events are bounded per stream, rather than per chunk.

Managed Gateway stdout emits `gateway.tls` (`secure`, `failed`, `closed`) and
`gateway.health_probe` (`received`, `completed`, `closed`). The random
`connection` ID joins these Gateway events. Only the first four GET health
probes per TLS connection are logged. `completed` means the HTTP response was
flushed locally; it does not prove receipt on the iPhone. Gateway socket byte
counters are Node TLSSocket counters, not relay payload totals. The connector's
`localPort` and Gateway's `peerPort`, together with time, can help join the local
TCP leg, but NAT and port reuse make this best-effort rather than a global ID.
No URLs, headers, tickets, certificate contents, or payloads enter these new
events. Gateway TLS events also cover direct connections; they alone do not
identify an Uplink route.

These changes instrument both endpoints of the hosted relay. The hosted Uplink
service is a separate repository; its internal relay logs are not modified here.
To isolate a failure, match native/Core stream IDs, compare directional progress,
then check Gateway TLS and health events. Keep the above correlation limits in
mind before assigning a failure to any hop.

### Native failures before the authentication callback

`NO_AUTH_CHALLENGE` means the request's pin delegate has not received an
authentication challenge; it does not identify a pin mismatch. The app now
preserves up to three NSError levels using known domain names and numeric codes,
including numeric CFStream error domain/code fields when supplied by iOS. For
example, `:underlying:NSOSStatusErrorDomain:-9802` identifies a lower-level cause;
it is evidence to investigate, not proof of a particular certificate defect.
Unknown domains are replaced by `OtherErrorDomain`. URLs, descriptions, headers,
and arbitrary userInfo values are never included in this diagnostic.

The local Apple tunnel smoke now also exercises the production `RemoteAppTunnel`
with URLSession HTTPS through SOCKS, using a private CA and the production pin
delegate. Its outer fixture connection is pinned explicitly without installing
trust roots; the shipping tunnel still uses system trust for Uplink. Run
`bash scripts/remote-control-tunnel/run-apple.sh macos` and
`bash scripts/remote-control-tunnel/run-apple.sh ios` on macOS with Xcode (and the
generated app Info.plist, as described in the tunnel README). A passing simulator test does not replace the final
physical-device test: test Remote Control and settings loading without VPN with
the updated native app, then correlate the stream logs with Core/Gateway logs.

### Bounded TCP collection on the Core Docker host

Run `sample-core-tcp.py` only on an explicitly authorized Linux Docker host,
using an account already allowed to inspect Docker and enter the container's
network namespace. It does not elevate privileges or install tools. Host
prerequisites are Python 3, Docker CLI, `nsenter`, and `ss` (iproute2). Missing
tools fail before collection; command failure or denied namespace access emits
an explicit failure record. Run from a trusted copy of this script:

```sh
python3 scripts/remote-control-staging/sample-core-tcp.py \
  --container verity-core --output core-tcp.jsonl --seconds 120
```

Replace `verity-core` with the actual Core container name. Start the sampler
before the device test and verify a timestamped `sample` record exists first.
It samples established outbound TCP port 443 sockets in that exact container
network namespace at most once per second for up to 120 seconds. Each command
has a two-second timeout; startup and the final in-progress iteration can add
bounded overhead. A changed container identity, start time, or PID incarnation
aborts collection. A restart while a command is running is also checked after
that command; discard the failed run. No shell, packet capture, payload,
environment, Docker configuration dump, process command line, or credentials
are collected. Output is a new file created with mode 0600 and is never
overwritten. Keep it private: endpoint addresses are transport metadata.

The timestamped `ss -tinH` samples retain local/remote tuples, send/receive
queues and available TCP fields such as `bytes_sent`, `bytes_acked`,
`bytes_received`, retransmits, unacked, notsent, RTT, congestion window and
receive space. Field availability depends on kernel/iproute2 version; an absent
field is unknown, not zero. All matching HTTPS sockets are included: identify
Uplink's connection using the connector's safe tuple and time, rather than
assuming the first socket is the relay. Empty output means no matching
established socket at that sample, not a working connection. Compare UTC times
and record the host/device clock offset before correlating logs.

TCP acknowledgement on this leg proves acceptance by the TCP peer (normally
the TLS-terminating Gateway), not delivery to the Uplink process or iPhone.
Node/WebSocket send callbacks and socket byte counters likewise do not prove
peer receipt. Pair these samples with Uplink raw ingress and per-stream counters
and Gateway downstream/upstream connection metadata; the Gateway's two TCP legs
must be measured separately. This script cannot reconstruct historical TCP
state or establish application delivery from ACKs alone.

Run its host-independent guards with
`python3 scripts/remote-control-staging/sample-core-tcp.test.py`.

### Core transport snapshots

Core emits `remote.transport` through its configured logger every five seconds
from data-socket open, and at attach and release. Join by full `sessionId` and
stream ID; snapshots carry UTC `at` plus epoch-millisecond progress timestamps.
`rawMessages/rawBytes/lastRawAt` count complete WebSocket messages before parsing,
including attach/control frames, rather than stream payloads.

`enqueuedFrames/enqueuedBytes`, `completedFrames/completedBytes`, `errorFrames`,
`pendingFrames/pendingBytes` and `oldestPendingMs` separate write submission from
callback acceptance. Byte totals are serialized WebSocket message bytes, not
payload or TCP wire bytes. `callbackStalled` flags pending callbacks older than
10 seconds without changing transport behavior. The last 16 frame records retain
safe direction/type/stream/sequence and, for outbound frames still in the trace,
write IDs, callback time, latency, outcome and encoded size. This is a rolling
window, not an exhaustive per-frame history.

The `socket` projection contains Node socket byte totals, write queue state and
endpoint tuples for joining a simultaneous host TCP sample. A missing socket is
`null` (unknown). Socket bytes advancing while complete-message counters remain
fixed can expose reception below the WebSocket message handler. Neither socket
bytes nor successful write callbacks prove remote receipt or TCP acknowledgement.
TLS and protocol framing also make socket totals incomparable to payload totals.
The snapshot includes all live streams' local socket queues and progress; session
totals continue to account for callbacks after a stream is retired.

Sampling stops on release. Storage is bounded to 16 trace entries and 16,384
pending writes; exceeding the latter ends the session rather than growing without
bound. Logs omit payloads, tickets, URLs, headers and peer close-reason text.
Endpoint tuples are host/network metadata and belong in private diagnostic logs.
Kernel ACK/retransmit evidence requires the host sampler and matching
cluster-side collection; instrumentation must be deployed on both sides before
requesting the next synchronized device reproduction.
