# Isolated enrollment evidence prototype

No production route imports this directory. Run from the repository root:

- `npx vitest run scripts/enrollment-proof/model.test.ts`
- On macOS with Xcode command-line tools:
  `scripts/enrollment-proof/run-apple.sh`

The Node suite uses the actual store cipher and a test-only recovery model. It
checks the documented transcript field order, fixed Ed25519 vector, substitution
of every field, all three actions, contract-derived retention expiry, lost-response
retry, copied-state process restart, sealing, plaintext rejection, ciphertext
swapping, acknowledgement and revocation. The vector contains only a public key
and signature; its private key was discarded. IDs in this byte/signature vector
are illustrative placeholders, not full invitation-schema acceptance fixtures.
The lifetime comes from the storage contract instead of duplicating its number.

The macOS probe creates a disposable Keychain and unique temporary item, reports whether accessibility/sync attributes are exposed and checks key continuity in a separate process, then
verifies Node's exact transcript bytes and signature with CryptoKit. Cleanup
removes only that uniquely named item and its disposable test Keychain. It does not lock your login Keychain or
change device settings. The Swift code has not been compiled in this Linux session.

## Evidence boundary

Passing this model is not production conformance. It has no database, network,
real authentication registry, multi-process transaction or ticket reservation.
Its caller supplies an already authenticated device identity. It does not prove
challenge replay protection, initialize/password ownership, concurrent commits,
idempotent authenticated acknowledgement, key rotation, scheduled deletion or
hosted Uplink integration. Restart coverage copies model data, not disk durability.
No full EN/ST suite is claimed.

Apple device lock/reboot, iOS app entitlements, real sync/backup exclusion,
reinstall handling and background accessibility remain unexecuted. Attribute
inspection alone is not evidence of those behaviors. Run a signed native test app
on supported devices for those cases before freeze. The macOS helper is the first
cross-language/storage probe, not a substitute for that device evidence.

## Local result

Nine Node tests passed. Deliberately changing the expiry comparison to allow the
exact expiry instant made the boundary test fail; the correct comparison was
restored. Lint, formatting and shell syntax are checked separately. Apple evidence
remains pending. No contract freeze, production activation or runtime deployment
is performed by this prototype.

The `mobile-native-verify.yml` macOS job now runs this suite and the Swift probe
with a five-minute step deadline before the iOS build. Both workflow path filters
include this directory and the two enrollment contracts. The runner uses an
explicit disposable Keychain, without changing the login Keychain search list.
CI wiring is not a passing Apple result; device-lock/iOS/sync evidence is still
outside this macOS probe.

The file-backed macOS Keychain does not establish data-protection Keychain
accessibility. Missing accessibility or synchronization attributes print explicit
`UNVERIFIED` results; present but incorrect values fail. A green CI probe proves
only key continuity and signature/transcript compatibility, not ST01/ST02 device
protection. The iOS/data-protection Keychain tests remain a release gate.

## iOS simulator probe

Run `bash scripts/enrollment-proof/run-ios.sh` on macOS with an available iOS 17+
runtime. Native CI runs it in a separate ten-minute step. The harness creates its
own simulator and app, writes a device-only, non-synchronizing Keychain item,
terminates the app, and launches a second process to retrieve the same key.
The second phase requires the accessibility and sync attributes (missing values
fail), compares the saved public key, signs/verifies a challenge, rejects another
key and verifies deletion. A result file is removed before each phase so a stale
success cannot satisfy the next launch. Cleanup deletes the isolated simulator.

This probes the simulator's iOS Keychain API, not physical-device lock/reboot,
iCloud transport or backup extraction. Those claims still need real-device
verification. No private key leaves the Keychain except into the test process's
memory; the file used between launches contains only the public key.
