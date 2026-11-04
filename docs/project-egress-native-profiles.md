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
This replaces PGlite but does not establish managed direct authority. The complete
managed fixture still needs shipped activation/direct authority, application
positive controls, destination changes,
relay cutover and the fault/packet-observation matrix. Existing managed image
smokes use Docker-in-Docker, and their updater smoke substitutes a digest check
for release signature verification. Those results cannot establish the fixed
project-egress signature admission contract.

The Staging updater test requires a genuinely released predecessor and a signed
candidate with the official release-workflow identity. No local retag, verifier
substitution or placeholder evidence hash may replace that test. The current
empty accepted list also means a preacceptance native activation procedure needs
to be defined and reviewed before this full test can run; the collector does not
introduce a production bypass. Until the fixture, procedure and retained native
evidence exist, automatic production activation remains incomplete.

## Proposed candidate assessment boundary

Positive preacceptance testing requires a separate reviewed test composition;
root privileges and a disposable cloud instance marker alone do not authorize
relaxing production admission. Candidate metadata must never be inserted into
`ACCEPTED_NATIVE_PROFILES` as if it represented completed acceptance.

The proposed assessment artifact belongs only to the native probe directory and
must be excluded from release assembly and managed updater delivery. It would
reuse production platform, artifact, package and runtime validators, with explicit
test entry points for provisioning and fixture startup. Production selection must
continue to use only release-owned profiles, with no host-file or environment
override. Any differences from shipped entry points must be retained with source
and composition hashes in the evidence.

Assessment output must use a distinct `native-candidate-assessment` scope,
`accepted: false` and `productionActivationVerified: false`. It must retain real
PostgreSQL/application controls, independent packet observations and lifecycle
fault results. It cannot supply a placeholder production acceptance digest.
Release-exclusion, exact-identity and isolation guards must have negative
controls; unchanged normal provision and `verify-runtime` must still reject the
same host while the production profile list is empty. Candidate evidence must
not satisfy the production evidence verifier.

Only after review of the retained assessment evidence may a release-owned exact
profile reference its real digest. Official release delivery must then be tested
on a fresh representative host with unchanged production entry points and an
authentic signed predecessor-to-target update. That second phase must cover
first install, old-caller timeout/retry, repeated update, reboot, faults and
packet controls, without assessment wrappers. This proposal does not implement
or grant candidate activation; its executable boundary needs review before
implementation, and shipping activation remains unverified until phase two.
