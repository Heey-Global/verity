# Managed native Network protection profiles


## Exact native profiles and bounded prerequisite preparation

Managed installation selects a release-owned native profile before preparing host
prerequisites. A profile binds the exact kernel, architecture, OS release, Docker
version, bundled controller/Node and both BPF object hashes, reviewed gVisor binary path/hash and complete runtime-tree hash,
project runtime arguments, exact distro package versions and the digest of its
retained native acceptance evidence. Kernel identity alone cannot admit a profile.
The accepted profile list remains empty until that evidence exists.

The host must already supply the Python interpreter used to verify the native
profile. The fixed wrapper refuses a missing interpreter instead of installing
an unpinned bootstrap package; supporting such hosts requires separately tested
release-owned bootstrap delivery before they can enter the accepted set.

For an accepted profile, the fixed preparer installs only its pinned Python,
network/BPF utilities and runtime library packages, preserves existing conffiles and uses `SYSTEMD_OFFLINE=1` to prevent package systemctl calls from contacting the live manager,
registers the exact reviewed `runsc-relay` runtime beside `runsc-project`, validates
Docker configuration and reloads Docker without restarting containers. A failed
reload restores the previous configuration. Unrelated relay registrations and
bpffs unit/filesystem collisions are refused. Persistent bpffs uses a fixed mount
unit and a private root-owned pin directory recreated through tmpfiles. Controller
startup rechecks the exact profile and package versions; a changed kernel/runtime
or artifact cannot silently inherit a prior acceptance.

The host provisioning oneshot has a bounded 720-second lifetime to accommodate
package preparation. A new updater allows a longer outer wait. Older installed
updaters may still impose their previous 110-second caller deadline; that timeout
does not cancel the owned host oneshot. A failed caller is not success, and native
compatibility acceptance must measure that route and its subsequent retry before
claiming a one-update repair.

The boot harness also invokes the real managed preparer twice with preparation
only. Its `managed-staging.json` records preserved key, Docker process, active
units and firewall tables, and stable repeated preparation. It then attempts real
activation twice through the default production checks, requires unsupported-profile
rejection and verifies that no controller, managed release link, inventory contract
or installation journal was created. Fixture configuration is removed before the
separate experimental lifecycle run. This is negative activation and staging
coverage alongside experimental lifecycle evidence. It does not certify signed
managed updater admission/cutover, successful direct-authority activation,
profile-specific package installation, or protected application positive controls.
Those require the complete managed server/database/runtime fixture and independent
packet observations before a profile is published.

The systemd environment behavior is documented in
[systemd environment variables](https://github.com/systemd/systemd/blob/main/docs/ENVIRONMENT.md).
This is process-scoped and does not replace the host's global `policy-rc.d` file.
An accepted package set must additionally demonstrate that its maintainer scripts
do not execute firewall operations directly and that host connectivity remains
unchanged; environment flags and mocked commands do not establish that property.

## Candidate metadata and remaining acceptance work

The native guest records `nativeCandidate` in `managed-staging.json`. The
read-only collector captures exact host, runtime, release-artifact and package
identities, fixed blocker codes and missing acceptance evidence. The verifier
binds its artifact hashes to the staged release manifest. Candidate metadata
always says `accepted: false`; it supplies no evidence digest and does not add an
entry to the production profile list.

This is preparation for acceptance, not an isolated activation mechanism. The
native lifecycle fixture now uses the deployment-pinned PostgreSQL image on a
private internal Docker network, with a persistent volume and no published ports.
Recovery re-inspects its host-reachable address before restarting the Server.
The fixture keeps the database URL in a host-key-encrypted systemd credential,
loaded into the Server runtime credential directory; neither its JSON config nor
a fixture environment file stores the password. Docker bootstrap receives the
password through process environment rather than command arguments. See
[systemd credential encryption](https://www.freedesktop.org/software/systemd/man/latest/systemd-creds.html).
This replaces PGlite but does not establish managed direct authority. The complete
managed fixture still needs shipped activation/direct authority, application
positive controls, destination changes,
relay cutover and the fault/packet-observation matrix. Existing managed image
smokes use Docker-in-Docker, and their updater smoke substitutes a digest check
for release signature verification. Those results cannot establish the fixed
project-egress signature admission contract.

The Staging updater test requires a genuinely released predecessor and a signed
candidate with the official release-workflow identity. No local retag, verifier
substitution or placeholder evidence hash may replace that test. Production activation still requires a reviewed exact native profile and retained
acceptance evidence. Staging assessment provides the separate test route below.

## Staging assessment through the regular updater

A signed update can activate an explicitly unaccepted Staging assessment on an
existing managed installation. Stable and Staging use the same image digest;
image labels, version strings and environment variables cannot grant assessment
authority. The Updater reads its durable `update-channel.json` under the operation
lease, verifies the installed sealed deployment and target signature, and exposes
only its inspected deployment-state volume read-only to the fixed provisioner.
The wrapper independently requires the root-owned channel file to say `staging`.

After cutover, the new Updater reconciles the actual installed sealed state. This
lets an installed compatibility release (4.80+) deliver assessment support even
when its old caller could not supply the grant. Installations without the required
canonical egress mounts remain explicitly pending. No fabricated update journal,
manual target-helper invocation or signature substitution authorizes this path.

The first assessment supports native systemd on little-endian x86_64 Ubuntu 24.04
or 26.04 with rootful Docker 29.9.2 and live restore disabled. It verifies the
release-owned Node/controller/BPF artifacts and runtime pins, the complete gVisor
runtime tree, exact runtime arguments and package identities. Missing allowlisted
prerequisites are installed at exact versions selected from authenticated distro
metadata. The host must already provide the verifier's Python interpreter.
Unsupported combinations fail with bounded diagnostics.

The private descriptor has `scope: staging-assessment` and
`productionAccepted: false`. It binds the measured host, artifacts, runtime and
packages to the deployment, image digests, operation and durable Staging channel.
Controller startup revalidates these identities and channel authority. It does
not add an entry to `ACCEPTED_NATIVE_PROFILES` or fabricate acceptance evidence.
Before granting host authority, the Updater records a conservative assessment
attempt marker; both stable-channel writers refuse a transition while that marker
exists. Automated assessment deactivation and marker clearance are not yet
implemented, so returning such an installation to Stable requires a separately
reviewed deactivation path.

The intended test sequence is the normal signed release update on Staging,
followed by live readiness, allowed/blocked connection, inventory-change,
update/reboot and failure-recovery checks with independent packet observations.
Local tests and experimental boot lifecycle evidence do not prove this complete
signed Staging route. Production acceptance additionally requires reviewed retained
evidence and a release-owned exact profile exercised through production admission.
