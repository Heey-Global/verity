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
uses the same Swift tunnel implementation as the Expo smoke module to make one
HTTPS GET. A response status proves inner TLS reached the pinned Core endpoint.
The ticket is passed only in the child process environment and is not logged.

This is a macOS command-line probe of the native transport, not an iOS App UI
test. It does not exercise device pairing storage, foreground/background
lifecycle, or App navigation. The existing workflow separately compiles the
iOS app and runs the native iOS Simulator tunnel prototype against a local
fixture. No Staging request runs during ordinary pull-request CI.

Run the local admission checks with
`node --test scripts/remote-control-staging/probe.test.mjs`. The full Staging
probe requires macOS 14+, Xcode, and the four workflow inputs above.
