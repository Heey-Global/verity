# Native recovery acceptance

Status: prepared, not physically executed. This procedure covers A07 and
A21–A23 in [the recovery evidence matrix](BACKUP_RECOVERY_EVIDENCE.md).
Backend Docker acceptance and JavaScript mocks do not establish device acceptance.
The production gate was removed on 2026-10-29; these device cases remain open.

## Prerequisites

Use disposable server installations and test device credentials. Keep the source
snapshot and source host unchanged. Record the actual merged server revision,
app source revision, native build number, runtime version and OTA update ID;
an OTA update cannot replace a missing native transport implementation.

Provide a physical Apple device running a native build containing
`CertificatePinDelegate.swift` and `VerityPinnedTransport.swift`, a reachable
isolated restore installation, and a person or authorized Mac able to operate
the device. Record other platforms separately; an Android configuration in the
Expo manifest is not proof of an implemented or exercised pinned transport.
Do not use Expo Go as a native transport acceptance build.

Prepare three independently identifiable test devices/credentials before capture:
R (explicitly retained), U (not retained), and V (revoked after capture).
Keep another enrolled device offline during identity rotation. Use additional
physical devices or independent app containers where available; never claim
multiple independent devices from sequential use of one stored profile.

Use Settings → Server address → Scan QR code / Paste pairing code instead
to explicitly pair with fresh trusted invitation material. The settings route
opens `/onboarding/server-url?reconfigure=1`, whose QR/paste actions call
`establishPairing`; entering a manual address only verifies the existing
identity and cannot authorize a new pin. `clearServerProfile` and
`clearPairingSession` are internal functions, not a user-facing reset action.
Fresh-install cleanup intentionally clears residual iOS Keychain trust when
the app-container installation marker is absent. Do not prescribe reinstall
as an established recovery UX or call internal functions on a release device.
If no explicit supported reset route is available, record a product blocker
and agree on the user-facing behavior before adding one.

## Execution matrix

### Live app and staging preparation

1. Install **Verity Staging** from the existing TestFlight candidate. Record
   its version/build and resolve its immutable source using the release evidence
   described in [Staging releases](staging-releases.md). Record the active OTA
   update separately. Do not publish a new build merely to start this procedure.
2. Identify a disposable restore host and its source/image revision. The Staging
   app does not select a Staging server automatically: its pairing invitation
   determines the server. Keep production and shared Staging data separate.
3. Use an image released after the gate removal on the isolated installation, and
   set up backups in the app (Settings → Backup). Do not bypass paired-image
   verification or update authority.
4. Open Settings → Server address in the Staging app, scan a fresh invitation
   from the isolated installation, and run N01. Record a successful authenticated
   read and live connection before any restore. Do not paste the invitation or
   credentials into a shared evidence record.
5. Arrange R/U/V credentials and the offline-device case, then capture the
   snapshot and execute N02–N12 with the person controlling the device. Before
   each restore/rotation, reconfirm the disposable target alias and record its
   baseline. Stop if isolation or the exact installed build cannot be established.

The first handoff needs only device model/OS, installed Staging version/build,
the disposable host alias and access method, and who operates the device.
Resolve secrets through the approved access mechanism rather than the report.

For every rejection, first demonstrate a successful control on the same network
path and show that the server remains healthy afterward. Record a specific TLS,
identity, authorization or trial rejection; a timeout alone is inconclusive.

| ID | Setup and action | Required result |
| --- | --- | --- |
| N01 | Pair R to the disposable source via trusted QR/paste; make an authenticated read and open the normal live connection. | Native TLS, identity proof, enrollment and authenticated traffic succeed. |
| N02 | Restore preserved identity into trial; try an ordinary app read with R while local health and authenticated recovery controls succeed. | Ordinary access denied; the server is demonstrably available. |
| N03 | Review only R, apply V's post-capture revocation, accept the restore, then point the existing R profile at the validated restored route. | R connects without new pairing; saved identity/pin remain unchanged. |
| N04 | Attempt authenticated access with U and V, including after app restart. | Both denied; R still succeeds. Record the final revocation review boundary. |
| N05 | Restore with new identity and try the old profile and old credentials. | Old trust/credentials fail; no silent replacement of saved identity or pin. |
| N06 | Use the supported explicit reset/re-pairing route and obtain fresh invitation material from the trusted installer/admin. | Fresh identity proof and pairing succeed; the old credential remains invalid. Missing reset UX is a blocker, not a pass. |
| N07 | Rotate the live disposable installation identity; retry with an online old device and reconnect the device kept offline during rotation. | Both old trust bindings fail; explicit fresh pairing succeeds. External old hosts/copies are not claimed to be remotely invalidated. |
| N08 | Against a controlled TLS fixture, use the wrong leaf P-256 point pin. | Native pin rejection before any enrollment secret reaches the fixture. |
| N09 | Keep the correct pin but request a hostname absent from the certificate SAN. | Native chain/hostname rejection before enrollment. |
| N10 | Keep the correct pin and serve an invalid chain, then a leaf without the required separate anchor. | Each fails native verification; a valid chain control succeeds. |
| N11 | Keep valid pinned TLS but return a different identity key/server ID or an invalid signature over the fresh challenge. | Pairing fails before code redemption/enrollment and does not replace stored trust. |
| N12 | Repeat retained-device success and old-trust rejection after force quit/relaunch, background/foreground and network disconnect/reconnect. | HTTP and live connection preserve the same decisions; pooled connections do not conceal changed trust. |

For N08–N11 use only disposable secrets and a controlled fixture that counts
redemption/enrollment requests without logging their bodies or headers. A
physical run must exercise the production native bridge, not a mocked JS fetch.
Do not route a real credential to an adversarial fixture. Require zero secret
requests for each negative case and a successful positive control proving the
counter works. Restart native sessions between certificate variants to avoid
mistaking a reused connection for a new trust decision.

The existing `scripts/ios-pinned-tls-smoke.sh` exercises the actual Apple
delegate on macOS/iOS Simulator using generated app ATS settings and a routable
address. It is supplementary coverage, not a physical-device runner. Follow its
header prerequisites on a Mac; do not expose its temporary server publicly.

## Redacted evidence record

Copy this record for each physical case. Keep all fields explicit; use
`not-run`, `blocked`, `pass` or `fail`, never infer pass from an absent error.

```text
case: N__
result: not-run
utc_started:
utc_finished:
server_source_sha:
app_source_sha:
native_build_id:
runtime_version:
ota_update_id_or_embedded:
device_alias_model_os:
network_path_direct_or_relay:
restore_mode_and_disposable_host_alias:
reviewed_device_aliases:
precondition_and_positive_control:
actions_performed:
expected_decision:
observed_decision_and_bounded_error_code:
postcondition_health_and_authorized_control:
enrollment_request_count_if_applicable:
redacted_evidence_reference:
remaining_blocker:
```

Do not store bearer tokens, pairing codes/links, recovery keys, passwords,
private keys, raw request logs or private addresses in repository evidence.
Use aliases and bounded native phase/error codes. Device evidence must identify
the exact native build and source; rerun affected cases after a native fix.

## Current execution boundary

This procedure does not itself record a physical-device execution. No case
above is marked physically passed. Any implementation fixes require
scoped tests and deliberate guard mutation, followed by physical retesting.
Global release, backup management UI, update backup coordination and same-host
snapshot rollback remain separate acceptance work.
