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
