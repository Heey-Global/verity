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
The ticket is passed only in the child process environment and is not logged.

These are macOS command-line probes of the native transports, not an iOS App UI
test. They do not exercise device pairing storage, foreground/background
lifecycle, or App navigation. The existing workflow separately compiles the
iOS app and runs the native iOS Simulator tunnel prototype against a local
fixture. No Staging request runs during ordinary pull-request CI.

Run the local admission checks with
`node --test scripts/remote-control-staging/probe.test.mjs`. The full Staging
probe requires macOS 14+, Xcode, and the four workflow inputs above.
