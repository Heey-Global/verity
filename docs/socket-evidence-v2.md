# Socket evidence exports

Connection recording version 2 retains selected Uplink socket snapshots with explicit
socket lifetime, process boot, session and observer generation identifiers. It is a
bounded diagnostic, not a transport fix or proof of Gateway forwarding.

The control connection advertises `remote-diagnostics-v2` alongside version 1.
`diagnostics.start` opts in with `diagnosticsVersion: 2`; omission selects version 1.
The version remains fixed for the run. Status, stop and export requests keep their
existing fields. A missing capability or a mismatched response fails explicitly.
The paired Core HTTP start endpoint follows the same default. Saved version 2
runs retain their expected version for collection. New App captures use the
[selected-session version 3 contract](socket-evidence-v3.md). Old apps can continue
to request version 1.

Uplink samples selected sockets at a target interval of 100 milliseconds. Actual
interval and lag are observations; scheduling does not promise a precise cadence.
The 2,000-record and 256-KiB full-document limits can end a run well before its
120-second maximum duration. Binding/final records have reserved capacity. Dropped
records, omitted bindings, snapshot errors and truncated stream totals remain
explicit. A null snapshot denotes a diagnostic read failure; null transport fields
mean unavailable observations. A post-authentication baseline does not cover the
first TCP byte, and a late baseline must not be treated as complete coverage.

After finalization, the ordered records and all evidence metadata are immutable.
The SHA-256 input is UTF-8 JSON with object keys sorted recursively using JavaScript
`sort`, unchanged array order, finite numbers, and no whitespace. The input contains
all evidence metadata and the complete records array, excluding `exportHash` and
control/page fields (`type`, `requestId`, `cursor`, `nextCursor`). Core verifies
consistent metadata across pages, sequence/ownership/count, the full-document
limit including `exportHash`, and the digest before returning the export. The app
uses the same strict schema and independently verifies the digest. Unknown version
2 fields are rejected rather than projected away. Version 1 retains its existing
metadata projection rules.

The digest detects changed export content; it is not a signature or proof that
bytes reached a peer. Data totals count decoded stream payload. Emitted-message
bytes count encoded WebSocket messages. Send completion is a local callback,
not TCP acknowledgment or remote application receipt. Socket IDs identify Uplink
sockets and do not by themselves identify a Core or Gateway TCP leg.

The synthetic cross-repository fixture is
`packages/events/src/fixtures/socket-evidence-v2.json`. It fixes the canonical hash
contract for Core and app tests without recording private deployment data.
